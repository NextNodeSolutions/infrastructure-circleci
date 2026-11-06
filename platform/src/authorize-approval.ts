import { PlatformError } from './domain/platform-error.ts'

import type {
	Approval,
	ApprovalCircleCI,
	ApprovalEvent,
	ApprovalGitHub,
	Release,
} from './approval-record.ts'

export class ApprovalDenied extends PlatformError {
	readonly status = 403
}

export class ApprovalUnavailable extends PlatformError {
	readonly status = 503
}

export async function authorizeApproval(
	event: ApprovalEvent,
	github: ApprovalGitHub,
	circle: ApprovalCircleCI,
): Promise<void> {
	const approval = await github.load(event.check_run.id)
	if (approval.repository !== event.repository.full_name)
		throw new ApprovalDenied('The approval belongs to another repository')
	const actor = await github.actor(event.sender.id)
	await github.requireMember(actor)
	await github.requireCurrent(approval.record)
	await circle.requireRelease(approval.record, approval.repository)
	await github.record(approval, actor)
	await circle.approve(approval.record)
}

export async function verifyProductionApproval(
	release: Release,
	approval: Approval,
	github: ApprovalGitHub,
): Promise<void> {
	if (
		approval.record.workflow !== release.workflow ||
		approval.record.project !== release.project ||
		approval.record.revision !== release.revision ||
		approval.record.pull !== release.pull
	) {
		throw new ApprovalDenied(
			'The GitHub approval does not identify this workflow, project, revision and pull request',
		)
	}
	if (
		approval.check.status !== 'completed' ||
		approval.check.conclusion !== 'success' ||
		!approval.record.approver
	) {
		throw new ApprovalDenied(
			'Production requires a successful GitHub approval',
		)
	}
	await github.requireCurrent(approval.record)
	await github.requireMember(await github.actor(approval.record.approver))
}
