import { parseArgs } from "node:util";
import { PlatformError } from "./src/platform-error.ts";
import { readDeployment } from "./src/read-deployment.ts";

function main(): void {
  const { values: arguments_ } = parseArgs({
    options: { "wrangler-output": { type: "string" }, domain: { type: "string" } },
  });
  if (!arguments_["wrangler-output"] || !arguments_.domain) {
    throw new PlatformError("usage: deployed.ts --wrangler-output <file> --domain <hostname>");
  }
  process.stdout.write(`${JSON.stringify(readDeployment(arguments_["wrangler-output"], arguments_.domain))}\n`);
}

try {
  main();
} catch (error) {
  console.error(PlatformError.describe(error, "Wrangler deployment metadata could not be read"));
  process.exitCode = 1;
}
