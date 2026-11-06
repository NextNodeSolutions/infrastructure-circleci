import assert from 'node:assert/strict'
import test from 'node:test'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'
import { CircleApproval } from './src/adapters/circleci/approval.ts'
import { ApprovalDenied } from './src/domain/approval/errors.ts'

import type { TestContext } from 'node:test'

const HOLD_REQUEST = '44444444-4444-4444-8444-444444444444'

type Scenario = {
	branch: string
	revision: string
	owner: string
	workflowStatus: string
	holdStatus: string
}

function circleApi(
	context: TestContext,
	overrides: Partial<Scenario> = {},
): { circle: CircleApproval; writes: string[] } {
	const scenario: Scenario = {
		branch: 'main',
		revision: probe.release.revision,
		owner: probe.owner,
		workflowStatus: 'on_hold',
		holdStatus: 'on_hold',
		...overrides,
	}
	const writes: string[] = []
	const responses: Record<string, unknown> = {
		[`/api/v2/workflow/${probe.release.workflow}`]: {
			id: probe.release.workflow,
			status: scenario.workflowStatus,
			pipeline_id: probe.pipeline,
			project_slug: probe.projectSlug,
		},
		[`/api/v2/project/${probe.projectSlug}`]: {
			id: probe.release.project,
			name: probe.repositoryName,
		},
		[`/api/v2/pipeline/${probe.pipeline}`]: {
			id: probe.pipeline,
			trigger_parameters: { git: { checkout_sha: scenario.revision } },
		},
		[`/api/v2/pipeline/${probe.pipeline}/values`]: {
			'pipeline.git.branch': scenario.branch,
			'pipeline.git.revision': scenario.revision,
			'pipeline.git.repo_owner': scenario.owner,
			'pipeline.git.repo_name': probe.repositoryName,
			'pipeline.config.sha': probe.head,
			'pipeline.config.ref': 'refs/heads/platform-change',
		},
		[`/api/v2/workflow/${probe.release.workflow}/job`]: {
			items: [
				{
					name: 'hold',
					type: 'approval',
					status: scenario.holdStatus,
					approval_request_id: HOLD_REQUEST,
				},
			],
		},
	}
	context.mock.method(
		globalThis,
		'fetch',
		async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		): Promise<Response> => {
			const path = new URL(
				input instanceof Request ? input.url : String(input),
			).pathname
			if (init?.method === 'POST') {
				writes.push(path)
				return Response.json({ message: 'accepted' }, { status: 202 })
			}
			assert.ok(
				Object.hasOwn(responses, path),
				`Unexpected CircleCI request: ${path}`,
			)
			return Response.json(responses[path])
		},
	)
	return { circle: new CircleApproval('probe-only-circle-token'), writes }
}

test('GitHub App checkout values authorize main independently of the configuration revision', async context => {
	const { circle, writes } = circleApi(context)
	await circle.requireRelease(probe.release, probe.event.repository.full_name)
	assert.deepEqual(
		writes,
		[],
		'checking release eligibility must not release the hold',
	)
})

for (const [label, overrides] of [
	['a branch other than main', { branch: 'feature' }],
	['another checkout revision', { revision: probe.head }],
	['another repository owner', { owner: 'another-owner' }],
] satisfies [string, Partial<Scenario>][]) {
	test(`a release refuses ${label}`, async context => {
		const { circle, writes } = circleApi(context, overrides)
		await assert.rejects(
			circle.requireRelease(
				probe.release,
				probe.event.repository.full_name,
			),
			ApprovalDenied,
		)
		assert.deepEqual(writes, [])
	})
}

test('an ended workflow cannot receive a new approval', async context => {
	const { circle, writes } = circleApi(context, {
		workflowStatus: 'failed',
		holdStatus: 'success',
	})
	await assert.rejects(
		circle.requireRelease(probe.release, probe.event.repository.full_name),
		/workflow has ended/,
	)
	assert.deepEqual(writes, [])
})

test('a manually released hold without a GitHub decision is refused', async context => {
	const { circle, writes } = circleApi(context, {
		workflowStatus: 'running',
		holdStatus: 'success',
	})
	await assert.rejects(
		circle.requireRelease(probe.release, probe.event.repository.full_name),
		/without GitHub approval/,
	)
	assert.deepEqual(writes, [])
})

test('retrying a recorded approval never approves an already released hold again', async context => {
	const { circle, writes } = circleApi(context, {
		workflowStatus: 'running',
		holdStatus: 'success',
	})
	await circle.requireRelease(
		{ ...probe.release, approver: probe.actor.id },
		probe.event.repository.full_name,
	)
	await circle.approve(probe.release)
	assert.deepEqual(writes, [])
})

test('a valid pending hold is released through its exact approval request', async context => {
	const { circle, writes } = circleApi(context)
	await circle.requireRelease(probe.release, probe.event.repository.full_name)
	await circle.approve(probe.release)
	assert.deepEqual(writes, [
		`/api/v2/workflow/${probe.release.workflow}/approve/${HOLD_REQUEST}`,
	])
})
