// Copies the bundle and the static assets of the checkout into the platform's own
// directory, and writes the Wrangler configuration that uploads that copy. Wrangler runs
// there with the Cloudflare credential, so it must read no file the project can point
// it to: a link could name a file of the platform or of a process, and a hard link
// shares its content with a file the project may rewrite. Only directories and regular
// files with a single link are copied, each opened without following a link. Runs once
// every process of the project user has ended, so nothing changes a file between its
// check and its copy. A refusal names the file and exits 1.
//
//   node stage.ts --checkout <directory> --config <generated wrangler.json> --bundle <file of the checkout, or empty> --out <directory>
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
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import * as v from 'valibot'

import { within } from './src/paths.ts'
import { RecordSchema } from './src/record.ts'

const { values: args } = parseArgs({
	options: {
		checkout: { type: 'string' },
		config: { type: 'string' },
		bundle: { type: 'string' },
		out: { type: 'string' },
	},
})
if (
	!args.checkout ||
	!args.config ||
	typeof args.bundle === 'undefined' ||
	!args.out
) {
	throw new Error(
		'usage: stage.ts --checkout <directory> --config <generated wrangler.json> --bundle <file of the checkout, or empty> --out <directory>',
	)
}
const checkout = realpathSync(args.checkout)
const { out } = args

function refuse(message: string): never {
	process.stderr.write(`${message}\n`)
	process.exit(1)
}

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
		refuse(
			`${from} is refused: only directories and regular files are uploaded, never a link`,
		)
	}
	const stat = fstatSync(fd)
	if (!stat.isFile() || stat.nlink !== 1)
		refuse(
			`${from} is refused: only regular files with a single link are uploaded`,
		)
	writeFileSync(to, readFileSync(fd))
	closeSync(fd)
}

// A directory of the checkout, reached through no link, copied whole.
function stage(directory: string, to: string): void {
	const path = resolve(checkout, directory)
	if (!within(checkout, path) || realpathSync(path) !== path)
		refuse(
			`${directory} is refused: it must lie in the checkout, reached through no link`,
		)
	copy(path, to)
}

const config: unknown = JSON.parse(readFileSync(args.config, 'utf8'))
if (!v.is(RecordSchema, config))
	refuse(`${args.config} is not a Wrangler configuration`)
// The module root and the TypeScript configuration served the bundle, which is built:
// left in, they would make Wrangler read files the project chose.
const kept = Object.fromEntries(
	Object.entries(config).filter(
		([key]) => key !== 'base_dir' && key !== 'tsconfig',
	),
)
const staged: Record<string, unknown> = {
	...kept,
	no_bundle: true,
	upload_source_maps: false,
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out)
if (args.bundle !== '') {
	const worker = join(out, 'worker')
	stage(dirname(args.bundle), worker)
	staged.main = join(worker, basename(args.bundle))
	staged.base_dir = worker
}
if (
	v.is(RecordSchema, config.assets) &&
	typeof config.assets.directory === 'string'
) {
	stage(config.assets.directory, join(out, 'assets'))
	staged.assets = { ...config.assets, directory: join(out, 'assets') }
}
writeFileSync(join(out, 'wrangler.json'), JSON.stringify(staged))
process.stdout.write(`staged for upload: ${JSON.stringify(staged)}\n`)
