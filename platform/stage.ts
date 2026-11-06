// Copies the bundle and the static assets of the checkout into the platform's own
// directory, and writes the Wrangler configuration that uploads that copy. Wrangler runs
// there with the Cloudflare credential, so it must read no file the project can point
// it to. Runs once every process of the project user has ended. A refusal names the file
// and exits 1.
//
//   node stage.ts --checkout <directory> --config <generated wrangler.json> --bundle <file of the checkout, or empty> --out <directory>
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { checkoutStaging } from './src/adapters/checkout/staging.ts'
import { refusing } from './src/adapters/cli.ts'
import { readJson, writeJson } from './src/adapters/platform-files.ts'
import { stageUpload } from './src/application/deployment/stage-upload.ts'

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
const { config, bundle, out } = args
const staging = checkoutStaging(args.checkout, out)

refusing(() => {
	const staged = stageUpload(staging, {
		config: readJson(config),
		source: config,
		bundle,
	})
	writeJson(join(out, 'wrangler.json'), staged)
	process.stdout.write(`staged for upload: ${JSON.stringify(staged)}\n`)
})
