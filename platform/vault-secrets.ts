import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { emitExports } from './src/adapters/shell/exports.ts'
import { PlatformError } from './src/domain/platform-error.ts'
import { PlatformSecrets } from './src/domain/vault/platform-secrets.ts'
import { decodeOr } from './src/lib/decode.ts'

class VaultExportError extends PlatformError {}

const MISSING_SECRET = '*not found*'

function isScope(scope: string): scope is keyof typeof PlatformSecrets {
	return Object.hasOwn(PlatformSecrets, scope)
}

function secret(
	key: string,
	project: string,
	domain: string,
): { key: string; value: string } {
	const response = spawnSync(
		'infisical',
		[
			'--domain',
			domain,
			'secrets',
			'get',
			key,
			'--projectId',
			project,
			'--env',
			'main',
			'--plain',
			'--silent',
		],
		{ encoding: 'utf8', cwd: import.meta.dirname },
	)
	if (response.error || response.status !== 0)
		throw new VaultExportError(
			`Cannot obtain required platform credential ${key}`,
		)
	const value = response.stdout.replace(/\r?\n$/, '')
	// The CLI reports a missing key as this placeholder even when it exits successfully.
	if (value === MISSING_SECRET)
		throw new VaultExportError(
			`Missing required platform credential ${key}`,
		)
	return { key, value }
}

function main(): void {
	const { values } = parseArgs({
		options: {
			scope: { type: 'string' },
			format: { type: 'string', default: 'shell' },
		},
	})
	const project = process.env.INFISICAL_PLATFORM_PROJECT_ID
	const domain = process.env.INFISICAL_DOMAIN
	if (
		!values.scope ||
		!isScope(values.scope) ||
		!project ||
		!domain ||
		!process.env.INFISICAL_TOKEN ||
		!['shell', 'json'].includes(values.format)
	) {
		throw new VaultExportError(
			`--scope ${Object.keys(PlatformSecrets).join('|')}, --format shell|json, INFISICAL_PLATFORM_PROJECT_ID, INFISICAL_DOMAIN and INFISICAL_TOKEN are required`,
		)
	}
	const secrets = Object.keys(PlatformSecrets[values.scope].entries).map(
		key => secret(key, project, domain),
	)
	const credentials = decodeOr(
		PlatformSecrets[values.scope],
		Object.fromEntries(secrets.map(({ key, value }) => [key, value])),
		fields =>
			new VaultExportError(`Invalid required credentials: ${fields}`),
		'credentials',
	)
	if (values.format === 'json') {
		console.error(
			`${values.scope} credentials: ${secrets.map(({ key }) => key).join(', ')}`,
		)
		process.stdout.write(JSON.stringify(credentials))
		return
	}
	emitExports(secrets)
}

try {
	main()
} catch (error) {
	console.error(
		PlatformError.describe(
			error,
			'Scoped platform credential export failed',
		),
	)
	process.exitCode = 1
}
