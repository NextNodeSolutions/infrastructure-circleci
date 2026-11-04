import * as v from "valibot";
import { GitHubCredentials } from "./github-api.ts";

export const GITHUB_SERVICE = {
  name: "nextnode-github",
  hostname: "github.nextnode.fr",
  compatibility_date: "2026-10-27",
  compatibility_flags: ["nodejs_compat"],
  observability: { enabled: true, traces: { enabled: true } },
} as const;
export const GITHUB_WEBHOOK = new URL("/webhook", `https://${GITHUB_SERVICE.hostname}`);

export const WorkerSecrets = v.object({
  ...GitHubCredentials.entries,
  CIRCLECI_TOKEN: v.pipe(v.string(), v.nonEmpty()),
  GITHUB_WEBHOOK_SECRET: v.pipe(v.string(), v.minLength(32)),
});
export type WorkerSecrets = v.InferOutput<typeof WorkerSecrets>;
