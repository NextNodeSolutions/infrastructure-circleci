import * as v from "valibot";
import { GitHubCredentials } from "./github-api.ts";
import { WorkerSecrets } from "./github-service-config.ts";

const Resources = v.object({
  CLOUDFLARE_API_TOKEN: v.pipe(v.string(), v.nonEmpty()),
  CLOUDFLARE_ACCOUNT_ID: v.pipe(v.string(), v.nonEmpty()),
  PULUMI_CONFIG_PASSPHRASE: v.pipe(v.string(), v.nonEmpty()),
});

export const PlatformSecrets = {
  resources: Resources,
  reporting: GitHubCredentials,
  runtime: WorkerSecrets,
} as const;
