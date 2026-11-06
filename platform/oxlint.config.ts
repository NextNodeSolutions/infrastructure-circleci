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

type Override = NonNullable<
	Parameters<typeof defineConfig>[0]['overrides']
>[number]

// An inner layer: pure, and allowed to import only what the group leaves open.
function innerLayer(
	files: string,
	forbidden: string[],
	message: string,
): Override {
	return {
		files: [files],
		rules: {
			'no-restricted-globals': ['error', ...INNER_GLOBALS],
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{ group: [...PURE_IMPORTS, ...forbidden], message },
					],
				},
			],
		},
	}
}

export default defineConfig({
	extends: [standardsConfig],
	overrides: [
		{
			// The Workers runtime loads the handler as the module's default export.
			files: ['github-worker.ts'],
			rules: { 'import/no-default-export': 'off' },
		},
		innerLayer(
			'src/domain/**',
			['**/application/**', '**/adapters/**'],
			'the domain depends on nothing but itself, the lib, valibot and node:path',
		),
		innerLayer(
			'src/application/**',
			['**/adapters/**'],
			'the application reaches IO through its ports, never an adapter',
		),
		innerLayer(
			'src/lib/**',
			['**/domain/**', '**/application/**', '**/adapters/**'],
			'the lib knows nothing of the platform: it imports no layer, only valibot and node:path',
		),
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
