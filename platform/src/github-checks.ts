import * as v from 'valibot'

import { PAGE_SIZE, PositiveId, Pull, Revision } from './github-api.ts'
import { decode, ReportingError } from './github-transport.ts'

import type { Environment } from './domain/configuration/nextnode-toml.ts'
import type { GitHubApi } from './github-api.ts'

const Check = v.object({
	id: PositiveId,
	external_id: v.nullable(v.string()),
	app: v.object({ id: PositiveId }),
})
export type Report = {
	environment: Environment
	summary: string
	url?: string | undefined
} & (
	| { status: 'queued' | 'in_progress' }
	| { status: 'completed'; conclusion: 'success' | 'failure' | 'skipped' }
)

function isFailure(report: Report): boolean {
	return report.status === 'completed' && report.conclusion === 'failure'
}

// A failed deployment links to the main-branch workflow, so the failed job stays readable in GitHub.
function detailsUrlOf(
	repository: string,
	revision: string,
	report: Report,
): string | undefined {
	if (isFailure(report))
		return `https://github.com/${repository}/commit/${revision}/checks`
	return report.url
}

function summaryOf(report: Report, detailsUrl: string | undefined): string {
	if (isFailure(report))
		return `${report.summary}\n\n[Open the main-branch workflow](${detailsUrl}) to read the failed job.`
	if (!report.url) return report.summary
	return `${report.summary}\n\n[Open ${report.environment}](${report.url})`
}

function headOf(
	existing: { id: number } | undefined,
	sha: string,
): { head_sha: string } | undefined {
	if (existing) return undefined
	return { head_sha: sha }
}

function detailsOf(
	detailsUrl: string | undefined,
): { details_url: string } | undefined {
	if (!detailsUrl) return undefined
	return { details_url: detailsUrl }
}

function completionOf(
	report: Report,
): { conclusion: string; completed_at: string } | undefined {
	if (report.status !== 'completed') return undefined
	return {
		conclusion: report.conclusion,
		completed_at: new Date().toISOString(),
	}
}

function startOf(report: Report): { started_at: string } | undefined {
	if (report.status !== 'in_progress') return undefined
	return { started_at: new Date().toISOString() }
}

export class GitHubChecks {
	private readonly api: GitHubApi
	constructor(api: GitHubApi) {
		this.api = api
	}

	async mergedPull(revision: string): Promise<Pull> {
		decode(Revision, revision)
		const pulls = decode(
			v.array(Pull),
			await this.api.read(
				`/repos/${this.api.repository}/commits/${revision}/pulls?per_page=${PAGE_SIZE}`,
			),
		)
		const merged = pulls.filter(
			pull =>
				pull.merged_at &&
				pull.merge_commit_sha === revision &&
				pull.base.ref === 'main' &&
				pull.base.repo.full_name === this.api.repository,
		)
		const pull = merged[0]
		if (merged.length !== 1 || !pull)
			throw new ReportingError(
				"The deployment commit must identify exactly one merged pull request targeting this repository's main",
			)
		return pull
	}

	private async checks(
		head: string,
		query: Record<string, string>,
	): Promise<v.InferOutput<typeof Check>[]> {
		return decode(v.array(Check), await this.api.checks(head, query))
	}

	async publish(
		pull: Pull,
		revision: string,
		workflow: string,
		report: Report,
	): Promise<void> {
		const name = `Deploy ${report.environment}`
		const externalId = `nextnode/${workflow}/${report.environment}`
		const checks = await this.checks(pull.head.sha, {
			check_name: name,
			app_id: String(this.api.appId),
			filter: 'all',
		})
		const matching = checks.filter(
			check =>
				check.app.id === this.api.appId &&
				check.external_id === externalId,
		)
		if (matching.length > 1)
			throw new ReportingError(
				'Multiple checks identify the same deployment workflow',
			)
		const existing = matching[0]
		const detailsUrl = detailsUrlOf(this.api.repository, revision, report)
		const body = {
			name,
			external_id: externalId,
			status: report.status,
			...headOf(existing, pull.head.sha),
			...detailsOf(detailsUrl),
			...completionOf(report),
			...startOf(report),
			output: {
				title: report.summary,
				summary: summaryOf(report, detailsUrl),
			},
		}
		await this.api.write(
			`/repos/${this.api.repository}/check-runs${existing ? `/${existing.id}` : ''}`,
			existing ? 'PATCH' : 'POST',
			body,
		)
		console.log(
			`${name}: ${report.status === 'completed' ? report.conclusion : report.status} https://github.com/${this.api.repository}/pull/${pull.number}/checks`,
		)
	}
}
