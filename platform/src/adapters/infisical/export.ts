import * as v from 'valibot'

import type { Secret } from '../../domain/vault/secret.ts'

const ENTRY = 'the vault export holds an entry without a key and a value'
const Export = v.array(
	v.object({ key: v.string(ENTRY), value: v.string(ENTRY) }, ENTRY),
	'the vault export is not a JSON array',
)

// The JSON export of the Infisical CLI. It holds the secret values, and an error reaches
// the job log, so no error quotes the input as JSON.parse's and valibot's own messages do.
export function secretsOf(json: string): Secret[] {
	let exported: unknown
	try {
		exported = JSON.parse(json)
	} catch {
		throw new Error('the vault export is not JSON')
	}
	const parsed = v.safeParse(Export, exported)
	if (!parsed.success) throw new Error(parsed.issues[0].message)
	return parsed.output
}
