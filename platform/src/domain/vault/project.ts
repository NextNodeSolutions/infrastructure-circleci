export type VaultProject = { id: string; name: string }

// The identity is a member of every application project, so the name is what keeps a
// project away from another's secrets.
export function findVaultProject(
	projects: readonly VaultProject[],
	name: string,
): string {
	const named = projects.filter(project => project.name === name)
	const [project] = named
	if (named.length !== 1 || !project)
		throw new Error(
			`the identity belongs to ${named.length} vault project(s) named ${name}: expected exactly one, named after the repository`,
		)
	return project.id
}
