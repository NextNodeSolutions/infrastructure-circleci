import { mkdirSync } from 'node:fs'

import * as automation from '@pulumi/pulumi/automation/index.js'

import type { StateBackend } from './state-backend.ts'

export type Program = (accountId: string) => Promise<Record<string, unknown>>

export type StackSettings = {
	project: string
	stackName: string
	program: Program
	accountId: string
	token: string
	passphrase: string
	backend: StateBackend
	workDir: string
}

type Outputs = Record<string, unknown>
export type OnOutput = (out: string) => void

function values(outputs: automation.OutputMap): Outputs {
	return Object.fromEntries(
		Object.entries(outputs).map(([key, output]) => [key, output.value]),
	)
}

// The stack of one environment, in the Pulumi project named after the repository for an
// application and after the platform for a shared service.
export async function selectStack(
	settings: StackSettings,
): Promise<automation.Stack> {
	const { project, stackName, program, accountId, token, passphrase } =
		settings
	const { backend, workDir } = settings
	mkdirSync(workDir, { recursive: true, mode: 0o700 })
	return automation.LocalWorkspace.createOrSelectStack(
		{ stackName, projectName: project, program: () => program(accountId) },
		{
			workDir,
			secretsProvider: 'passphrase',
			projectSettings: {
				name: project,
				runtime: 'nodejs',
				backend: { url: backend.url },
			},
			envVars: {
				...backend.env,
				PULUMI_CONFIG_PASSPHRASE: passphrase,
				CLOUDFLARE_API_TOKEN: token,
			},
		},
	)
}

// Refreshed in the same run: what disappeared outside Pulumi, such as a domain that went
// with a deleted Worker, leaves the state instead of failing its own deletion. One run
// of the program, not two: each run starts a language host.
export async function previewStack(
	stack: automation.Stack,
	onOutput: OnOutput,
): Promise<Outputs> {
	await stack.preview({ onOutput, diff: true, refresh: true })
	// A stack that was never deployed has no outputs to read, and a preview changes none.
	return {}
}

export async function upStack(
	stack: automation.Stack,
	onOutput: OnOutput,
): Promise<Outputs> {
	const { outputs } = await stack.up({ onOutput, refresh: true })
	return values(outputs)
}
