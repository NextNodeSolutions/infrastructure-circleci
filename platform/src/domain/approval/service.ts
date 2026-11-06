// The shared Worker that approves production releases from GitHub. Its hostname is the
// platform's, so no project may declare it; the worker keys are its Wrangler configuration.
export const GITHUB_SERVICE = {
	hostname: 'github.nextnode.fr',
	worker: {
		name: 'nextnode-github',
		compatibility_date: '2026-10-27',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: true, traces: { enabled: true } },
	},
} as const
const SERVICE_ORIGIN = `https://${GITHUB_SERVICE.hostname}`
export const GITHUB_WEBHOOK = new URL('/webhook', SERVICE_ORIGIN)
export const GITHUB_HEALTH = new URL('/health', SERVICE_ORIGIN)
