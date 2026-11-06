import type { Secret } from '../../domain/vault/secret.ts'

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SecretExports = { exports: string; names: readonly string[] }

const literal = (secret: string): string => `'${secret.replace(/'/g, `'\\''`)}'`

// One shell export per secret, each value a single-quoted literal, so no value of the
// vault ever reaches the shell as code.
export function exportSecrets(secrets: Iterable<Secret>): SecretExports {
	const names: string[] = []
	let exports = ''
	for (const { key, value } of secrets) {
		if (!SHELL_NAME.test(key))
			throw new Error(
				`secret name ${JSON.stringify(key)} is not a shell variable name`,
			)
		names.push(key)
		exports += `export ${key}=${literal(value)}\n`
	}
	return { exports, names }
}
