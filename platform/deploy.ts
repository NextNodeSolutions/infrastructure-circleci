// Converges the Cloudflare resources of one environment, through Pulumi's Automation API.
//
//   node deploy.ts --spec <nextnode.json> --work <empty directory> [--preview]
//
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PULUMI_CONFIG_PASSPHRASE and
// NEXTNODE_STATE_BUCKET, as the deployment job exports them from the vault. The Pulumi
// CLI and the Cloudflare provider plugin are found through PATH and PULUMI_HOME.
// Progress goes to stderr; stdout receives the stack outputs as one JSON object.
import { parseArgs } from "node:util";
import type * as automation from "@pulumi/pulumi/automation/index.js";
import { platformStack } from "./src/platform-stack.ts";
import { program } from "./src/program.ts";
import { readSpec } from "./src/spec.ts";

const { values: args } = parseArgs({
  options: {
    spec: { type: "string" },
    work: { type: "string" },
    preview: { type: "boolean", default: false },
  },
});
if (!args.spec || !args.work) throw new Error("usage: deploy.ts --spec <file> --work <dir> [--preview]");

// Phase timings on stderr: the job's budget is measured in seconds.
const started = Date.now();
let last = started;
function lap(phase: string, since = last): void {
  const now = Date.now();
  process.stderr.write(`[${phase}: ${((now - since) / 1000).toFixed(1)}s]\n`);
  last = now;
}

const spec = readSpec(args.spec);
const stack = await platformStack({ project: spec.project, environment: spec.environment, work: args.work, program: accountId => program(spec, accountId) });
lap("stack selected");

// Refreshed in the same run: what disappeared outside Pulumi, such as a domain that went
// with a deleted Worker, leaves the state instead of failing its own deletion. One run
// of the program, not two: each run starts a language host.
const onOutput = (out: string): void => { process.stderr.write(out); };
async function converge(): Promise<automation.OutputMap> {
  if (args.preview) {
    await stack.preview({ onOutput, diff: true, refresh: true });
    lap("preview");
    return {};
  }
  const { outputs } = await stack.up({ onOutput, refresh: true });
  lap("up");
  return outputs;
}

const outputs = await converge();
lap("total", started);
process.stdout.write(`${JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([key, output]) => [key, output.value])))}\n`);
