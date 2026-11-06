// What the schema of nextnode.toml cannot say alone: the rules that depend on the checkout
// and on the repository's name, which names the project everywhere the platform keeps
// state for it, and names its Workers. A value of the project's files never does.
import { basename, extname, join, resolve } from 'node:path'

import { within } from '../../lib/paths.ts'
import { Refusal } from '../refusal.ts'

import { PROJECT_NAME } from './project-name.ts'

import type {
	Environment,
	NextnodeToml,
	Wrangler,
	WranglerConfig,
} from './nextnode-toml.ts'
import type { Spec } from './spec.ts'

const WORKER_NAME_LENGTH = 63
// The keys Wrangler reads as a file or a directory. The generated configuration lives
// outside the checkout, so they are anchored to the checkout root, and stay inside it.
const PATH_KEYS = ['main', 'base_dir', 'tsconfig'] as const
// Where the project user's bundle lands, relative to the checkout root.
const BUNDLE_DIRECTORY = '.nextnode'

export type Checkout = { repository: string; root: string }

export type EnvironmentRead = {
	spec: Spec
	wrangler: WranglerConfig
}

// A path the configuration names, as an absolute path of the checkout.
function anchored(
	root: string,
	key: string,
	configuredPath: string | undefined,
): string | undefined {
	if (typeof configuredPath === 'undefined') return undefined
	const path = resolve(root, configuredPath)
	if (!within(root, path))
		throw new Refusal(
			`nextnode.toml: ${key} leaves the repository: ${configuredPath}`,
		)
	return path
}

// The one environment, flat: Wrangler does not carry vars and bindings from the top level
// into an environment's section, so each key of the section replaces the top-level one, whole.
function wranglerConfig(
	keys: Wrangler,
	worker: string,
	root: string,
): WranglerConfig {
	const config = { ...keys, name: worker }
	for (const key of PATH_KEYS) config[key] = anchored(root, key, config[key])
	if (config.assets)
		config.assets = {
			...config.assets,
			directory: anchored(
				root,
				'assets.directory',
				config.assets.directory,
			),
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
export function readEnvironment(
	toml: NextnodeToml,
	environment: Environment,
	checkout: Checkout,
): EnvironmentRead | undefined {
	const { repository, root } = checkout
	const { deploy, environments, env, ...shared } = toml
	const declared = environments[environment]
	if (!declared) return undefined
	const worker = `${repository}-${environment}`
	if (!PROJECT_NAME.test(repository) || worker.length > WORKER_NAME_LENGTH) {
		throw new Refusal(
			`the repository name ${JSON.stringify(repository)} names the Pulumi project and the Worker ${worker}: lowercase letters, digits and dashes, ${WORKER_NAME_LENGTH} characters at most with the environment`,
		)
	}
	const wrangler = wranglerConfig(
		{ ...shared, ...env[environment] },
		worker,
		root,
	)
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
