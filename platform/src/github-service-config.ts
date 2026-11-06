import * as v from 'valibot'

import { GitHubCredentials } from './github-api.ts'

const WEBHOOK_SECRET_MIN_LENGTH = 32

export const WorkerSecrets = v.object({
	...GitHubCredentials.entries,
	CIRCLECI_TOKEN: v.pipe(v.string(), v.nonEmpty()),
	GITHUB_WEBHOOK_SECRET: v.pipe(
		v.string(),
		v.minLength(WEBHOOK_SECRET_MIN_LENGTH),
	),
})
export type WorkerSecrets = v.InferOutput<typeof WorkerSecrets>
