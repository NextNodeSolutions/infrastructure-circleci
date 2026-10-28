// Turns the vault's JSON export, read on stdin, into shell exports on stdout, one per
// secret, each value a single-quoted literal. The names go to stderr for the job log;
// the values never do.
import { text } from 'node:stream/consumers'

import * as v from 'valibot'

import { RecordSchema } from './src/record.ts'

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const exported: unknown = JSON.parse(await text(process.stdin))
if (!Array.isArray(exported))
	throw new Error('the vault export is not a JSON array')
const secrets = exported.map((entry: unknown) => {
	if (
		!v.is(RecordSchema, entry) ||
		typeof entry.key !== 'string' ||
		typeof entry.value !== 'string'
	)
		throw new Error(
			'the vault export holds an entry without a key and a value',
		)
	if (!SHELL_NAME.test(entry.key))
		throw new Error(
			`secret name ${JSON.stringify(entry.key)} is not a shell variable name`,
		)
	return { key: entry.key, value: entry.value }
})
const literal = (secret: string): string => `'${secret.replace(/'/g, `'\\''`)}'`
process.stdout.write(
	secrets
		.map(({ key, value }) => `export ${key}=${literal(value)}\n`)
		.join(''),
)
process.stderr.write(
	`${secrets.length} secret(s): ${secrets.map(({ key }) => key).join(', ')}\n`,
)
