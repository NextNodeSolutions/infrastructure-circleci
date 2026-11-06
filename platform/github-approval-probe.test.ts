import assert from 'node:assert/strict'
import test from 'node:test'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'
import { githubProbeApi } from './github-probe-api.ts'
import { GitHubApproval } from './src/adapters/github/approval.ts'
import { ApprovalDenied } from './src/domain/approval/errors.ts'
import { APPROVAL_CHECK } from './src/domain/approval/record.ts'

import type { ApprovalCheck } from './src/domain/approval/record.ts'

function approvalCheck(overrides: Partial<ApprovalCheck> = {}): ApprovalCheck {
	return {
		id: probe.event.check_run.id,
		name: APPROVAL_CHECK,
		head_sha: probe.head,
		external_id: JSON.stringify(probe.release),
		app: { id: probe.appId },
		status: 'completed',
		conclusion: 'action_required',
		...overrides,
	}
}

function mergedPull(
	number: number = probe.release.pull,
	revision: string = probe.release.revision,
): unknown {
	return {
		number,
		merged_at: '2026-10-01T00:00:00Z',
		merge_commit_sha: revision,
		head: { sha: probe.head },
		base: {
			ref: 'main',
			repo: { full_name: probe.event.repository.full_name },
		},
	}
}

test('an existing approval beyond the first page is reused rather than duplicated', async context => {
	const pages: string[] = []
	const writes: string[] = []
	const api = await githubProbeApi(context, (url, request) => {
		if (request?.method !== 'GET') {
			writes.push(url.pathname)
			return Response.json({})
		}
		const page = url.searchParams.get('page') ?? ''
		pages.push(page)
		if (page === '1')
			return Response.json({
				check_runs: Array.from({ length: 100 }, (_, index) =>
					approvalCheck({
						id: index + 100,
						external_id: JSON.stringify({
							...probe.release,
							workflow: probe.otherWorkflow,
						}),
					}),
				),
			})
		assert.equal(page, '2')
		return Response.json({ check_runs: [approvalCheck()] })
	})
	await new GitHubApproval(api).create(probe.release, probe.head)
	assert.deepEqual(pages, ['1', '2'])
	assert.deepEqual(writes, [])
})

test('multiple approval records for one workflow are refused', async context => {
	const api = await githubProbeApi(context, () =>
		Response.json({
			check_runs: [approvalCheck(), approvalCheck({ id: 8 })],
		}),
	)
	await assert.rejects(
		new GitHubApproval(api).create(probe.release, probe.head),
		/Multiple approval checks/,
	)
})

for (const [label, encoded] of [
	['invalid JSON', 'not-json'],
	[
		'a non-UUID workflow',
		JSON.stringify({ ...probe.release, workflow: 'not-a-workflow' }),
	],
	[
		'a non-positive approver',
		JSON.stringify({ ...probe.release, approver: 0 }),
	],
] satisfies [string, string][]) {
	test(`a stored approval containing ${label} is permanently refused`, async context => {
		const api = await githubProbeApi(context, () =>
			Response.json(approvalCheck({ external_id: encoded })),
		)
		await assert.rejects(
			new GitHubApproval(api).load(probe.event.check_run.id),
			ApprovalDenied,
		)
	})
}

test('an approval for another GitHub App is refused', async context => {
	const api = await githubProbeApi(context, () =>
		Response.json(approvalCheck({ app: { id: 999 } })),
	)
	await assert.rejects(
		new GitHubApproval(api).load(probe.event.check_run.id),
		/another GitHub App/,
	)
})

test('an approval attached to another pull-request head is refused', async context => {
	const api = await githubProbeApi(context, url =>
		Response.json(
			url.pathname.includes('/pulls/')
				? mergedPull()
				: approvalCheck({ head_sha: probe.release.revision }),
		),
	)
	await assert.rejects(
		new GitHubApproval(api).load(probe.event.check_run.id),
		/original merged pull request/,
	)
})

test('an approval on the head of main is current', async context => {
	const api = await githubProbeApi(context, url => {
		if (!url.pathname.endsWith('/commits/main/pulls'))
			return Response.json({})
		return Response.json([mergedPull()])
	})
	await new GitHubApproval(api).requireCurrent({ ...probe.release })
})

test('a superseded main revision cannot receive production approval', async context => {
	const api = await githubProbeApi(context, url => {
		if (!url.pathname.endsWith('/commits/main/pulls'))
			return Response.json({})
		return Response.json([mergedPull(probe.release.pull, probe.head)])
	})
	await assert.rejects(
		new GitHubApproval(api).requireCurrent({ ...probe.release }),
		/superseded/,
	)
})

test('a newer squashed pull request makes the recorded revision stale', async context => {
	const api = await githubProbeApi(context, url => {
		if (!url.pathname.endsWith('/commits/main/pulls'))
			return Response.json({})
		return Response.json([mergedPull(202, probe.head)])
	})
	await assert.rejects(
		new GitHubApproval(api).requireCurrent({ ...probe.release }),
		/superseded/,
	)
})

test('a direct commit on main without an associated pull request makes the recorded revision stale', async context => {
	const api = await githubProbeApi(context, url => {
		if (!url.pathname.endsWith('/commits/main/pulls'))
			return Response.json({})
		return Response.json([])
	})
	await assert.rejects(
		new GitHubApproval(api).requireCurrent({ ...probe.release }),
		/superseded/,
	)
})

test('a deleted approval check is a permanent refusal rather than an API retry', async context => {
	const api = await githubProbeApi(context, () =>
		Response.json({ message: 'Not Found' }, { status: 404 }),
	)
	await assert.rejects(
		new GitHubApproval(api).load(probe.event.check_run.id),
		ApprovalDenied,
	)
})

test('failure details never change a stored approval decision', async context => {
	const writes: unknown[] = []
	const api = await githubProbeApi(context, (_url, request) => {
		if (request?.method === 'GET')
			return Response.json(
				approvalCheck({
					conclusion: 'success',
					external_id: JSON.stringify({
						...probe.release,
						approver: probe.actor.id,
					}),
				}),
			)
		const payload: unknown = JSON.parse(String(request?.body))
		writes.push(payload)
		return Response.json({})
	})
	await new GitHubApproval(api).notifyFailure(
		probe.event.check_run.id,
		'Active GitHub Core membership is required',
	)
	assert.deepEqual(writes, [])
})

test('GitHub membership absence cannot authorize approval', async context => {
	const api = await githubProbeApi(context, () =>
		Response.json({ message: 'Not Found' }, { status: 404 }),
	)
	await assert.rejects(
		new GitHubApproval(api).requireMember(probe.actor),
		ApprovalDenied,
	)
})
