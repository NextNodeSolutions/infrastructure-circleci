import * as v from 'valibot'

const WEBHOOK_SECRET_MIN_LENGTH = 32
const Id = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/))

export const GitHubCredentials = v.object({
	GITHUB_APP_ID: Id,
	GITHUB_APP_INSTALLATION_ID: Id,
	GITHUB_APP_PRIVATE_KEY: v.pipe(v.string(), v.nonEmpty()),
})
export type GitHubCredentials = v.InferOutput<typeof GitHubCredentials>

export const WorkerSecrets = v.object({
	...GitHubCredentials.entries,
	CIRCLECI_TOKEN: v.pipe(v.string(), v.nonEmpty()),
	GITHUB_WEBHOOK_SECRET: v.pipe(
		v.string(),
		v.minLength(WEBHOOK_SECRET_MIN_LENGTH),
	),
})
export type WorkerSecrets = v.InferOutput<typeof WorkerSecrets>

export const Resources = v.object({
	CLOUDFLARE_API_TOKEN: v.pipe(v.string(), v.nonEmpty()),
	CLOUDFLARE_ACCOUNT_ID: v.pipe(v.string(), v.nonEmpty()),
	PULUMI_CONFIG_PASSPHRASE: v.pipe(v.string(), v.nonEmpty()),
})

// The vault's platform secrets, by the scope a job exports.
export const PlatformSecrets = {
	resources: Resources,
	reporting: GitHubCredentials,
	runtime: WorkerSecrets,
} as const
