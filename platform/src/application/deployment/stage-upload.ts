import { basename, dirname, join } from 'node:path'

import * as v from 'valibot'

import { WranglerConfig } from '../../domain/configuration/nextnode-toml.ts'
import { Refusal } from '../../domain/refusal.ts'

import type { Staging } from '../ports/staging.ts'

export type UploadRequest = {
	config: unknown
	source: string
	bundle: string
}

export type StagedConfig = Omit<WranglerConfig, 'base_dir' | 'tsconfig'> & {
	base_dir?: string
	no_bundle: true
	upload_source_maps: false
}

type Assets = NonNullable<WranglerConfig['assets']>

// The copy of the bundle, as Wrangler's entry point and module root.
function stagedWorker(
	staging: Staging,
	bundle: string,
): { main: string; base_dir: string } | undefined {
	if (!bundle) return undefined
	const worker = staging.stage(dirname(bundle), 'worker')
	return { main: join(worker, basename(bundle)), base_dir: worker }
}

function stagedAssets(
	staging: Staging,
	assets: WranglerConfig['assets'],
): { assets: Assets } | undefined {
	if (!assets?.directory) return undefined
	return {
		assets: {
			...assets,
			directory: staging.stage(assets.directory, 'assets'),
		},
	}
}

// The Wrangler configuration that uploads the staged copy of the bundle and the assets.
export function stageUpload(
	staging: Staging,
	request: UploadRequest,
): StagedConfig {
	const { config, source, bundle } = request
	const parsed = v.safeParse(WranglerConfig, config)
	if (!parsed.success)
		throw new Refusal(`${source} is not a Wrangler configuration`)
	// The module root and the TypeScript configuration served the bundle, which is built:
	// left in, they would make Wrangler read files the project chose.
	const { base_dir, tsconfig, ...kept } = parsed.output
	staging.clear()
	return {
		...kept,
		no_bundle: true,
		upload_source_maps: false,
		...stagedWorker(staging, bundle),
		...stagedAssets(staging, kept.assets),
	}
}
