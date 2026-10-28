import standardsConfig from '@nextnode-solutions/standards/oxlint'
import { defineConfig } from 'oxlint'

export default defineConfig({
	extends: [standardsConfig],
	overrides: [
		{
			// The Workers runtime loads the handler as the module's default export.
			files: ['github-worker.ts'],
			rules: { 'import/no-default-export': 'off' },
		},
	],
})
