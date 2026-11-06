import * as v from 'valibot'

import { PlatformError } from '../../domain/platform-error.ts'

// Pulumi omits the empty resource list when exporting a newly initialized stack.
const Checkpoint = v.object({
	deployment: v.object({
		resources: v.optional(v.array(v.object({ urn: v.string() })), []),
	}),
})

export async function stackHasResource(
	stack: { exportStack(): Promise<unknown> },
	name: string,
): Promise<boolean> {
	try {
		const checkpoint = v.parse(Checkpoint, await stack.exportStack())
		return checkpoint.deployment.resources.some(resource =>
			resource.urn.endsWith(`::${name}`),
		)
	} catch {
		throw new PlatformError(
			'Cannot read the Pulumi resource checkpoint; inspect the stack before retrying service publication',
		)
	}
}
