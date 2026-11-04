import { readFileSync } from "node:fs";
import { isRecord } from "./record.ts";
import { PlatformError } from "./platform-error.ts";

type Deployment = { version: string; url: string };
class DeploymentError extends PlatformError {}

function deployment(entries: Record<string, unknown>[], domain: string): Deployment {
  const uploaded = entries.find(entry => entry.type === "version-upload");
  if (uploaded) {
    if (typeof uploaded.version_id !== "string") throw new DeploymentError("Wrangler reported no version id for the upload");
    if (typeof uploaded.preview_url !== "string") throw new DeploymentError("Wrangler reported no preview URL: the production Worker needs preview_urls");
    return { version: uploaded.version_id, url: uploaded.preview_url };
  }
  const deployed = entries.find(entry => entry.type === "deploy");
  if (!deployed) throw new DeploymentError("Wrangler reported neither a deployment nor a version upload");
  const targets = Array.isArray(deployed.targets) ? deployed.targets.filter((target): target is string => typeof target === "string") : [];
  return { version: "", url: targets.find(target => target.endsWith(".workers.dev")) ?? `https://${domain}` };
}

export function readDeployment(output: string, domain: string): Deployment {
  try {
    const entries = readFileSync(output, "utf8").split("\n").filter(Boolean)
      .map((line): unknown => JSON.parse(line)).filter(isRecord);
    return deployment(entries, domain);
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError("Wrangler deployment metadata could not be read");
  }
}
