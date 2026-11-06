import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'

import * as v from 'valibot'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'

import type { SpawnSyncReturns } from 'node:child_process'
import type { TestContext } from 'node:test'

const TRUSTED_DOMAIN = 'https://vault.example.invalid/api'
const SUBPROCESS_TIMEOUT_MS = 10_000
const RequestLog = v.array(
	v.object({ cwd: v.string(), args: v.array(v.string()) }),
)

const FAKE_CLI = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const key = args[args.indexOf("get") + 1];
fs.appendFileSync(process.env.PROBE_CALLS, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const values = {
  GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "1",
  GITHUB_WEBHOOK_SECRET: ${JSON.stringify(probe.webhookKey)}
};
process.stdout.write((key === process.env.PROBE_MISSING ? "*not found*" : values[key] || "probe-only-value") + "\\n");
`

function exporter(
	context: TestContext,
	scope: 'resources' | 'runtime',
	missing = '',
): SpawnSyncReturns<string> & {
	requests: v.InferOutput<typeof RequestLog>
	checkout: string
} {
	const root = mkdtempSync(join(tmpdir(), 'nextnode-vault-probe-'))
	context.after(() => rmSync(root, { recursive: true, force: true }))
	const calls = join(root, 'calls.jsonl')
	writeFileSync(join(root, 'infisical'), FAKE_CLI, { mode: 0o700 })
	writeFileSync(
		join(root, '.infisical.json'),
		JSON.stringify({
			workspaceId: 'attacker-controlled-project',
			defaultEnvironment: 'production',
		}),
	)
	const result = spawnSync(
		process.execPath,
		[
			join(import.meta.dirname, 'vault-secrets.ts'),
			'--scope',
			scope,
			'--format',
			'json',
		],
		{
			cwd: root,
			encoding: 'utf8',
			timeout: SUBPROCESS_TIMEOUT_MS,
			env: {
				PATH: [root, dirname(process.execPath)].join(delimiter),
				HOME: root,
				INFISICAL_DOMAIN: TRUSTED_DOMAIN,
				INFISICAL_TOKEN: 'probe-only-vault-token',
				INFISICAL_PLATFORM_PROJECT_ID: 'probe-only-platform-project',
				PROBE_CALLS: calls,
				PROBE_MISSING: missing,
			},
		},
	)
	const requests = v.parse(
		RequestLog,
		readFileSync(calls, 'utf8')
			.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line)),
	)
	return { ...result, requests, checkout: root }
}

for (const [scope, missing] of [
	['resources', 'PULUMI_CONFIG_PASSPHRASE'],
	['runtime', 'CIRCLECI_TOKEN'],
] satisfies ['resources' | 'runtime', string][]) {
	test(`a missing ${missing} cannot become a deployed placeholder credential`, context => {
		const result = exporter(context, scope, missing)
		assert.equal(result.status, 1)
		assert.match(
			result.stderr,
			new RegExp(`Missing required platform credential ${missing}`),
		)
		assert.equal(
			result.stdout,
			'',
			'no partial credential export may escape',
		)
	})
}

test('project Infisical configuration cannot select the platform credential destination', context => {
	const result = exporter(context, 'resources')
	assert.equal(result.status, 0, result.stderr)
	for (const request of result.requests) {
		assert.notEqual(request.cwd, result.checkout)
		assert.equal(
			request.args[request.args.indexOf('--domain') + 1],
			TRUSTED_DOMAIN,
		)
		assert.equal(request.args[request.args.indexOf('--env') + 1], 'main')
		assert.equal(
			request.args[request.args.indexOf('--projectId') + 1],
			'probe-only-platform-project',
		)
	}
})

test('resource credential export never requests or exports GitHub or approval credentials', context => {
	const result = exporter(context, 'resources')
	assert.equal(result.status, 0, result.stderr)
	const exported: unknown = JSON.parse(result.stdout)
	const parsed = v.parse(v.record(v.string(), v.string()), exported)
	assert.deepEqual(Object.keys(parsed).toSorted(), [
		'CLOUDFLARE_ACCOUNT_ID',
		'CLOUDFLARE_API_TOKEN',
		'PULUMI_CONFIG_PASSPHRASE',
	])
	assert.deepEqual(
		result.requests
			.map(request => request.args[request.args.indexOf('get') + 1])
			.toSorted(),
		Object.keys(parsed).toSorted(),
	)
})

test('approval runtime export never requests or exports Cloudflare or state credentials', context => {
	const result = exporter(context, 'runtime')
	assert.equal(result.status, 0, result.stderr)
	const exported: unknown = JSON.parse(result.stdout)
	const parsed = v.parse(v.record(v.string(), v.string()), exported)
	assert.deepEqual(Object.keys(parsed).toSorted(), [
		'CIRCLECI_TOKEN',
		'GITHUB_APP_ID',
		'GITHUB_APP_INSTALLATION_ID',
		'GITHUB_APP_PRIVATE_KEY',
		'GITHUB_WEBHOOK_SECRET',
	])
})
