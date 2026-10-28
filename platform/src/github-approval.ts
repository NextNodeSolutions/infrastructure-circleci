import * as v from 'valibot'

import {
	APPROVAL_ACTION,
	APPROVAL_CHECK,
	APPROVERS_TEAM,
	ApprovalCheck,
	ApprovalRecord,
} from './approval-record.ts'
import { ApprovalDenied } from './authorize-approval.ts'
import { PositiveId, Pull } from './github-api.ts'
import { decode, isNotFound } from './github-transport.ts'

import type {
	Actor,
	Approval,
	ApprovalGitHub,
	Release,
} from './approval-record.ts'
import type { GitHubApi } from './github-api.ts'

const Actor = v.object({
	id: PositiveId,
	login: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/)),
})

export class GitHubApproval implements ApprovalGitHub {
	private readonly api: GitHubApi

	constructor(api: GitHubApi) {
		this.api = api
	}

	private async readApproval(path: string): Promise<unknown> {
		try {
			return await this.api.read(path)
		} catch (error) {
			if (isNotFound(error))
				throw new ApprovalDenied(
					'The approval check or merged pull request no longer exists',
				)
			throw error
		}
	}

	async load(checkId: number): Promise<Approval> {
		const parsed = v.safeParse(
			ApprovalCheck,
			await this.readApproval(
				`/repos/${this.api.repository}/check-runs/${checkId}`,
			),
		)
		if (!parsed.success)
			throw new ApprovalDenied('The approval check is malformed')
		const check = parsed.output
		if (check.app.id !== this.api.appId)
			throw new ApprovalDenied(
				'The approval check belongs to another GitHub App',
			)
		const record = this.recordOf(check.external_id)
		if (!record)
			throw new ApprovalDenied('The approval record is malformed')
		const pull = decode(
			Pull,
			await this.readApproval(
				`/repos/${this.api.repository}/pulls/${record.pull}`,
			),
		)
		return this.approvalOf(check, record, pull)
	}

	async find(release: Release, pull: Pull): Promise<Approval> {
		const matching = await this.existing(release, pull.head.sha)
		if (!matching)
			throw new ApprovalDenied(
				'No GitHub approval exists for this workflow',
			)
		const record = this.recordOf(matching.external_id)
		if (!record)
			throw new ApprovalDenied('The approval record is malformed')
		return this.approvalOf(matching, record, pull)
	}

	private approvalOf(
		check: ApprovalCheck,
		record: ApprovalRecord,
		pull: Pull,
	): Approval {
		if (
			!pull.merged_at ||
			pull.number !== record.pull ||
			pull.merge_commit_sha !== record.revision ||
			pull.head.sha !== check.head_sha ||
			pull.base.ref !== 'main' ||
			pull.base.repo.full_name !== this.api.repository
		) {
			throw new ApprovalDenied(
				'The approval must identify the original merged pull request and its deployment revision',
			)
		}
		return { check, record, repository: this.api.repository }
	}

	private recordOf(encoded: string): ApprovalRecord | undefined {
		try {
			const parsed = v.safeParse(ApprovalRecord, JSON.parse(encoded))
			if (!parsed.success) return undefined
			return parsed.output
		} catch {
			return undefined
		}
	}

	private async existing(
		release: Release,
		head: string,
	): Promise<ApprovalCheck | undefined> {
		const checks = decode(
			v.array(ApprovalCheck),
			await this.api.checks(head, {
				check_name: APPROVAL_CHECK,
				app_id: String(this.api.appId),
				filter: 'all',
			}),
		)
		const matching = checks.filter(
			check =>
				check.app.id === this.api.appId &&
				this.recordOf(check.external_id)?.workflow === release.workflow,
		)
		if (matching.length > 1)
			throw new ApprovalDenied(
				'Multiple approval checks identify the same workflow',
			)
		return matching[0]
	}

