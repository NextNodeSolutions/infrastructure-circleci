// The state lives in the platform's R2 bucket, behind Pulumi's S3 backend. R2's S3 API
// accepts the API token itself as a key pair: the token's id as access key and the
// token's SHA-256 as secret key. One credential creates the resources and keeps their state.
import { createHash } from 'node:crypto'

import * as v from 'valibot'

import { decodeOr } from '../../lib/decode.ts'
import { requestJson } from '../http.ts'

const Verification = v.object({
	success: v.literal(true),
	result: v.object({ id: v.string() }),
})

export type StateBackend = { url: string; env: Record<string, string> }

export type StateBucket = { token: string; accountId: string; bucket: string }

async function tokenId(token: string): Promise<string> {
	const body = await requestJson(
		'https://api.cloudflare.com/client/v4/user/tokens/verify',
		{ headers: { authorization: `Bearer ${token}` } },
		failure =>
			new Error(
				'status' in failure
					? `Cloudflare did not verify the token (HTTP ${failure.status})`
					: `Cloudflare token verification did not complete: ${failure.cause}`,
			),
	)
	return decodeOr(
		Verification,
		body,
		fields => new Error(`Cloudflare did not verify the token: ${fields}`),
	).result.id
}

export async function r2StateBackend(
	state: StateBucket,
): Promise<StateBackend> {
	const { token, accountId, bucket } = state
	return {
		url: `s3://${bucket}?endpoint=${accountId}.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true`,
		env: {
			AWS_ACCESS_KEY_ID: await tokenId(token),
			AWS_SECRET_ACCESS_KEY: createHash('sha256')
				.update(token)
				.digest('hex'),
			AWS_REGION: 'auto',
		},
	}
}
