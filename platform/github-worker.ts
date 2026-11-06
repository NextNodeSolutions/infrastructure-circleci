import * as v from 'valibot'

import { ApprovalEvent } from './src/approval-record.ts'
import {
	ApprovalDenied,
	ApprovalUnavailable,
	authorizeApproval,
} from './src/authorize-approval.ts'
import { CircleApproval } from './src/circle-approval.ts'
import { PlatformError } from './src/domain/platform-error.ts'
import { GITHUB_WEBHOOK } from './src/domain/service/approval-service.ts'
import { GitHubApi } from './src/github-api.ts'
import { GitHubApproval } from './src/github-approval.ts'
import { WorkerSecrets } from './src/github-service-config.ts'
import { decode } from './src/github-transport.ts'
import { verifyWebhook } from './src/verify-webhook.ts'

const HTTP_NOT_FOUND = 404
const HTTP_FORBIDDEN = 403
const HTTP_SERVICE_UNAVAILABLE = 503
const FAILURE = 'Approval service operation failed'
const RequestedAction = v.looseObject({ action: v.literal('requested_action') })

function isHealthRequest(request: Request, url: URL): boolean {
	return request.method === 'GET' && url.pathname === '/health'
}

function isWebhookRequest(request: Request, url: URL): boolean {
	return request.method === 'POST' && url.pathname === GITHUB_WEBHOOK.pathname
}

// The check_run event that asks for the approval, or undefined for any other check_run event.
function approvalEventOf(
	payload: unknown,
	secrets: WorkerSecrets,
): ApprovalEvent | undefined {
	if (!v.is(RequestedAction, payload)) return undefined
	const parsed = v.safeParse(ApprovalEvent, payload)
	if (!parsed.success)
		throw new ApprovalDenied('The requested approval event is malformed')
	if (
		String(parsed.output.installation.id) !==
		secrets.GITHUB_APP_INSTALLATION_ID
	)
		throw new ApprovalDenied(
			'The approval installation does not match this GitHub App',
		)
	return parsed.output
}

async function approve(
	event: ApprovalEvent,
	secrets: WorkerSecrets,
): Promise<void> {
	const api = await GitHubApi.connect(
		secrets,
		event.repository.name,
		'approve',
	)
	const github = new GitHubApproval(api)
	try {
		await authorizeApproval(
			event,
			github,
			new CircleApproval(secrets.CIRCLECI_TOKEN),
		)
	} catch (error) {
		await github
			.notifyFailure(
				event.check_run.id,
				PlatformError.describe(error, FAILURE),
			)
			.catch(() => {
				console.error(
					JSON.stringify({
						event: 'approval-report-failed',
						check: event.check_run.id,
					}),
				)
			})
		throw error
	}
	console.log(
		JSON.stringify({
			event: 'production-approved',
			repository: api.repository,
			check: event.check_run.id,
			actor: event.sender.id,
		}),
	)
}

async function webhook(
	request: Request,
	url: URL,
	secrets: WorkerSecrets,
): Promise<Response> {
	const payload = await verifyWebhook(request, secrets.GITHUB_WEBHOOK_SECRET)
	const eventName = request.headers.get('x-github-event')
	if (eventName === 'ping') return Response.json({ accepted: true })
	if (url.origin !== GITHUB_WEBHOOK.origin)
		throw new ApprovalDenied(
			'Production approvals require the configured webhook origin',
		)
	if (eventName !== 'check_run') return Response.json({ ignored: true })
	const event = approvalEventOf(payload, secrets)
	if (!event) return Response.json({ ignored: true })
	await approve(event, secrets)
	return Response.json({ approved: true })
}

function refused(error: unknown): Response {
	const status =
		error instanceof ApprovalDenied || error instanceof ApprovalUnavailable
			? error.status
			: HTTP_SERVICE_UNAVAILABLE
	const reason = PlatformError.describe(error, FAILURE)
	console.error(JSON.stringify({ event: 'approval-refused', status, reason }))
	const message =
		status === HTTP_FORBIDDEN
			? 'Approval refused'
			: 'Approval could not complete. Retry from GitHub.'
	return Response.json({ approved: false, error: message }, { status })
}

// The Workers runtime loads the handler as the module's default export.
export default {
	async fetch(request: Request, bindings: WorkerSecrets): Promise<Response> {
		const url = new URL(request.url)
		const isHealth = isHealthRequest(request, url)
		if (!isHealth && !isWebhookRequest(request, url))
			return new Response('Not found', { status: HTTP_NOT_FOUND })
		try {
			const secrets = decode(WorkerSecrets, bindings)
			if (isHealth) {
				GitHubApi.verifySigning(secrets)
				return Response.json({ ok: true })
			}
			return await webhook(request, url, secrets)
		} catch (error) {
			return refused(error)
		}
	},
}
