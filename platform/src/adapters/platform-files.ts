// The JSON files a step writes in the platform's directory for the steps after it.
import { readFileSync, writeFileSync } from 'node:fs'

import { parseSpec } from '../domain/configuration/spec.ts'
import { PlatformError } from '../domain/platform-error.ts'

import type { Spec } from '../domain/configuration/spec.ts'

export function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeJson(path: string, json: unknown): void {
	writeFileSync(path, JSON.stringify(json))
}

export function readSpec(path: string): Spec {
	let json: unknown
	try {
		json = readJson(path)
	} catch {
		throw new PlatformError(
			`${path}: a readable JSON deployment spec is required. Regenerate it with the read step.`,
		)
	}
	return parseSpec(json, path)
}
