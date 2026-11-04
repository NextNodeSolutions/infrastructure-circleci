// The schema of nextnode.toml: the one definition of what a project may write in it. The
// read step parses the file with it, for one environment in a deployment job and for
// every environment in the checks job. A refusal is printed as the key's path and the
// rule, and the probe job matches refusals on those words.
import * as v from "valibot";
import { isRecord } from "./record.ts";
import { GITHUB_SERVICE } from "./github-service-config.ts";

// The deployment jobs of the pipeline. Production is deployed by every project; a
// project without a development environment halts that job.
export const ENVIRONMENTS = ["development", "production"] as const;
export const Environment = v.picklist(ENVIRONMENTS, `is not an environment of the pipeline: ${ENVIRONMENTS.join(", ")}`);
export type Environment = v.InferOutput<typeof Environment>;

// Valibot's object and record schemas accept an array, as an object keyed by its indexes,
// so every table of the file goes through this check first.
const table = v.custom<Record<string, unknown>>(isRecord, (issue) => `must be a table, got ${issue.received}`);

// A table whose keys are all named here. Valibot reports a missing key with the table's
// message too, so the message tells the two apart: an unknown key's issue expects never.
function strict<const TEntries extends v.ObjectEntries>(entries: TEntries, refused: string) {
  return v.pipe(table, v.strictObject(entries, (issue) => (issue.expected === "never" ? refused : "is missing")));
}

function loose<const TEntries extends v.ObjectEntries>(entries: TEntries) {
  return v.pipe(table, v.looseObject(entries));
}

// The custom domain: lowercase labels of letters, digits and inner dashes, under a TLD.
export const Hostname = v.pipe(
  v.string(),
  v.regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, (issue) => `must be a hostname, got ${issue.received}`),
  v.check(hostname => hostname !== GITHUB_SERVICE.hostname, "is reserved for the platform approval service"),
);

// The route the smoke request targets after each upload.
export const HealthPath = v.pipe(v.string(), v.startsWith("/", (issue) => `is a path of the Worker and starts with /, got ${issue.received}`));

// Every key outside the platform's tables is Wrangler's own. Wrangler reads the generated
// configuration with the platform credential, in the account every project shares, so
// only keys that describe this Worker's own code and runtime are accepted. A key that
// names, builds or routes the Worker, or binds to or creates another resource, is the
// platform's, and a key Wrangler adds later stays refused until accepted here. Wrangler
// checks the values; the schema checks those the platform has a rule about. The paths
// are anchored to the checkout by the read step, which refuses one that leaves it.
const WRANGLER = {
  main: v.optional(v.string()),
  base_dir: v.optional(v.string()),
  tsconfig: v.optional(v.string()),
  compatibility_date: v.optional(v.string()),
  compatibility_flags: v.optional(v.array(v.string())),
  assets: v.optional(loose({ directory: v.optional(v.string()) })),
  vars: v.optional(v.unknown()),
  define: v.optional(v.unknown()),
  observability: v.optional(v.unknown()),
  limits: v.optional(v.unknown()),
  placement: v.optional(v.unknown()),
  triggers: v.optional(strict({ crons: v.optional(v.array(v.string())) }, "is refused: triggers accepts crons only")),
  workers_dev: v.optional(v.boolean()),
  preview_urls: v.optional(v.boolean()),
  minify: v.optional(v.boolean()),
  keep_names: v.optional(v.boolean()),
  version_metadata: v.optional(v.unknown()),
  ai: v.optional(v.unknown()),
  browser: v.optional(v.unknown()),
  images: v.optional(v.unknown()),
  durable_objects: v.optional(
    loose({
      bindings: v.optional(v.array(loose({ script_name: v.optional(v.never("is refused: durable_objects binds to this Worker's own classes only")) }))),
    }),
  ),
  migrations: v.optional(v.unknown()),
};

const refusedKey = `is refused. The Wrangler keys the platform accepts: ${Object.keys(WRANGLER).join(", ")}`;

const Wrangler = strict(WRANGLER, refusedKey);
export type Wrangler = v.InferOutput<typeof Wrangler>;

export const NextnodeToml = strict(
  {
    ...WRANGLER,
    deploy: v.optional(
      strict(
        {
          health: v.optional(HealthPath, "/"),
          // The project's migration command, run as the project user.
          migrate: v.optional(v.string("must be a string, the command to run"), ""),
        },
        "is refused: deploy takes health and migrate",
      ),
      {},
    ),
    environments: v.pipe(
      table,
      v.record(Environment, strict({ domain: Hostname }, "is refused: an environment takes domain only")),
      v.check((environments) => environments.production !== undefined, 'declares no environment "production"'),
    ),
    env: v.optional(v.pipe(table, v.record(Environment, Wrangler)), {}),
  },
  refusedKey,
);
export type NextnodeToml = v.InferOutput<typeof NextnodeToml>;

// One line per issue: the key's path, then the rule.
export function describe(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => `nextnode.toml: ${v.getDotPath(issue) ?? "the file"} ${issue.message}`).join("\n");
}
