// What the read step extracted from nextnode.toml for one environment. The read step
// writes it as JSON in the platform's directory; every later step of the job, and the
// program, read this file and never the project's files again.
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { Environment, HealthPath, Hostname } from "./nextnode-toml.ts";
import { PROJECT_NAME } from "./project-name.ts";
import { PlatformError } from "./platform-error.ts";

const filled = v.pipe(v.string(), v.nonEmpty("is empty"));

export const Spec = v.object({
  // The repository's name, which names the project everywhere the platform keeps state for it: the Pulumi project and the vault project.
  project: v.pipe(v.string(), v.regex(PROJECT_NAME)),
  domains: v.record(Environment, Hostname),
  // Environment being deployed, also the stack name.
  environment: Environment,
  // Route the smoke request targets after each upload.
  health: HealthPath,
  // The project's migration command, empty when it declares none.
  migrate: v.string(),
  // Hostname of the environment, attached to its Worker as a custom domain.
  domain: Hostname,
  // Name of the environment's Worker, the repository's name suffixed with the environment.
  worker_name: filled,
  // The bundled entry point, relative to the checkout root, that the upload takes as it is; empty for a Worker of static assets only.
  bundle: v.string(),
});
export type Spec = v.InferOutput<typeof Spec>;

export function readSpec(path: string): Spec {
  let document: unknown;
  try { document = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new PlatformError(`${path}: a readable JSON deployment spec is required. Regenerate it with the read step.`); }
  const parsed = v.safeParse(Spec, document);
  if (!parsed.success) throw new PlatformError(`${path}: invalid deployment fields: ${parsed.issues.map(issue => v.getDotPath(issue) ?? "spec").join(", ")}. Regenerate it with the read step.`);
  return parsed.output;
}
