import * as v from 'valibot'

import type { VaultProject } from '../../domain/vault/project.ts'

const Workspaces = v.object({
	workspaces: v.array(
		v.object({ id: v.string(), name: v.string(), type: v.string() }),
	),
})

// The secret projects the token's identity belongs to.
export async function listVaultProjects(
	domain: string,
	token: string,
): Promise<VaultProject[]> {
	const response = await fetch(`${domain}/v1/workspace`, {
		headers: { authorization: `Bearer ${token}` },
		redirect: 'error',
	})
	if (!response.ok)
		throw new Error(
			`the vault refused the project listing (HTTP ${response.status})`,
		)
	const body: unknown = await response.json()
	const { workspaces } = v.parse(Workspaces, body)
	return workspaces
		.filter(workspace => workspace.type === 'secret-manager')
		.map(({ id, name }) => ({ id, name }))
}
