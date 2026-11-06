import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import { Refusal } from '../../domain/refusal.ts'

function readSource(root: string): string {
	let descriptor: number | undefined
	try {
		descriptor = openSync(
			join(root, 'nextnode.toml'),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		if (!fstatSync(descriptor).isFile())
			throw new Refusal(
				'nextnode.toml must be a regular file at the repository root',
			)
		return readFileSync(descriptor, 'utf8')
	} catch (error) {
		if (error instanceof Refusal) throw error
		throw new Refusal(
			'nextnode.toml must be a readable regular file at the repository root, not a link',
		)
	} finally {
		if (typeof descriptor !== 'undefined') closeSync(descriptor)
	}
}

// The parser's own message quotes the file, which the job log must never hold.
export function readNextnodeToml(root: string): unknown {
	const source = readSource(root)
	try {
		return parseToml(source)
	} catch {
		throw new Refusal(
			'nextnode.toml is not valid TOML; fix its syntax and rerun checks',
		)
	}
}
