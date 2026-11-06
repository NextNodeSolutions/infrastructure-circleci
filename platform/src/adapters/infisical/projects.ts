import * as v from 'valibot'

import { decodeOr } from '../../lib/decode.ts'
import { requestJson } from '../http.ts'

import type { VaultProject } from '../../domain/vault/project.ts'

const Workspaces = v.object({ workspaces: v.array(v.unknown()) })
const SecretProject = v.object({
	id: v.string(),
	name: v.string(),
	type: v.literal('secret-manager'),
})

// The secret projects the token's identity belongs to. The listing mixes in the workspaces
// of Infisical's other products, which the schema of a secret project leaves out.
export async function listVaultProjects(
	domain: string,
	token: string,
): Promise<VaultProject[]> {
	const body = await requestJson(
		`${domain}/v1/workspace`,
		{ headers: { authorization: `Bearer ${token}` } },
		failure =>
			new Error(
				'status' in failure
					? `the vault refused the project listing (HTTP ${failure.status})`
					: `the vault project listing did not complete: ${failure.cause}`,
			),
	)
	const { workspaces } = decodeOr(
		Workspaces,
		body,
		fields =>
			new Error(`the vault project listing is malformed: ${fields}`),
	)
	return workspaces
		.map(workspace => v.safeParse(SecretProject, workspace))
		.filter(parsed => parsed.success)
		.map(({ output }) => ({ id: output.id, name: output.name }))
}
