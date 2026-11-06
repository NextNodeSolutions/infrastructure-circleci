import { parseArgs } from 'node:util'

import * as v from 'valibot'

import { GitHubApi } from './src/adapters/github/api.ts'
import { GitHubApproval } from './src/adapters/github/approval.ts'
import { mergedPull, ReleaseChecks } from './src/adapters/github/checks.ts'
import { decode, ReportingError } from './src/adapters/github/transport.ts'
import { readSpec } from './src/adapters/platform-files.ts'
import { verifyProductionApproval } from './src/application/approval/authorize.ts'
import { Release } from './src/domain/approval/record.ts'
import { PlatformError } from './src/domain/platform-error.ts'

import type { Pull } from './src/adapters/github/api.ts'
import type { Environment } from './src/domain/configuration/nextnode-toml.ts'

const CircleContext = v.object({
	CIRCLE_BRANCH: v.literal('main'),
	CIRCLE_PROJECT_REPONAME: v.string(),
	CIRCLE_SHA1: Release.entries.revision,
	CIRCLE_WORKFLOW_ID: Release.entries.workflow,
	CIRCLE_PROJECT_ID: Release.entries.project,
})
type Context = {
	checks: ReleaseChecks
	approval: GitHubApproval
	release: Release
	pull: Pull
	urls: Partial<Record<Environment, string>>
}

async function start(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'development',
		status: 'queued',
		summary: 'Development awaits the main-branch checks',
	})
	await context.checks.publish({
		environment: 'production',
		status: 'queued',
		summary: 'Production awaits development and GitHub approval',
	})
}

async function checksFailed(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'development',
		status: 'completed',
		conclusion: 'skipped',
		summary:
			'Development was not deployed because main-branch checks failed',
	})
	await context.checks.publish({
		environment: 'production',
		status: 'completed',
		conclusion: 'skipped',
		summary:
			'Production was not deployed because main-branch checks failed',
	})
}

async function developmentStarted(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'development',
		status: 'in_progress',
		summary: 'Development deployment is running',
	})
}

async function developmentSucceeded(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'development',
		status: 'completed',
		conclusion: context.urls.development ? 'success' : 'skipped',
		summary: context.urls.development
			? 'Development deployment passed its health check'
			: 'This project declares no development environment',
		url: context.urls.development,
	})
	await context.approval.create(context.release, context.pull.head.sha)
}

async function developmentFailed(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'development',
		status: 'completed',
		conclusion: 'failure',
		summary: 'Development failed. Production has not been released.',
	})
	await context.checks.publish({
		environment: 'production',
		status: 'completed',
		conclusion: 'skipped',
		summary: 'Production was skipped because development failed',
	})
}

async function productionStarted(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'production',
		status: 'in_progress',
		summary: 'GitHub approval verified. Production deployment is running.',
	})
}

async function productionSucceeded(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'production',
		status: 'completed',
		conclusion: 'success',
		summary: 'Production passed its health check and is serving',
		url: context.urls.production,
	})
}

async function productionFailed(context: Context): Promise<void> {
	await context.checks.publish({
		environment: 'production',
		status: 'completed',
		conclusion: 'failure',
		summary: 'Production deployment failed',
	})
}

async function verifyProduction(context: Context): Promise<void> {
	await verifyProductionApproval(
		context.release,
		await context.approval.find(context.release, context.pull),
		context.approval,
	)
	console.log(
		'GitHub Core approval verified for this workflow, project, revision and original pull request',
	)
}

const HANDLERS = {
	start,
	'checks-failed': checksFailed,
	'development-started': developmentStarted,
	'development-succeeded': developmentSucceeded,
	'development-failed': developmentFailed,
	'production-started': productionStarted,
	'production-succeeded': productionSucceeded,
	'production-failed': productionFailed,
	'verify-production': verifyProduction,
}

function isPhase(value: string): value is keyof typeof HANDLERS {
	return Object.hasOwn(HANDLERS, value)
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { phase: { type: 'string' }, spec: { type: 'string' } },
	})
	if (!values.phase || !isPhase(values.phase) || !values.spec)
		throw new ReportingError(
			`--spec and --phase ${Object.keys(HANDLERS).join('|')} are required`,
		)
	const environment = decode(CircleContext, process.env)
	const spec = readSpec(values.spec)
	if (spec.project !== environment.CIRCLE_PROJECT_REPONAME)
		throw new ReportingError(
			'The release spec must identify the CircleCI repository',
		)
	const api = await GitHubApi.connect(
		process.env,
		environment.CIRCLE_PROJECT_REPONAME,
		values.phase === 'verify-production' ? 'verify' : 'report',
	)
	const pull = await mergedPull(api, environment.CIRCLE_SHA1)
	const release = {
		workflow: environment.CIRCLE_WORKFLOW_ID,
		project: environment.CIRCLE_PROJECT_ID,
		revision: environment.CIRCLE_SHA1,
		pull: pull.number,
	}
	await HANDLERS[values.phase]({
		checks: new ReleaseChecks(api, release, pull),
		approval: new GitHubApproval(api),
		release,
		pull,
		urls: Object.fromEntries(
			Object.entries(spec.domains).map(([name, domain]) => [
				name,
				`https://${domain}`,
			]),
		),
	})
}

await main().catch((error: unknown) => {
	console.error(
		PlatformError.describe(
			error,
			'GitHub reporting failed. Verify the App installation, permissions, vault keys, and main-branch release context.',
		),
	)
	process.exitCode = 1
})
