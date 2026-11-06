// Converges the Cloudflare resources of one environment, through Pulumi's Automation API.
//
//   node deploy.ts --spec <nextnode.json> --work <empty directory> [--preview]
//
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PULUMI_CONFIG_PASSPHRASE and
// NEXTNODE_STATE_BUCKET, as the deployment job exports them from the vault. The Pulumi
// CLI and the Cloudflare provider plugin are found through PATH and PULUMI_HOME.
// Progress goes to stderr; stdout receives the stack outputs as one JSON object.
import { parseArgs } from 'node:util'

import { platformCredentials } from './src/adapters/cli.ts'
import { readSpec } from './src/adapters/platform-files.ts'
import { program } from './src/adapters/pulumi/program.ts'
import {
	openStack,
	previewStack,
	toStderr,
	upStack,
} from './src/adapters/pulumi/stack.ts'
import { MILLISECONDS_PER_SECOND } from './src/lib/time.ts'

const { values: args } = parseArgs({
	options: {
		spec: { type: 'string' },
		work: { type: 'string' },
		preview: { type: 'boolean', default: false },
	},
})
if (!args.spec || !args.work)
	throw new Error('usage: deploy.ts --spec <file> --work <dir> [--preview]')

// Phase timings on stderr: the job's budget is measured in seconds.
const started = performance.now()
let last = started
function lap(phase: string, since = last): void {
	const now = performance.now()
	process.stderr.write(
		`[${phase}: ${((now - since) / MILLISECONDS_PER_SECOND).toFixed(1)}s]\n`,
	)
	last = now
}

const spec = readSpec(args.spec)
const stack = await openStack(
	{
		project: spec.project,
		stackName: spec.environment,
		program: id => program(spec, id),
		workDir: args.work,
	},
	platformCredentials(),
)
lap('stack selected')

const outputs = args.preview
	? await previewStack(stack, toStderr)
	: await upStack(stack, toStderr)
lap(args.preview ? 'preview' : 'up')
lap('total', started)
process.stdout.write(`${JSON.stringify(outputs)}\n`)
