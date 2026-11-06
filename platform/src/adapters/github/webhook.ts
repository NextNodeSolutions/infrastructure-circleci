import { createHmac, timingSafeEqual } from 'node:crypto'

import { ApprovalDenied } from '../../domain/approval/errors.ts'

const BYTES_PER_KIB = 1024
const MAX_BODY_KIB = 256
const MAX_BODY_BYTES = MAX_BODY_KIB * BYTES_PER_KIB

async function limitedBody(request: Request): Promise<Buffer> {
	const reader = request.body?.getReader()
	if (!reader) throw new ApprovalDenied('Webhook body is missing')
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const chunk = await reader.read()
		if (chunk.done) return Buffer.concat(chunks)
		size += chunk.value.byteLength
		if (size > MAX_BODY_BYTES) {
			await reader.cancel()
			throw new ApprovalDenied('Webhook body exceeds the permitted size')
		}
		chunks.push(chunk.value)
	}
}

export async function verifyWebhook(
	request: Request,
	secret: string,
): Promise<unknown> {
	const signature = request.headers.get('x-hub-signature-256')
	if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
		throw new ApprovalDenied('Webhook signature is required')
	const body = await limitedBody(request)
	const expected = createHmac('sha256', secret).update(body).digest()
	if (
		!timingSafeEqual(
			expected,
			Buffer.from(signature.slice('sha256='.length), 'hex'),
		)
	)
		throw new ApprovalDenied('Webhook signature is invalid')
	try {
		return JSON.parse(body.toString('utf8'))
	} catch {
		throw new ApprovalDenied('Webhook body must be valid JSON')
	}
}
