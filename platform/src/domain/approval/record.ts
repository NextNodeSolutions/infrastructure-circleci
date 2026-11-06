import * as v from 'valibot'

import { PROJECT_NAME } from '../configuration/project-name.ts'

export const PositiveId = v.pipe(v.number(), v.integer(), v.minValue(1))
export const Revision = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))
export const APPROVAL_CHECK = 'Approve production'
export const APPROVAL_ACTION = 'approve-production'
export const APPROVERS_TEAM = 'core'
export const Release = v.object({
	workflow: v.pipe(v.string(), v.uuid()),
	project: v.pipe(v.string(), v.uuid()),
	revision: Revision,
	pull: PositiveId,
})
export type Release = v.InferOutput<typeof Release>
export const ApprovalRecord = v.object({
	...Release.entries,
	approver: v.optional(PositiveId),
})
export type ApprovalRecord = v.InferOutput<typeof ApprovalRecord>
export const ApprovalEvent = v.object({
	action: v.literal('requested_action'),
	requested_action: v.object({ identifier: v.literal(APPROVAL_ACTION) }),
	installation: v.object({ id: PositiveId }),
	sender: v.object({ id: PositiveId, type: v.literal('User') }),
	repository: v.object({
		name: v.pipe(v.string(), v.regex(PROJECT_NAME)),
		full_name: v.string(),
	}),
	check_run: v.object({ id: PositiveId }),
})
export type ApprovalEvent = v.InferOutput<typeof ApprovalEvent>
export const ApprovalCheck = v.object({
	id: PositiveId,
	name: v.literal(APPROVAL_CHECK),
	head_sha: Revision,
	external_id: v.string(),
	app: v.object({ id: PositiveId }),
	status: v.string(),
	conclusion: v.nullable(v.string()),
})
export type ApprovalCheck = v.InferOutput<typeof ApprovalCheck>
export type Actor = { id: number; login: string }
export type Approval = {
	check: ApprovalCheck
	record: ApprovalRecord
	repository: string
}
