import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import { APPROVAL_PROBE } from './approval-probe-fixtures.ts'
import { verifyWebhook } from './src/adapters/github/webhook.ts'
import {
	authorizeApproval,
	verifyProductionApproval,
} from './src/application/approval/authorize.ts'
import { APPROVAL_CHECK } from './src/domain/approval/record.ts'

import type {
	ApprovalCircleCI,
	ApprovalGitHub,
} from './src/application/ports/approval.ts'
import type { Actor, Approval } from './src/domain/approval/record.ts'

const { release: RELEASE, actor: ACTOR, event: EVENT } = APPROVAL_PROBE

class GitHubProbe implements ApprovalGitHub {
	canApprove = false
	currentRevision = RELEASE.revision
	recorded = false
	approval: Approval = {
		repository: EVENT.repository.full_name,
		record: { ...RELEASE },
		check: {
			id: EVENT.check_run.id,
			name: APPROVAL_CHECK,
			head_sha: APPROVAL_PROBE.head,
			external_id: JSON.stringify(RELEASE),
			app: { id: 1 },
			status: 'completed',
			conclusion: 'action_required',
		},
	}
	async load(): Promise<Approval> {
		return this.approval
	}
	async actor(): Promise<Actor> {
		return ACTOR
	}
	async requireCurrent(record: Approval['record']): Promise<void> {
		if (record.revision !== this.currentRevision)
			throw new Error('The main revision has been superseded')
	}
	async requireMember(): Promise<void> {
		if (!this.canApprove)
			throw new Error('GitHub Core membership is required')
	}
	async record(approval: Approval, actor: Actor): Promise<void> {
		this.recorded = true
		this.approval = {
			...approval,
			record: { ...approval.record, approver: actor.id },
			check: { ...approval.check, conclusion: 'success' },
		}
	}
}

class CircleProbe implements ApprovalCircleCI {
	released = false
	readonly github: GitHubProbe
	constructor(github: GitHubProbe) {
		this.github = github
	}
	async requireRelease(): Promise<void> {}
	async approve(): Promise<void> {
		assert.equal(
			this.github.recorded,
			true,
			'the production job can start only after the GitHub decision is recorded',
		)
		this.released = true
	}
}

test('a forged webhook cannot reach approval handling', async () => {
	const request = new Request('https://github.nextnode.fr/webhook', {
		method: 'POST',
		headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
		body: JSON.stringify(EVENT),
	})
	await assert.rejects(
		verifyWebhook(request, APPROVAL_PROBE.webhookKey),
		/signature/,
	)
})

test('a correctly signed webhook is accepted without changing its payload', async () => {
	const body = JSON.stringify(EVENT)
	const signature = createHmac('sha256', APPROVAL_PROBE.webhookKey)
		.update(body)
		.digest('hex')
	const request = new Request('https://github.nextnode.fr/webhook', {
		method: 'POST',
		headers: { 'x-hub-signature-256': `sha256=${signature}` },
		body,
	})
	assert.deepEqual(
		await verifyWebhook(request, APPROVAL_PROBE.webhookKey),
		EVENT,
	)
})

test('an approver outside the GitHub Core team cannot record or release approval', async () => {
	const github = new GitHubProbe()
	const circle = new CircleProbe(github)
	await assert.rejects(
		authorizeApproval(EVENT, github, circle),
		/Core membership/,
	)
	assert.equal(github.recorded, false)
	assert.equal(circle.released, false)
})

test('an authorized approver records the decision before releasing production', async () => {
	const github = new GitHubProbe()
	github.canApprove = true
	const circle = new CircleProbe(github)
	await authorizeApproval(EVENT, github, circle)
	assert.equal(circle.released, true)
	assert.equal(github.approval.record.approver, ACTOR.id)
	await verifyProductionApproval(RELEASE, github.approval, github)
})

test('direct CircleCI approval cannot pass the production guard', async () => {
	const github = new GitHubProbe()
	github.canApprove = true
	await assert.rejects(
		verifyProductionApproval(RELEASE, github.approval, github),
		/GitHub approval/,
	)
})

test('approval for another workflow cannot release the current workflow', async () => {
	const github = new GitHubProbe()
	github.canApprove = true
	await authorizeApproval(EVENT, github, new CircleProbe(github))
	await assert.rejects(
		verifyProductionApproval(
			{ ...RELEASE, workflow: APPROVAL_PROBE.otherWorkflow },
			github.approval,
			github,
		),
		/workflow/,
	)
})

test('removed Core membership invalidates a previously recorded approval', async () => {
	const github = new GitHubProbe()
	github.canApprove = true
	await authorizeApproval(EVENT, github, new CircleProbe(github))
	github.canApprove = false
	await assert.rejects(
		verifyProductionApproval(RELEASE, github.approval, github),
		/Core membership/,
	)
})
