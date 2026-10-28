import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import * as automation from '@pulumi/pulumi/automation/index.js'
import * as v from 'valibot'

import { RecordSchema } from './record.ts'

export function requiredEnvironment(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

const TOKEN_VERIFY_TIMEOUT_MS = 15_000

async function cloudflareTokenId(token: string): Promise<string> {
	const response = await fetch(
		'https://api.cloudflare.com/client/v4/user/tokens/verify',
		{
			headers: { authorization: `Bearer ${token}` },
			redirect: 'error',
			signal: AbortSignal.timeout(TOKEN_VERIFY_TIMEOUT_MS),
		},
	)
	const body: unknown = await response.json()
	if (
		!v.is(RecordSchema, body) ||
		body.success !== true ||
		!v.is(RecordSchema, body.result) ||
		typeof body.result.id !== 'string'
	) {
		throw new Error(
			`Cloudflare did not verify the token (HTTP ${response.status})`,
		)
	}
	return body.result.id
}

type StackOptions = {
	project: string
	environment: string
	work: string
	program: (accountId: string) => Promise<Record<string, unknown>>
}

export async function platformStack(
	options: StackOptions,
): Promise<automation.Stack> {
	mkdirSync(options.work, { recursive: true, mode: 0o700 })
	const token = requiredEnvironment('CLOUDFLARE_API_TOKEN')
	const accountId = requiredEnvironment('CLOUDFLARE_ACCOUNT_ID')
	const bucket = requiredEnvironment('NEXTNODE_STATE_BUCKET')
	return automation.LocalWorkspace.createOrSelectStack(
		{
			stackName: options.environment,
			projectName: options.project,
			program: () => options.program(accountId),
		},
		{
			workDir: options.work,
			secretsProvider: 'passphrase',
			projectSettings: {
				name: options.project,
				runtime: 'nodejs',
				backend: {
					url: `s3://${bucket}?endpoint=${accountId}.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true`,
				},
			},
			envVars: {
				// R2 requires the Cloudflare token ID and the SHA-256 of its value as S3 credentials.
				AWS_ACCESS_KEY_ID: await cloudflareTokenId(token),
				AWS_SECRET_ACCESS_KEY: createHash('sha256')
					.update(token)
					.digest('hex'),
				AWS_REGION: 'auto',
				PULUMI_CONFIG_PASSPHRASE: requiredEnvironment(
					'PULUMI_CONFIG_PASSPHRASE',
				),
				CLOUDFLARE_API_TOKEN: token,
			},
		},
	)
}
