// Reads nextnode.toml for one environment into the spec, and generates from its Wrangler
// keys the Wrangler configuration of the environment's Worker. With --check, reads every
// environment and writes nothing: the checks job runs it on every push, so a mistake in
// the file fails the branch instead of a deployment after the merge or the approval.
//
//   node read.ts --repository <name> --environment <name> --platform <directory>
//   node read.ts --repository <name> --check
//
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { parse as parseToml } from 'smol-toml'
import * as v from 'valibot'

import {
	describe,
	Environment,
	ENVIRONMENTS,
	NextnodeToml,
} from './src/nextnode-toml.ts'
import { within } from './src/paths.ts'
import { PROJECT_NAME } from './src/project-name.ts'

import type { Wrangler } from './src/nextnode-toml.ts'
import type { Spec } from './src/spec.ts'

const NOT_DECLARED = 3
const ROOT = realpathSync('.')
// The repository name names the Pulumi project and, suffixed with the environment, the
// Worker, which Cloudflare restricts to lowercase letters, digits and dashes.
const WORKER_NAME_LENGTH = 63
// The keys Wrangler reads as a file or a directory. The generated configuration lives
// outside the checkout, so they are anchored to the checkout root, and stay inside it.
const PATH_KEYS = ['main', 'base_dir', 'tsconfig'] as const
// Where the project user's bundle lands, relative to the checkout root.
const BUNDLE_DIRECTORY = '.nextnode'

const { values: args } = parseArgs({
	options: {
		repository: { type: 'string' },
		environment: { type: 'string' },
		platform: { type: 'string' },
		check: { type: 'boolean' },
	},
})
if (
	!args.repository ||
	(!args.check && (!args.environment || !args.platform))
) {
	throw new Error(
		'usage: read.ts --repository <name> (--environment <name> --platform <directory> | --check)',
	)
}
const { repository } = args

function refuse(message: string): never {
	process.stderr.write(`${message}\n`)
	process.exit(1)
}

function parseFile(): NextnodeToml {
	let source: string
	let descriptor: number | undefined
	try {
		descriptor = openSync(
			'nextnode.toml',
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		if (!fstatSync(descriptor).isFile())
			refuse(
				'nextnode.toml must be a regular file at the repository root',
			)
		source = readFileSync(descriptor, 'utf8')
	} catch {
		refuse(
			'nextnode.toml must be a readable regular file at the repository root, not a link',
		)
	} finally {
		if (typeof descriptor !== 'undefined') closeSync(descriptor)
	}
	let toml: unknown
	try {
		toml = parseToml(source)
	} catch {
		refuse(
			'nextnode.toml is not valid TOML; fix its syntax and rerun checks',
		)
	}
	const parsed = v.safeParse(NextnodeToml, toml, {
		message: issue => `must be ${issue.expected}, got ${issue.received}`,
	})
	if (!parsed.success) refuse(describe(parsed.issues))
	return parsed.output
}

// A path the configuration names, as an absolute path of the checkout.
function anchored(
	key: string,
	configuredPath: string | undefined,
): string | undefined {
	if (typeof configuredPath === 'undefined') return undefined
	const path = resolve(ROOT, configuredPath)
	if (!within(ROOT, path))
		refuse(`nextnode.toml: ${key} leaves the repository: ${configuredPath}`)
	return path
}

// The one environment, flat: Wrangler does not carry vars and bindings from the top level
// into an environment's section, so each key of the section replaces the top-level one, whole.
function wranglerConfig(
	keys: Wrangler,
	worker: string,
): Wrangler & { name: string } {
	const config = { ...keys, name: worker }
	for (const key of PATH_KEYS) config[key] = anchored(key, config[key])
	if (config.assets)
		config.assets = {
			...config.assets,
			directory: anchored('assets.directory', config.assets.directory),
		}
	return config
}

// The upload takes the bundle Wrangler wrote for the project, named after the entry point.
function bundleOf(main: string | undefined): string {
	return typeof main === 'undefined'
		? ''
		: join(BUNDLE_DIRECTORY, `${basename(main, extname(main))}.js`)
}

// The spec and the Wrangler configuration of one environment, or undefined when the
// file does not declare it.
function readEnvironment(
	toml: NextnodeToml,
	environment: Environment,
): { spec: Spec; wrangler: Wrangler } | undefined {
	const { deploy, environments, env, ...shared } = toml
	const declared = environments[environment]
	if (!declared) return undefined
	const worker = `${repository}-${environment}`
	if (!PROJECT_NAME.test(repository) || worker.length > WORKER_NAME_LENGTH) {
		refuse(
			`the repository name ${JSON.stringify(repository)} names the Pulumi project and the Worker ${worker}: lowercase letters, digits and dashes, ${WORKER_NAME_LENGTH} characters at most with the environment`,
		)
	}
	const wrangler = wranglerConfig({ ...shared, ...env[environment] }, worker)
	const spec: Spec = {
		project: repository,
		domains: Object.fromEntries(
			Object.entries(environments).flatMap(([name, configuration]) =>
				configuration ? [[name, configuration.domain]] : [],
			),
		),
		environment,
		health: deploy.health,
		migrate: deploy.migrate,
		domain: declared.domain,
		worker_name: worker,
		bundle: bundleOf(wrangler.main),
	}
	return { spec, wrangler }
}

const toml = parseFile()

if (args.check) {
	for (const environment of ENVIRONMENTS) {
		const read = readEnvironment(toml, environment)
		const summary = read
			? `${environment}: Worker ${read.spec.worker_name} on ${read.spec.domain}, wrangler configuration ${JSON.stringify(read.wrangler)}`
			: `${environment}: not declared, the ${environment} job halts`
		process.stdout.write(`${summary}\n`)
	}
	process.exit(0)
}

const environment = v.safeParse(Environment, args.environment)
if (!environment.success)
	refuse(`--environment ${args.environment} ${environment.issues[0].message}`)
const read = readEnvironment(toml, environment.output)
// Only development may be missing: a halt reads as green, and production never halts.
if (!read) {
	process.stderr.write(
		`nextnode.toml declares no environment "${environment.output}"\n`,
	)
	process.exit(environment.output === 'development' ? NOT_DECLARED : 1)
}
const platform = args.platform ?? ''
for (const [key, setting] of Object.entries(read.spec))
	process.stdout.write(
		`${key}=${typeof setting === 'object' ? JSON.stringify(setting) : setting}\n`,
	)
process.stdout.write(
	`wrangler configuration: ${JSON.stringify(read.wrangler)}\n`,
)
writeFileSync(join(platform, 'nextnode.json'), JSON.stringify(read.spec))
writeFileSync(join(platform, 'wrangler.json'), JSON.stringify(read.wrangler))
