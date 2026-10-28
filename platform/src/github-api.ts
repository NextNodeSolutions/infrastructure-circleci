import { createPrivateKey, sign } from 'node:crypto'

import * as v from 'valibot'

import { decode, ReportingError, request } from './github-transport.ts'
import { PROJECT_NAME } from './project-name.ts'
import { SECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from './time.ts'

const JWT_MINUTES = 9
const JWT_SECONDS = JWT_MINUTES * SECONDS_PER_MINUTE
const CLOCK_SKEW_SECONDS = 60
export const PAGE_SIZE = 100
const REPORT_PERMISSIONS = { checks: 'write', pull_requests: 'read' } as const
const APPROVAL_PERMISSIONS = { ...REPORT_PERMISSIONS, members: 'read' } as const
const PERMISSIONS = {
	report: REPORT_PERMISSIONS,
	approve: APPROVAL_PERMISSIONS,
	verify: { ...APPROVAL_PERMISSIONS, checks: 'read' },
} as const
export const PositiveId = v.pipe(v.number(), v.integer(), v.minValue(1))
export const Revision = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))
export const Pull = v.object({
	number: PositiveId,
	merged_at: v.nullable(v.string()),
	merge_commit_sha: v.nullable(Revision),
	head: v.object({ sha: Revision }),
	base: v.object({
		ref: v.string(),
		repo: v.object({ full_name: v.string() }),
	}),
})
export type Pull = v.InferOutput<typeof Pull>
export const GitHubCredentials = v.object({
	GITHUB_APP_ID: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
	GITHUB_APP_INSTALLATION_ID: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
	GITHUB_APP_PRIVATE_KEY: v.pipe(v.string(), v.nonEmpty()),
})
const Installation = v.object({
	app_id: PositiveId,
	account: v.object({
		login: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/)),
	}),
	events: v.array(v.string()),
})
const Token = v.object({ token: v.pipe(v.string(), v.nonEmpty()) })

function jwt(credentials: v.InferOutput<typeof GitHubCredentials>): string {
	try {
		const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND)
		const encode = (value: unknown): string =>
			Buffer.from(JSON.stringify(value)).toString('base64url')
		const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - CLOCK_SKEW_SECONDS, exp: now + JWT_SECONDS, iss: credentials.GITHUB_APP_ID })}`
		const signature = sign(
			'RSA-SHA256',
			Buffer.from(unsigned),
			createPrivateKey(credentials.GITHUB_APP_PRIVATE_KEY),
		)
		return `${unsigned}.${signature.toString('base64url')}`
	} catch {
		throw new ReportingError(
			"GITHUB_APP_PRIVATE_KEY must be the GitHub App's valid PEM private key",
		)
	}
}

export class GitHubApi {
	private readonly token: string
	readonly appId: number
	readonly repository: string
	readonly owner: string

	private constructor(
		token: string,
		appId: number,
		owner: string,
		repositoryName: string,
	) {
		this.token = token
		this.appId = appId
		this.owner = owner
		this.repository = `${owner}/${repositoryName}`
	}

	private static async installation(environment: unknown): Promise<{
		authorization: string
		path: string
		installation: v.InferOutput<typeof Installation>
	}> {
		const credentials = decode(GitHubCredentials, environment)
		const authorization = jwt(credentials)
		const path = `/app/installations/${credentials.GITHUB_APP_INSTALLATION_ID}`
		const installation = decode(
			Installation,
			await request(authorization, path, 'GET'),
		)
		if (installation.app_id !== Number(credentials.GITHUB_APP_ID))
			throw new ReportingError(
				'GITHUB_APP_INSTALLATION_ID does not belong to GITHUB_APP_ID',
			)
		return { authorization, path, installation }
	}

	static verifySigning(
		credentials: v.InferOutput<typeof GitHubCredentials>,
	): void {
		jwt(credentials)
	}

	static async verifyAccess(environment: unknown): Promise<void> {
		const { authorization, path, installation } =
			await this.installation(environment)
		if (!installation.events.includes('check_run'))
			throw new ReportingError(
				'The GitHub App installation must subscribe to Check run events',
			)
		decode(
			Token,
			await request(authorization, `${path}/access_tokens`, 'POST', {
				permissions: PERMISSIONS.approve,
			}),
		)
	}

	static async configureWebhook(
		environment: unknown,
		url: URL,
		secret: string,
	): Promise<void> {
		const credentials = decode(GitHubCredentials, environment)
		const configured = await request(
			jwt(credentials),
			'/app/hook/config',
			'PATCH',
			{ url: url.href, content_type: 'json', insecure_ssl: '0', secret },
		)
		decode(
			v.object({
				url: v.literal(url.href),
				content_type: v.literal('json'),
				insecure_ssl: v.literal('0'),
			}),
			configured,
		)
	}

	static async connect(
		environment: unknown,
		repositoryName: string,
		purpose: keyof typeof PERMISSIONS,
	): Promise<GitHubApi> {
		if (!PROJECT_NAME.test(repositoryName))
			throw new ReportingError(
				"CircleCI must supply the repository's name",
			)
		const { authorization, path, installation } =
			await this.installation(environment)
		const access = decode(
			Token,
			await request(authorization, `${path}/access_tokens`, 'POST', {
				repositories: [repositoryName],
				permissions: PERMISSIONS[purpose],
			}),
		)
		return new GitHubApi(
			access.token,
			installation.app_id,
			installation.account.login,
			repositoryName,
		)
	}

	async checks(
		head: string,
		query: Record<string, string>,
	): Promise<unknown[]> {
		const collected: unknown[] = []
		for (let page = 1; ; page++) {
			const parameters = new URLSearchParams({
				...query,
				per_page: String(PAGE_SIZE),
				page: String(page),
			})
			const result = decode(
				v.object({ check_runs: v.array(v.unknown()) }),
				await this.read(
					`/repos/${this.repository}/commits/${head}/check-runs?${parameters}`,
				),
			)
			collected.push(...result.check_runs)
			if (result.check_runs.length < PAGE_SIZE) return collected
		}
	}

	read(path: string): Promise<unknown> {
		return request(this.token, path, 'GET')
	}

	write(
		path: string,
		method: 'POST' | 'PATCH',
		body: object,
	): Promise<unknown> {
		return request(this.token, path, method, body)
	}
}
