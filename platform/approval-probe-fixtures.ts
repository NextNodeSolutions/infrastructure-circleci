import { APPROVAL_ACTION } from './src/approval-record.ts'

import type { Actor, ApprovalEvent, Release } from './src/approval-record.ts'

const owner = 'NextNodeSolutions'
const repositoryName = 'canary'
const release: Release = {
	workflow: '88d81a55-8fb8-482d-8ffb-1b4b95291975',
	project: '11111111-1111-4111-8111-111111111111',
	revision: '1111111111111111111111111111111111111111',
	pull: 19,
}
const actor: Actor = { id: 101, login: 'authorized-user' }
const event: ApprovalEvent = {
	action: 'requested_action',
	requested_action: { identifier: APPROVAL_ACTION },
	installation: { id: 1 },
	sender: { id: actor.id, type: 'User' },
	repository: {
		name: repositoryName,
		full_name: `${owner}/${repositoryName}`,
	},
	check_run: { id: 7 },
}

export const APPROVAL_PROBE = {
	owner,
	repositoryName,
	release,
	actor,
	event,
	appId: 1,
	rsaKeyBits: 2048,
	webhookKey: 'probe-only-webhook-key-with-enough-length',
	head: '2222222222222222222222222222222222222222',
	pipeline: '33333333-3333-4333-8333-333333333333',
	otherWorkflow: '7921c8f5-4b8b-4db5-93c2-e8cd51fa5a2c',
	projectSlug: 'circleci/probe-organization/probe-project',
}
