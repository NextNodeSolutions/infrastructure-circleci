import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import * as cloudflare from '@pulumi/cloudflare'

import { CircleApproval } from './src/adapters/circleci/approval.ts'
import { env } from './src/adapters/cli.ts'
import { GitHubApi } from './src/adapters/github/api.ts'
import { decode } from './src/adapters/github/transport.ts'
import { REQUEST_TIMEOUT_MS } from './src/adapters/http.ts'
import { stackHasResource } from './src/adapters/pulumi/checkpoint.ts'
import { selectStack } from './src/adapters/pulumi/stack.ts'
import { r2StateBackend } from './src/adapters/pulumi/state-backend.ts'
import { zoneForDomain } from './src/adapters/pulumi/zone-for-domain.ts'
import { readUpload } from './src/adapters/wrangler/output.ts'
import {
	GITHUB_HEALTH,
	GITHUB_SERVICE,
	GITHUB_WEBHOOK,
} from './src/domain/approval/service.ts'
import { recordDeployment } from './src/domain/deployment/upload.ts'
import { PlatformError } from './src/domain/platform-error.ts'
import { WorkerSecrets } from './src/domain/vault/platform-secrets.ts'
import { MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from './src/lib/time.ts'

import type * as automation from '@pulumi/pulumi/automation/index.js'

const HEALTH_DEADLINE_MINUTES = 10
const HEALTH_DEADLINE_MS =
	HEALTH_DEADLINE_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND
const HEALTH_RETRY_MS = 3_000
const WRANGLER_OUTPUT = 'wrangler.ndjson'
const DOMAIN_RESOURCE = 'domain'
class ServiceDeploymentError extends PlatformError {}

// Wrangler creates the Worker on its first deployment and uploads every later version,
// as it does for an application Worker. Pulumi attaches the domain to a Worker that exists.
async function resources(accountId: string): Promise<Record<string, unknown>> {
	const zone = zoneForDomain(accountId, GITHUB_SERVICE.hostname)
	new cloudflare.WorkersCustomDomain(
		DOMAIN_RESOURCE,
		{
			accountId,
			zoneId: zone.id,
			hostname: GITHUB_SERVICE.hostname,
			service: GITHUB_SERVICE.worker.name,
		},
		{ deleteBeforeReplace: true },
	)
	return { hostname: GITHUB_SERVICE.hostname }
}

function wrangler(arguments_: string[], directory: string): void {
	const command = spawnSync(
		join(import.meta.dirname, 'node_modules/.bin/wrangler'),
		arguments_,
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				CI: process.env.CI,
				CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
				CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
				WRANGLER_SEND_METRICS: 'false',
				WRANGLER_OUTPUT_FILE_PATH: join(directory, WRANGLER_OUTPUT),
			},
			stdio: 'inherit',
		},
	)
	if (command.error || command.status !== 0)
		throw new ServiceDeploymentError(
			'The GitHub approval service upload failed; inspect the Wrangler output above',
		)
}

