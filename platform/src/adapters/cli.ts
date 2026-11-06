import { Refusal } from '../domain/refusal.ts'

// Runs a step program: a refusal prints its message alone and exits 1, any other error
// stays a crash with its stack.
export function refusing<T>(step: () => T): T {
	try {
		return step()
	} catch (error) {
		if (!(error instanceof Refusal)) throw error
		process.stderr.write(`${error.message}\n`)
		process.exit(1)
	}
}

export function env(name: string): string {
	const setting = process.env[name]
	if (!setting) throw new Error(`${name} is not set`)
	return setting
}
