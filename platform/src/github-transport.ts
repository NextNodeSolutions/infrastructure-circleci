import * as v from 'valibot'

import { PlatformError } from './domain/platform-error.ts'

const API = 'https://api.github.com'
// Release verification needs merge_commit_sha, removed in REST 2026-03-10.
const API_VERSION = '2022-11-28'
const TIMEOUT_MS = 15_000
const READ_ATTEMPTS = 3
const RETRY_DELAY_MS = 1_000
const HTTP_SERVER_ERROR = 500
const HTTP_NOT_FOUND = 404
export class ReportingError extends PlatformError {
	readonly status: number | undefined
	constructor(message: string, status?: number) {
		super(message)
		this.status = status
	}
}

export function decode<TSchema extends v.GenericSchema>(
	schema: TSchema,
	input: unknown,
): v.InferOutput<TSchema> {
	const parsed = v.safeParse(schema, input)
	if (!parsed.success)
		throw new ReportingError(
			`Invalid GitHub configuration or response fields: ${parsed.issues.map(issue => v.getDotPath(issue) ?? 'response').join(', ')}`,
		)
	return parsed.output
}

export function isNotFound(error: unknown): boolean {
	return error instanceof ReportingError && error.status === HTTP_NOT_FOUND
}

function isRetryableRead(
	method: string,
	attempt: number,
	error: unknown,
): boolean {
	if (method !== 'GET' || attempt >= READ_ATTEMPTS) return false
	return (
		error instanceof ReportingError &&
		(error.status ?? 0) >= HTTP_SERVER_ERROR
	)
}

function encoded(body: object | undefined): { body: string } | undefined {
	if (!body) return undefined
	return { body: JSON.stringify(body) }
}

type Call = {
	authorization: string
	path: string
	method: string
	body: object | undefined
}

export function request(
	authorization: string,
	path: string,
	method: string,
	body?: object,
): Promise<unknown> {
	return attempt({ authorization, path, method, body }, 1)
}

// A failed read is retried a bounded number of times, so one HTTP 500 does not fail a release.
async function attempt(call: Call, count: number): Promise<unknown> {
	try {
		return await send(call)
	} catch (error) {
		if (!isRetryableRead(call.method, count, error)) throw error
		await new Promise(resolve =>
			setTimeout(resolve, RETRY_DELAY_MS * count),
		)
		return attempt(call, count + 1)
	}
}

async function send(call: Call): Promise<unknown> {
	const { authorization, path, method, body } = call
	try {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${authorization}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': API_VERSION,
				'Content-Type': 'application/json',
				'User-Agent': 'nextnode-ci-checks',
			},
			...encoded(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		if (!response.ok)
			throw new ReportingError(
				`GitHub reporting failed: ${method} ${path} returned HTTP ${response.status}`,
				response.status,
			)
		return await response.json()
	} catch (error) {
		if (error instanceof ReportingError) throw error
		throw new ReportingError(
			`GitHub reporting could not complete its API request: ${error instanceof Error ? error.message : 'unknown error'}`,
		)
	}
}