	async create(release: Release, head: string): Promise<void> {
		if (await this.existing(release, head)) return
		await this.api.write(
			`/repos/${this.api.repository}/check-runs`,
			'POST',
			{
				name: APPROVAL_CHECK,
				head_sha: head,
				external_id: JSON.stringify(release),
				status: 'completed',
				conclusion: 'neutral',
				completed_at: new Date().toISOString(),
				output: {
					title: 'Production is waiting for approval',
					summary: `**Approve production** releases this pull request to production; the deployment then follows in the **Deploy production** check.\n\nOnly active members of the GitHub team \`${APPROVERS_TEAM}\` can approve.`,
				},
				actions: [
					{
						label: 'Approve production',
						description: 'Release this pull request to production',
						identifier: APPROVAL_ACTION,
					},
				],
			},
		)
	}

	async notifyFailure(checkId: number, reason: string): Promise<void> {
		const check = decode(
			ApprovalCheck,
			await this.readApproval(
				`/repos/${this.api.repository}/check-runs/${checkId}`,
			),
		)
		if (check.app.id !== this.api.appId)
			throw new ApprovalDenied(
				'The approval check belongs to another GitHub App',
			)
		const record = this.recordOf(check.external_id)
		if (!record)
			throw new ApprovalDenied('The approval record is malformed')
		if (record.approver) return
		await this.api.write(
			`/repos/${this.api.repository}/check-runs/${check.id}`,
			'PATCH',
			{
				output: {
					title: 'Approval was not accepted',
					summary: `${reason}\n\nOnce the cause is fixed, **Approve production** can be used again.`,
				},
			},
		)
	}

	async actor(id: number): Promise<Actor> {
		const actor = decode(Actor, await this.api.read(`/user/${id}`))
		if (actor.id !== id)
			throw new ApprovalDenied('GitHub returned another approval actor')
		return actor
	}

	async requireCurrent(record: ApprovalRecord): Promise<void> {
		const pulls = decode(
			v.array(Pull),
			await this.readApproval(
				`/repos/${this.api.repository}/commits/main/pulls`,
			),
		)
		const isCurrent = pulls.some(
			pull =>
				pull.merged_at &&
				pull.number === record.pull &&
				pull.merge_commit_sha === record.revision &&
				pull.base.ref === 'main' &&
				pull.base.repo.full_name === this.api.repository,
		)
		if (!isCurrent)
			throw new ApprovalDenied(
				'The pull request has been superseded on main: rerun the workflow from the new head for a new approval',
			)
	}

	async requireMember(actor: Actor): Promise<void> {
		try {
			const membership = decode(
				v.object({ state: v.picklist(['active', 'pending']) }),
				await this.api.read(
					`/orgs/${this.api.owner}/teams/${APPROVERS_TEAM}/memberships/${actor.login}`,
				),
			)
			if (membership.state !== 'active')
				throw new ApprovalDenied(
					'Active GitHub Core membership is required',
				)
		} catch (error) {
			if (isNotFound(error))
				throw new ApprovalDenied(
					'Active GitHub Core membership is required',
				)
			throw error
		}
	}

	async record(approval: Approval, actor: Actor): Promise<void> {
		await this.api.write(
			`/repos/${this.api.repository}/check-runs/${approval.check.id}`,
			'PATCH',
			{
				external_id: JSON.stringify({
					...approval.record,
					approver: actor.id,
				}),
				status: 'completed',
				conclusion: 'success',
				output: {
					title: `Production approved by @${actor.login}`,
					summary: `@${actor.login} is an active member of the GitHub team \`${APPROVERS_TEAM}\`. Production is deploying; follow it in the **Deploy production** check.\n\nIf that check does not start, **Retry release** resumes the approved release.`,
				},
				actions: [
					{
						label: 'Retry release',
						description: 'Resume the approved release',
						identifier: APPROVAL_ACTION,
					},
				],
			},
		)
	}
}
