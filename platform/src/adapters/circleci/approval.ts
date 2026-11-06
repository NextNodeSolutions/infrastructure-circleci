import * as v from 'valibot'

import {
	ApprovalDenied,
	ApprovalUnavailable,
} from '../../domain/approval/errors.ts'
import { Revision } from '../../domain/approval/record.ts'
import { decodeOr } from '../../lib/decode.ts'
import { requestJson } from '../http.ts'

import type { ApprovalCircleCI } from '../../application/ports/approval.ts'
import type { ApprovalRecord, Release } from '../../domain/approval/record.ts'

const API = 'https://circleci.com/api/v2'
const Workflow = v.object({
	id: v.string(),
	status: v.string(),
	pipeline_id: v.string(),
	project_slug: v.string(),
})
const Project = v.object({ id: v.string(), name: v.string() })
const Checkout = v.object({
	'pipeline.git.branch': v.string(),
	'pipeline.git.revision': Revision,
	'pipeline.git.repo_owner': v.string(),
	'pipeline.git.repo_name': v.string(),
})
const Jobs = v.object({
	items: v.array(
		v.object({
			name: v.string(),
			type: v.string(),
			status: v.string(),
			approval_request_id: v.optional(v.string()),
		}),
	),
})

function decode<TSchema extends v.GenericSchema>(
	schema: TSchema,
	input: unknown,
): v.InferOutput<TSchema> {
	return decodeOr(
		schema,
		input,
		fields =>
			new ApprovalUnavailable(
				`Invalid CircleCI response fields: ${fields}`,
			),
	)
}

export class CircleApproval implements ApprovalCircleCI {
	private readonly token: string

	constructor(token: string) {
		if (!token)
			throw new ApprovalDenied(
				'CIRCLECI_TOKEN is required for the GitHub approval service',
			)
		this.token = token
	}

	private request(path: string, method = 'GET'): Promise<unknown> {
		return requestJson(
			`${API}${path}`,
			{
				method,
				headers: {
					'Circle-Token': this.token,
					'Content-Type': 'application/json',
				},
			},
			failure =>
				new ApprovalUnavailable(
					'status' in failure
						? `CircleCI approval request failed with HTTP ${failure.status}`
						: `CircleCI approval could not complete its API request: ${failure.cause}`,
				),
		)
	}

	async verifyAccess(): Promise<void> {
		await this.request('/me')
	}

	async requireRelease(
		release: ApprovalRecord,
		repository: string,
	): Promise<void> {
		const workflow = decode(
			Workflow,
			await this.request(`/workflow/${release.workflow}`),
		)
		const project = decode(
			Project,
			await this.request(`/project/${workflow.project_slug}`),
		)
		const checkout = decode(
			Checkout,
			await this.request(`/pipeline/${workflow.pipeline_id}/values`),
		)
		const repositoryName = repository.split('/').at(-1)
		const checkoutRepository = `${checkout['pipeline.git.repo_owner']}/${checkout['pipeline.git.repo_name']}`
		if (
			workflow.id !== release.workflow ||
			project.id !== release.project ||
			project.name !== repositoryName ||
			checkoutRepository !== repository ||
			checkout['pipeline.git.branch'] !== 'main' ||
			checkout['pipeline.git.revision'] !== release.revision
		) {
			throw new ApprovalDenied(
				'The CircleCI workflow does not match the approved project and main revision',
			)
		}
		if (!['running', 'on_hold'].includes(workflow.status))
			throw new ApprovalDenied(
				'This workflow has ended; rerun the workflow from the native CircleCI check in GitHub for a new approval',
			)
		const hold = await this.productionHold(release.workflow)
		if (hold.status === 'success' && !release.approver)
			throw new ApprovalDenied(
				'The hold was released without GitHub approval; rerun the workflow from the native CircleCI check in GitHub',
			)
	}

	private async productionHold(
		workflow: string,
	): Promise<v.InferOutput<typeof Jobs>['items'][number]> {
		const jobs = decode(
			Jobs,
			await this.request(`/workflow/${workflow}/job`),
		)
		const holds = jobs.items.filter(job => job.type === 'approval')
		const hold = holds[0]
		if (holds.length !== 1 || !hold)
			throw new ApprovalDenied(
				'The workflow must contain exactly one production approval',
			)
		if (
			hold.status !== 'success' &&
			(hold.status !== 'on_hold' || !hold.approval_request_id)
		)
			throw new ApprovalUnavailable(
				'The production hold is not ready; retry the GitHub approval',
			)
		return hold
	}

	async approve(release: Release): Promise<void> {
		const hold = await this.productionHold(release.workflow)
		if (hold.status === 'success') return
		await this.request(
			`/workflow/${release.workflow}/approve/${hold.approval_request_id}`,
			'POST',
		)
	}
}
