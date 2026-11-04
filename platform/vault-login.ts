import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function main(): void {
  const { INFISICAL_DOMAIN, INFISICAL_IDENTITY_ID, CIRCLE_OIDC_TOKEN_V2 } = process.env;
  if (!INFISICAL_DOMAIN || !INFISICAL_IDENTITY_ID || !CIRCLE_OIDC_TOKEN_V2) {
    throw new Error("Missing vault authentication environment");
  }
  const result = spawnSync("infisical", [
    "--domain", INFISICAL_DOMAIN, "login", "--method=oidc-auth",
    "--machine-identity-id", INFISICAL_IDENTITY_ID, "--jwt", CIRCLE_OIDC_TOKEN_V2,
    "--plain", "--silent",
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("Vault authentication refused");
  const token = result.stdout.trim();
  if (!token || /\s/.test(token)) throw new Error("Invalid vault authentication output");
  process.stdout.write(token);
}

try {
  main();
} catch {
  console.error("Vault authentication failed. Verify the CI identity policy and required environment names.");
  process.exitCode = 1;
}
