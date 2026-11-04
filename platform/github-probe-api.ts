import { generateKeyPairSync } from "node:crypto";
import type { TestContext } from "node:test";
import { APPROVAL_PROBE as probe } from "./approval-probe-fixtures.ts";
import { GitHubApi } from "./src/github-api.ts";

type Reply = (url: URL, request: RequestInit | undefined) => Response;

export async function githubProbeApi(context: TestContext, reply: Reply): Promise<GitHubApi> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: probe.rsaKeyBits });
  context.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], request?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/app/installations/${probe.event.installation.id}`) {
      return Response.json({ app_id: probe.appId, account: { login: probe.owner }, events: ["check_run"] });
    }
    if (url.pathname === `/app/installations/${probe.event.installation.id}/access_tokens`) {
      return Response.json({ token: "probe-only-installation-token" });
    }
    return reply(url, request);
  });
  return GitHubApi.connect({
    GITHUB_APP_ID: String(probe.appId), GITHUB_APP_INSTALLATION_ID: String(probe.event.installation.id),
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }, probe.repositoryName, "report");
}
