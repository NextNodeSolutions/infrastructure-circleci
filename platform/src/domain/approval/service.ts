// The shared Worker that approves production releases from GitHub. Its hostname is the
// platform's, so no project may declare it.
export const GITHUB_SERVICE = {
	name: 'nextnode-github',
	hostname: 'github.nextnode.fr',
	compatibility_date: '2026-10-27',
	compatibility_flags: ['nodejs_compat'],
	observability: { enabled: true, traces: { enabled: true } },
} as const
export const GITHUB_WEBHOOK = new URL(
	'/webhook',
	`https://${GITHUB_SERVICE.hostname}`,
)
