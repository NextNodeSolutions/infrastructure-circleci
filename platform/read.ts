// Reads nextnode.toml for one environment into the spec, and generates from its Wrangler
// keys the Wrangler configuration of the environment's Worker. With --check, reads every
// environment and writes nothing: the checks job runs it on every push, so a mistake in
// the file fails the branch instead of a deployment after the merge or the approval.
//
//   node read.ts --repository <name> --environment <name> --platform <directory>
//   node read.ts --repository <name> --check
//
// Runs in the project checkout as the platform user, before any project code. What the
// file may hold is the schema's; the read adds the rules that depend on the checkout and
// the repository. A refusal names the key or the rule and exits 1. Exit 3 means the
// development environment is not declared, which the development job turns into a halt:
// it is the project's choice, not an error.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import * as v from 'valibot'

import { readNextnodeToml } from './src/adapters/checkout/nextnode-toml.ts'
import { refusing } from './src/adapters/cli.ts'
import { writeJson } from './src/adapters/platform-files.ts'
import { readEnvironment } from './src/domain/configuration/environment.ts'
import {
	Environment,
	ENVIRONMENTS,
	parseConfiguration,
} from './src/domain/configuration/nextnode-toml.ts'
import { Refusal } from './src/domain/refusal.ts'

const NOT_DECLARED = 3
const root = realpathSync('.')

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
const checkout = { repository: args.repository, root }

refusing(() => {
	const toml = parseConfiguration(readNextnodeToml(root))

	if (args.check) {
		for (const environment of ENVIRONMENTS) {
			const read = readEnvironment(toml, environment, checkout)
			const summary = read
				? `${environment}: Worker ${read.spec.worker_name} on ${read.spec.domain}, wrangler configuration ${JSON.stringify(read.wrangler)}`
				: `${environment}: not declared, the ${environment} job halts`
			process.stdout.write(`${summary}\n`)
		}
		process.exit(0)
	}

	const environment = v.safeParse(Environment, args.environment)
	if (!environment.success)
		throw new Refusal(
			`--environment ${args.environment} ${environment.issues[0].message}`,
		)
	const read = readEnvironment(toml, environment.output, checkout)
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
	writeJson(join(platform, 'nextnode.json'), read.spec)
	writeJson(join(platform, 'wrangler.json'), read.wrangler)
})
