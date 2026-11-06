// What the approval use case needs from GitHub and from CircleCI, implemented by the adapters.
import type {
	Actor,
	Approval,
	ApprovalRecord,
	Release,
} from '../../domain/approval/record.ts'

export interface ApprovalGitHub {
	load(checkId: number): Promise<Approval>
	actor(id: number): Promise<Actor>
	requireCurrent(record: ApprovalRecord): Promise<void>
	requireMember(actor: Actor): Promise<void>
	record(approval: Approval, actor: Actor): Promise<void>
}

export interface ApprovalCircleCI {
	requireRelease(release: ApprovalRecord, repository: string): Promise<void>
	approve(release: Release): Promise<void>
}
