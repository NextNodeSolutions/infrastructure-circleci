// Reads what Wrangler wrote to its output file during the deployment step and prints the
// deployment record as JSON: the uploaded version, empty when the Worker was deployed
// directly and already serves, and the URL the smoke request targets.
//
//   node deployed.ts --wrangler-output <file> --domain <hostname>
import { parseArgs } from 'node:util'

import { refusing } from './src/adapters/cli.ts'
import { readUpload } from './src/adapters/wrangler/output.ts'
import { recordDeployment } from './src/domain/deployment/upload.ts'
import { Refusal } from './src/domain/refusal.ts'

const { values: args } = parseArgs({
	options: {
		'wrangler-output': { type: 'string' },
		domain: { type: 'string' },
	},
})
const record = refusing(() => {
	if (!args['wrangler-output'] || !args.domain)
		throw new Refusal(
			'usage: deployed.ts --wrangler-output <file> --domain <hostname>',
		)
	return recordDeployment(readUpload(args['wrangler-output']), args.domain)
})
process.stdout.write(`${JSON.stringify(record)}\n`)