async function isHealthy(secrets: WorkerSecrets, base: URL): Promise<boolean> {
	try {
		const response = await fetch(new URL(GITHUB_HEALTH.pathname, base), {
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (!response.ok) return false
		const body = '{}'
		const signature = createHmac('sha256', secrets.GITHUB_WEBHOOK_SECRET)
			.update(body)
			.digest('hex')
		const ping = await fetch(new URL(GITHUB_WEBHOOK.pathname, base), {
			method: 'POST',
			body,
			headers: {
				'x-github-event': 'ping',
				'x-hub-signature-256': `sha256=${signature}`,
			},
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		return ping.ok
	} catch {
		return false
	}
}

async function awaitHealth(secrets: WorkerSecrets, base: URL): Promise<void> {
	const deadline = Date.now() + HEALTH_DEADLINE_MS
	while (Date.now() < deadline) {
		if (await isHealthy(secrets, base)) return
		await delay(
			Math.min(HEALTH_RETRY_MS, Math.max(0, deadline - Date.now())),
		)
	}
	throw new ServiceDeploymentError(
		'The GitHub approval service did not pass its signing and signed-webhook health checks',
	)
}

type UploadFiles = { config: string; bindings: string }

function writeUploadFiles(
	directory: string,
	secrets: WorkerSecrets,
): UploadFiles {
	const config = join(directory, 'wrangler.json')
	const bindings = join(directory, 'worker-secrets.json')
	writeFileSync(
		config,
		JSON.stringify({
			...GITHUB_SERVICE.worker,
			main: join(import.meta.dirname, 'github-worker.ts'),
			keep_vars: true,
			workers_dev: false,
			preview_urls: true,
		}),
		{ mode: 0o600 },
	)
	writeFileSync(bindings, JSON.stringify(secrets), { mode: 0o600 })
	writeFileSync(join(directory, WRANGLER_OUTPUT), '', { mode: 0o600 })
	return { config, bindings }
}

async function publishVersion(
	directory: string,
	secrets: WorkerSecrets,
	mode: 'create' | 'update',
): Promise<void> {
	const { config, bindings } = writeUploadFiles(directory, secrets)
	if (mode === 'create') {
		wrangler(
			['deploy', '--config', config, '--secrets-file', bindings],
			directory,
		)
		return
	}
	wrangler(
		['versions', 'upload', '--config', config, '--secrets-file', bindings],
		directory,
	)
	const uploaded = recordDeployment(
		readUpload(join(directory, WRANGLER_OUTPUT)),
		GITHUB_SERVICE.hostname,
	)
	if (!uploaded.version)
		throw new ServiceDeploymentError(
			'The approval service must upload an undeployed version before promotion',
		)
	await awaitHealth(secrets, new URL(uploaded.url))
	wrangler(
		[
			'versions',
			'deploy',
			'--version-id',
			uploaded.version,
			'--percentage',
			'100',
			'--yes',
			'--config',
			config,
		],
		directory,
	)
}

// The shared service is published from this repository's main, or from the canary's.
function assertServiceRun(): void {
	const isCanary =
		Boolean(process.env.NEXTNODE_CANARY_PROJECT_ID) &&
		process.env.CIRCLE_PROJECT_ID === process.env.NEXTNODE_CANARY_PROJECT_ID
	if (
		process.env.CIRCLECI !== 'true' ||
		process.env.CIRCLE_BRANCH !== 'main' ||
		process.env.NEXTNODE_PROGRAM_REF !== 'main' ||
		(!isCanary && process.env.CIRCLE_PROJECT_REPONAME !== 'infrastructure')
	) {
		throw new ServiceDeploymentError(
			"The shared approval service requires CI, the main platform package, and infrastructure or the canary's main",
		)
	}
}

// The service's own stack, in the platform's project, on the state bucket every stack shares.
async function serviceStack(workDir: string): Promise<automation.Stack> {
	const token = env('CLOUDFLARE_API_TOKEN')
	const accountId = env('CLOUDFLARE_ACCOUNT_ID')
	const backend = await r2StateBackend({
		token,
		accountId,
		bucket: env('NEXTNODE_STATE_BUCKET'),
	})
	return selectStack({
		project: `platform.${GITHUB_SERVICE.worker.name}`,
		stackName: 'production',
		program: resources,
		accountId,
		token,
		passphrase: env('PULUMI_CONFIG_PASSPHRASE'),
		backend,
		workDir,
	})
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { work: { type: 'string' }, bindings: { type: 'string' } },
	})
	if (!values.work || !values.bindings)
		throw new ServiceDeploymentError(
			'usage: github-service.ts --work <empty platform directory> --bindings <private JSON file>',
		)
	assertServiceRun()
	const directory = resolve(values.work)
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const stack = await serviceStack(join(directory, 'pulumi'))
	const onOutput = (output: string): void => {
		process.stderr.write(output)
	}
	const secrets = decode(
		WorkerSecrets,
		JSON.parse(readFileSync(resolve(values.bindings), 'utf8')),
	)
	await GitHubApi.verifyAccess(secrets)
	await new CircleApproval(secrets.CIRCLECI_TOKEN).verifyAccess()
	// A domain deleted with its Worker leaves the state here, so the run deploys afresh.
	await stack.refresh({ onOutput })
	const hasDomain = await stackHasResource(stack, DOMAIN_RESOURCE)
	await publishVersion(directory, secrets, hasDomain ? 'update' : 'create')
	await stack.up({ onOutput })
	await awaitHealth(secrets, new URL(GITHUB_HEALTH.origin))
	await GitHubApi.configureWebhook(
		secrets,
		GITHUB_WEBHOOK,
		secrets.GITHUB_WEBHOOK_SECRET,
	)
	console.log(`GitHub approval service: ${GITHUB_HEALTH.href}`)
}

await main().catch((error: unknown) => {
	console.error(
		PlatformError.describe(
			error,
			'GitHub approval service deployment failed. Inspect the preceding CI operation.',
		),
	)
	process.exitCode = 1
})
