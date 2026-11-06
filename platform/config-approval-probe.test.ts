import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as v from 'valibot'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'
import { githubProbeApi } from './github-probe-api.ts'
import worker from './github-worker.ts'
import { ApprovalDenied } from './src/authorize-approval.ts'
import {
	describe,
	NextnodeToml,
} from './src/domain/configuration/nextnode-toml.ts'
import {
	GITHUB_SERVICE,
	GITHUB_WEBHOOK,
} from './src/domain/service/approval-service.ts'
import { GitHubApi } from './src/github-api.ts'
import { GitHubApproval } from './src/github-approval.ts'

const WEBHOOK_KEY = probe.webhookKey
const SOURCE_MARKER = 'probe-only-private-source-marker'

for (const kind of ['symlink', 'malformed'] as const) {
	test(`the configuration reader refuses ${kind} input without printing its contents or environment`, context => {
		const checkout = mkdtempSync(join(tmpdir(), 'nextnode-reader-probe-'))
		context.after(() => rmSync(checkout, { recursive: true, force: true }))
		const target = join(checkout, 'source')
		writeFileSync(target, `${SOURCE_MARKER}=\u0000invalid`)
		if (kind === 'symlink')
			symlinkSync(target, join(checkout, 'nextnode.toml'))
		else
			writeFileSync(
				join(checkout, 'nextnode.toml'),
				`${SOURCE_MARKER}=\u0000invalid`,
			)
		const result = spawnSync(
			process.execPath,
			[
				join(import.meta.dirname, 'read.ts'),
				'--repository',
				'canary',
				'--check',
			],
			{
				cwd: checkout,
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH,
					CIRCLE_OIDC_TOKEN_V3: 'probe-only-job-marker',
				},
			},
		)
		assert.equal(result.status, 1)
		assert.match(
			result.stderr,
			kind === 'symlink' ? /regular file.*not a link/ : /not valid TOML/,
		)
		assert.ok(!`${result.stdout}${result.stderr}`.includes(SOURCE_MARKER))
		assert.ok(
			!`${result.stdout}${result.stderr}`.includes(
				'probe-only-job-marker',
			),
		)
	})
}

for (const environment of ['development', 'production']) {
	test(`an application cannot claim the approval hostname in ${environment}`, () => {
		const parsed = v.safeParse(NextnodeToml, {
			environments: {
				production: { domain: 'app.example.invalid' },
				[environment]: { domain: GITHUB_SERVICE.hostname },
			},
		})
		assert.equal(parsed.success, false)
		if (!parsed.success)
			assert.match(
				describe(parsed.issues),
				/reserved for the platform approval service/,
			)
	})
}

test('an approval denial stays forbidden when its GitHub failure report cannot be written', async context => {
	const api = await githubProbeApi(context, () =>
		assert.fail('Unexpected provider request'),
	)
	context.mock.method(GitHubApi, 'connect', async () => api)
	context.mock.method(
		GitHubApproval.prototype,
		'load',
		async (): Promise<never> => {
			throw new ApprovalDenied('Approval denied by GitHub')
		},
	)
	context.mock.method(
		GitHubApproval.prototype,
		'notifyFailure',
		async (): Promise<never> => {
			throw new Error('Provider unavailable')
		},
	)
	const body = JSON.stringify(probe.event)
	const signature = createHmac('sha256', WEBHOOK_KEY)
		.update(body)
		.digest('hex')
	const response = await worker.fetch(
		new Request(GITHUB_WEBHOOK, {
			method: 'POST',
			body,
			headers: {
				'x-github-event': 'check_run',
				'x-hub-signature-256': `sha256=${signature}`,
			},
		}),
		{
			GITHUB_APP_ID: String(probe.appId),
			GITHUB_APP_INSTALLATION_ID: String(probe.event.installation.id),
			GITHUB_APP_PRIVATE_KEY: 'probe-only-key',
			CIRCLECI_TOKEN: 'probe-only-circle-token',
			GITHUB_WEBHOOK_SECRET: WEBHOOK_KEY,
		},
	)
	assert.equal(response.status, 403)
	assert.deepEqual(await response.json(), {
		approved: false,
		error: 'Approval refused',
	})
})

const webhookCases = [
	{
		name: 'a signed malformed approval event',
		origin: GITHUB_WEBHOOK.origin,
		eventName: 'check_run',
		payload: {
			...probe.event,
			sender: { id: probe.actor.id, type: 'Bot' },
		},
		status: 403,
		response: { approved: false, error: 'Approval refused' },
	},
	{
		name: 'a signed valid approval on an old version origin',
		origin: 'https://old-version.example.invalid',
		eventName: 'check_run',
		payload: probe.event,
		status: 403,
		response: { approved: false, error: 'Approval refused' },
	},
	{
		name: 'a signed preview health ping',
		origin: 'https://old-version.example.invalid',
		eventName: 'ping',
		payload: probe.event,
		status: 200,
		response: { accepted: true },
	},
]

for (const webhook of webhookCases) {
	test(`${webhook.name} cannot contact an approval provider`, async context => {
		context.mock.method(globalThis, 'fetch', (): never =>
			assert.fail(
				'Malformed approvals must not contact GitHub or CircleCI',
			),
		)
		const body = JSON.stringify(webhook.payload)
		const signature = createHmac('sha256', WEBHOOK_KEY)
			.update(body)
			.digest('hex')
		const request = new Request(
			new URL(GITHUB_WEBHOOK.pathname, webhook.origin),
			{
				method: 'POST',
				headers: {
					'x-github-event': webhook.eventName,
					'x-hub-signature-256': `sha256=${signature}`,
				},
				body,
			},
		)
		const response = await worker.fetch(request, {
			GITHUB_APP_ID: String(probe.appId),
			GITHUB_APP_INSTALLATION_ID: String(probe.event.installation.id),
			GITHUB_APP_PRIVATE_KEY: 'probe-only-key',
			CIRCLECI_TOKEN: 'probe-only-circle-token',
			GITHUB_WEBHOOK_SECRET: WEBHOOK_KEY,
		})
		assert.equal(response.status, webhook.status)
		assert.deepEqual(await response.json(), webhook.response)
	})
}
