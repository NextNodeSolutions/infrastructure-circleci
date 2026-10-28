import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import * as v from 'valibot'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'
import { ApprovalUnavailable } from './src/authorize-approval.ts'
import { CircleApproval } from './src/circle-approval.ts'
import { GitHubApi } from './src/github-api.ts'
import { ReportingError } from './src/github-transport.ts'
import { stackHasResource } from './src/stack-has-resource.ts'

import type { TestContext } from 'node:test'

const ApprovalPermissions = v.object({
	permissions: v.object({
		checks: v.literal('write'),
		pull_requests: v.literal('read'),
		members: v.literal('read'),
	}),
})

function installation(
	context: TestContext,
	events: string[] = ['check_run'],
	tokenStatus = 201,
): { credentials: unknown; grants: string[] } {
	const grants: string[] = []
	const { privateKey } = generateKeyPairSync('rsa', {
		modulusLength: probe.rsaKeyBits,
	})
	context.mock.method(
		globalThis,
		'fetch',
		async (
			input: Parameters<typeof fetch>[0],
			request?: RequestInit,
		): Promise<Response> => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
			)
			if (request?.method === 'GET')
				return Response.json({
					app_id: probe.appId,
					account: { login: probe.owner },
					events,
				})
			const payload: unknown = JSON.parse(String(request?.body))
			assert.equal(
				v.safeParse(ApprovalPermissions, payload).success,
				true,
				'preflight must request the real approval permissions',
			)
			grants.push(url.pathname)
			return Response.json(
				{ token: 'probe-only-preflight-token' },
				{ status: tokenStatus },
			)
		},
	)
	return {
		credentials: {
			GITHUB_APP_ID: String(probe.appId),
			GITHUB_APP_INSTALLATION_ID: String(probe.event.installation.id),
			GITHUB_APP_PRIVATE_KEY: privateKey
				.export({ format: 'pem', type: 'pkcs8' })
				.toString(),
		},
		grants,
	}
}

test('service preflight proves installation access with approval permissions', async context => {
	const { credentials, grants } = installation(context)
	await GitHubApi.verifyAccess(credentials)
	assert.deepEqual(grants, [
		`/app/installations/${probe.event.installation.id}/access_tokens`,
	])
})

test('production verification requests a read-only repository token', async context => {
	const { credentials } = installation(context)
	context.mock.method(
		globalThis,
		'fetch',
		async (
			_input: Parameters<typeof fetch>[0],
			request?: RequestInit,
		): Promise<Response> => {
			if (request?.method === 'GET')
				return Response.json({
					app_id: probe.appId,
					account: { login: probe.owner },
					events: ['check_run'],
				})
			const payload: unknown = JSON.parse(String(request?.body))
			assert.deepEqual(payload, {
				repositories: [probe.repositoryName],
				permissions: {
					checks: 'read',
					pull_requests: 'read',
					members: 'read',
				},
			})
			return Response.json(
				{ token: 'probe-only-read-token' },
				{ status: 201 },
			)
		},
	)
	await GitHubApi.connect(credentials, probe.repositoryName, 'verify')
})

test('an installation without Check run events cannot pass service preflight', async context => {
	const { credentials, grants } = installation(context, [])
	await assert.rejects(GitHubApi.verifyAccess(credentials), /Check run/)
	assert.deepEqual(grants, [])
})

test('missing installation permission cannot pass service preflight', async context => {
	const { credentials } = installation(context, ['check_run'], 403)
	await assert.rejects(GitHubApi.verifyAccess(credentials), ReportingError)
})

test('service configuration writes the deployed webhook key into the GitHub App', async context => {
	const { credentials } = installation(context)
	const writes: unknown[] = []
	context.mock.method(
		globalThis,
		'fetch',
		async (
			input: Parameters<typeof fetch>[0],
			request?: RequestInit,
		): Promise<Response> => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
			)
			assert.equal(url.pathname, '/app/hook/config')
			assert.equal(request?.method, 'PATCH')
			const payload: unknown = JSON.parse(String(request?.body))
			writes.push(payload)
			return Response.json({
				url: 'https://github.nextnode.fr/webhook',
				content_type: 'json',
				insecure_ssl: '0',
			})
		},
	)
	await GitHubApi.configureWebhook(
		credentials,
		new URL('https://github.nextnode.fr/webhook'),
		probe.webhookKey,
	)
	assert.deepEqual(writes, [
		{
			url: 'https://github.nextnode.fr/webhook',
			content_type: 'json',
			insecure_ssl: '0',
			secret: probe.webhookKey,
		},
	])
})

test('an initialized stack with an omitted resource list permits first publication', async () => {
	const stack = {
		async exportStack(): Promise<unknown> {
			return {
				version: 3,
				deployment: {
					manifest: {},
					secrets_providers: {},
					metadata: {},
				},
			}
		},
	}
	assert.equal(await stackHasResource(stack, 'domain'), false)
})

test('an interrupted deployment with a recorded domain does not become a first publication', async () => {
	const stack = {
		async exportStack(): Promise<unknown> {
			return {
				deployment: {
					resources: [
						{
							urn: 'urn:pulumi:production::platform.nextnode-github::cloudflare:index/workersCustomDomain:WorkersCustomDomain::domain',
						},
					],
				},
			}
		},
	}
	assert.equal(await stackHasResource(stack, 'domain'), true)
})

test('an empty service checkpoint permits first publication but a malformed checkpoint refuses it', async () => {
	assert.equal(
		await stackHasResource(
			{
				async exportStack(): Promise<unknown> {
					return { deployment: { resources: [] } }
				},
			},
			'domain',
		),
		false,
	)
	await assert.rejects(
		stackHasResource(
			{
				async exportStack(): Promise<unknown> {
					return {}
				},
			},
			'domain',
		),
		/Cannot read the Pulumi resource checkpoint/,
	)
})

test('an invalid CircleCI credential cannot pass service preflight', async context => {
	context.mock.method(globalThis, 'fetch', async (): Promise<Response> =>
		Response.json({ message: 'Unauthorized' }, { status: 401 }),
	)
	await assert.rejects(
		new CircleApproval('probe-only-invalid-token').verifyAccess(),
		ApprovalUnavailable,
	)
})
