import { readFileSync } from 'node:fs'

import * as v from 'valibot'

import type { Upload } from '../../domain/deployment/upload.ts'

const Entry = v.looseObject({ type: v.string() })
const VersionUpload = v.object({
	version_id: v.string(),
	preview_url: v.optional(v.string()),
})
const Deploy = v.object({ targets: v.optional(v.array(v.string()), []) })

// What Wrangler wrote to its output file during the deployment step: one JSON entry per
// line, one per command it ran.
export function readUpload(path: string): Upload {
	const entries = readFileSync(path, 'utf8')
		.split('\n')
		.filter(line => line !== '')
		.map(line => v.parse(Entry, JSON.parse(line)))
	const uploaded = entries.find(entry => entry.type === 'version-upload')
	if (uploaded) {
		const { version_id, preview_url } = v.parse(VersionUpload, uploaded)
		if (!preview_url)
			throw new Error(
				'Wrangler reported no preview URL: the production Worker needs preview_urls',
			)
		return { kind: 'version', version: version_id, previewUrl: preview_url }
	}
	const deployed = entries.find(entry => entry.type === 'deploy')
	if (!deployed)
		throw new Error(
			'Wrangler reported neither a deployment nor a version upload',
		)
	return { kind: 'direct', targets: v.parse(Deploy, deployed).targets }
}
