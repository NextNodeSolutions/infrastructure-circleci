import standardsConfig from '@nextnode-solutions/standards/oxlint'
import { defineConfig } from 'oxlint'

// The domain and the application take data and return data: they reach no file, no
// process and no network, and depend on no adapter. Adapters reach the application only
// through its ports. The lib holds helpers that know nothing of the platform: every layer
// imports it, and it imports no layer.
const INNER_GLOBALS = [
	{
		name: 'process',
		message: 'the inner layers take data from the entry point',
	},
	{ name: 'fetch', message: 'the network belongs to an adapter' },
]
const PURE_IMPORTS = ['**', '!valibot', '!node:path', '!./**', '!../**']

export default defineConfig({
	extends: [standardsConfig],
	overrides: [
		{
			// The Workers runtime loads the handler as the module's default export.
			files: ['github-worker.ts'],
			rules: { 'import/no-default-export': 'off' },
		},
		{
			files: ['src/domain/**'],
			rules: {
				'no-restricted-globals': ['error', ...INNER_GLOBALS],
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [
									...PURE_IMPORTS,
									'**/application/**',
									'**/adapters/**',
								],
								message:
									'the domain depends on nothing but itself, the lib, valibot and node:path',
							},
						],
					},
				],
			},
		},
		{
			files: ['src/application/**'],
			rules: {
				'no-restricted-globals': ['error', ...INNER_GLOBALS],
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [...PURE_IMPORTS, '**/adapters/**'],
								message:
									'the application reaches IO through its ports, never an adapter',
							},
						],
					},
				],
			},
		},
		{
			files: ['src/lib/**'],
			rules: {
				'no-restricted-globals': ['error', ...INNER_GLOBALS],
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [
									...PURE_IMPORTS,
									'**/domain/**',
									'**/application/**',
									'**/adapters/**',
								],
								message:
									'the lib knows nothing of the platform: it imports no layer, only valibot and node:path',
							},
						],
					},
				],
			},
		},
		{
			files: ['src/adapters/**'],
			rules: {
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [
									'**/application/**',
									'!**/application/ports/**',
								],
								message:
									'an adapter implements a port; the entry point calls the use case',
							},
						],
					},
				],
			},
		},
	],
})
