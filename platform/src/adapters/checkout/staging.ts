// A link could name a file of the platform or of a process, and a hard link shares its
// content with a file the project may rewrite. Only directories and regular files with a
// single link are copied, each opened without following a link. The copy is made once
// every process of the project user has ended, so nothing changes a file between its
// check and its copy.
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { Refusal } from '../../domain/refusal.ts'
import { within } from '../../lib/paths.ts'

import type { Staging } from '../../application/ports/staging.ts'

function copy(from: string, to: string): void {
	if (lstatSync(from).isDirectory()) {
		mkdirSync(to)
		for (const entry of readdirSync(from))
			copy(join(from, entry), join(to, entry))
		return
	}
	let fd: number
	try {
		fd = openSync(
			from,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
	} catch {
		throw new Refusal(
			`${from} is refused: only directories and regular files are uploaded, never a link`,
		)
	}
	const stat = fstatSync(fd)
	if (!stat.isFile() || stat.nlink !== 1)
		throw new Refusal(
			`${from} is refused: only regular files with a single link are uploaded`,
		)
	writeFileSync(to, readFileSync(fd))
	closeSync(fd)
}

export function checkoutStaging(checkoutPath: string, out: string): Staging {
	const checkout = realpathSync(checkoutPath)
	return {
		clear(): void {
			rmSync(out, { recursive: true, force: true })
			mkdirSync(out)
		},
		// A directory of the checkout, reached through no link, copied whole.
		stage(directory: string, name: string): string {
			const path = resolve(checkout, directory)
			if (!within(checkout, path) || realpathSync(path) !== path)
				throw new Refusal(
					`${directory} is refused: it must lie in the checkout, reached through no link`,
				)
			const to = join(out, name)
			copy(path, to)
			return to
		},
	}
}
