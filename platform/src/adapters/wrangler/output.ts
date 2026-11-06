import { readFileSync } from 'node:fs'

import * as v from 'valibot'

import { Refusal } from '../../domain/refusal.ts'
import { decodeOr } from '../../lib/decode.ts'

import type { Upload } from '../../domain/deployment/upload.ts'

const Entry = v.looseObject({ type: v.string() })
const VersionUpload = v.object({
	version_id: v.string(),
	preview_url: v.optional(v.string()),
})
const Deploy = v.object({ targets: v.optional(v.array(v.string()), []) })

function decode<TSchema extends v.GenericSchema>(
	schema: TSchema,
	input: unknown,
): v.InferOutput<TSchema> {
	return decodeOr(
		schema,
		input,
		fields =>
			new Refusal(`Wrangler's output has invalid fields: ${fields}`),
		'entry',
	)
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line)
	} catch {
		throw new Refusal("Wrangler's output holds a line that is not JSON")
	}
}

// What Wrangler wrote to its output file during the deployment step: one JSON entry per
// line, one per command it ran.
export function readUpload(path: string): Upload {
	const entries = readFileSync(path, 'utf8')
		.split('\n')
		.filter(line => line !== '')
		.map(line => decode(Entry, parseLine(line)))
	const uploaded = entries.find(entry => entry.type === 'version-upload')
	if (uploaded) {
		const { version_id, preview_url } = decode(VersionUpload, uploaded)
		if (!preview_url)
			throw new Refusal(
				'Wrangler reported no preview URL: the production Worker needs preview_urls',
			)
		return { kind: 'version', version: version_id, previewUrl: preview_url }
	}
	const deployed = entries.find(entry => entry.type === 'deploy')
	if (!deployed)
		throw new Refusal(
			'Wrangler reported neither a deployment nor a version upload',
		)
	return { kind: 'direct', targets: decode(Deploy, deployed).targets }
}
