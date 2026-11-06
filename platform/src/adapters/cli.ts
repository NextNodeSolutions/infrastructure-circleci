import { Refusal } from '../domain/refusal.ts'
import { Resources } from '../domain/vault/platform-secrets.ts'
import { decodeOr } from '../lib/decode.ts'

// Runs a step program: a refusal prints its message alone and exits 1, any other error
// stays a crash with its stack.
export function refusing<T>(step: () => T): T {
	try {
		return step()
	} catch (error) {
		if (!(error instanceof Refusal)) throw error
		process.stderr.write(`${error.message}\n`)
		process.exit(1)
	}
}

export function env(name: string): string {
	const setting = process.env[name]
	if (!setting) throw new Error(`${name} is not set`)
	return setting
}

export type PlatformCredentials = {
	token: string
	accountId: string
	passphrase: string
	bucket: string
}

// What a job exports from the vault's resources scope, and the state bucket it names.
export function platformCredentials(): PlatformCredentials {
	const resources = decodeOr(
		Resources,
		process.env,
		fields => new Error(`${fields}: the resources scope is not exported`),
		'environment',
	)
	return {
		token: resources.CLOUDFLARE_API_TOKEN,
		accountId: resources.CLOUDFLARE_ACCOUNT_ID,
		passphrase: resources.PULUMI_CONFIG_PASSPHRASE,
		bucket: env('NEXTNODE_STATE_BUCKET'),
	}
}
