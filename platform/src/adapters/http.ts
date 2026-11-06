export const REQUEST_TIMEOUT_MS = 15_000

export type RequestFailure = { status: number } | { cause: string }

// One JSON request with the platform's timeout, following no redirect. A refused status or
// a request that did not complete becomes the error the caller builds, so each client keeps
// its own error class and wording.
export async function requestJson(
	url: string | URL,
	init: RequestInit,
	fail: (failure: RequestFailure) => Error,
): Promise<unknown> {
	let response: Response
	let body: unknown
	try {
		response = await fetch(url, {
			...init,
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		body = response.ok ? await response.json() : undefined
	} catch (error) {
		throw fail({
			cause: error instanceof Error ? error.message : 'unknown error',
		})
	}
	if (!response.ok) throw fail({ status: response.status })
	return body
}
