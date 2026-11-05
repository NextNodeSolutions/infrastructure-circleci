import { createPrivateKey, sign } from "node:crypto";
import * as v from "valibot";
import { PROJECT_NAME } from "./project-name.ts";
import { PlatformError } from "./platform-error.ts";

const API = "https://api.github.com";
// Release verification needs merge_commit_sha, removed in REST 2026-03-10.
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
const JWT_SECONDS = 9 * 60;
const CLOCK_SKEW_SECONDS = 60;
export const PAGE_SIZE = 100;
const REPORT_PERMISSIONS = { checks: "write", pull_requests: "read" } as const;
const APPROVAL_PERMISSIONS = { ...REPORT_PERMISSIONS, members: "read" } as const;
const PERMISSIONS = { report: REPORT_PERMISSIONS, approve: APPROVAL_PERMISSIONS, verify: { ...APPROVAL_PERMISSIONS, checks: "read" } } as const;
export const PositiveId = v.pipe(v.number(), v.integer(), v.minValue(1));
export const Revision = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
export const Pull = v.object({ number: PositiveId, merged_at: v.nullable(v.string()), merge_commit_sha: v.nullable(Revision), head: v.object({ sha: Revision }), base: v.object({ ref: v.string(), repo: v.object({ full_name: v.string() }) }) });
export type Pull = v.InferOutput<typeof Pull>;
export const GitHubCredentials = v.object({
  GITHUB_APP_ID: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
  GITHUB_APP_INSTALLATION_ID: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
  GITHUB_APP_PRIVATE_KEY: v.pipe(v.string(), v.nonEmpty()),
});
const Installation = v.object({ app_id: PositiveId, account: v.object({ login: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/)) }), events: v.array(v.string()) });
const Token = v.object({ token: v.pipe(v.string(), v.nonEmpty()) });

export class ReportingError extends PlatformError {
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

export function decode<TSchema extends v.GenericSchema>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, input);
  if (!parsed.success) throw new ReportingError(`Invalid GitHub configuration or response fields: ${parsed.issues.map(issue => v.getDotPath(issue) ?? "response").join(", ")}`);
  return parsed.output;
}

function isRetryableRead(method: string, attempt: number, error: unknown): boolean {
  if (method !== "GET" || attempt >= READ_ATTEMPTS) return false;
  return error instanceof ReportingError && error.status !== undefined && error.status >= 500;
}

async function request(authorization: string, path: string, method: string, body?: unknown): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(authorization, path, method, body);
    } catch (error) {
      if (!isRetryableRead(method, attempt, error)) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

async function send(authorization: string, path: string, method: string, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authorization}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "Content-Type": "application/json",
        "User-Agent": "nextnode-ci-checks",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new ReportingError(`GitHub reporting failed: ${method} ${path} returned HTTP ${response.status}`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof ReportingError) throw error;
    throw new ReportingError(`GitHub reporting could not complete its API request: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function jwt(credentials: v.InferOutput<typeof GitHubCredentials>): string {
  try {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - CLOCK_SKEW_SECONDS, exp: now + JWT_SECONDS, iss: credentials.GITHUB_APP_ID })}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(credentials.GITHUB_APP_PRIVATE_KEY));
    return `${unsigned}.${signature.toString("base64url")}`;
  } catch {
    throw new ReportingError("GITHUB_APP_PRIVATE_KEY must be the GitHub App's valid PEM private key");
  }
}

export class GitHubApi {
  private readonly token: string;
  readonly appId: number;
  readonly repository: string;
  readonly owner: string;

  private constructor(token: string, appId: number, owner: string, repositoryName: string) {
    this.token = token;
    this.appId = appId;
    this.owner = owner;
    this.repository = `${owner}/${repositoryName}`;
  }

  private static async installation(environment: unknown): Promise<{ authorization: string; path: string; installation: v.InferOutput<typeof Installation> }> {
    const credentials = decode(GitHubCredentials, environment);
    const authorization = jwt(credentials);
    const path = `/app/installations/${credentials.GITHUB_APP_INSTALLATION_ID}`;
    const installation = decode(Installation, await request(authorization, path, "GET"));
    if (installation.app_id !== Number(credentials.GITHUB_APP_ID)) throw new ReportingError("GITHUB_APP_INSTALLATION_ID does not belong to GITHUB_APP_ID");
    return { authorization, path, installation };
  }

  static verifySigning(credentials: v.InferOutput<typeof GitHubCredentials>): void { jwt(credentials); }

  static async verifyAccess(environment: unknown): Promise<void> {
    const { authorization, path, installation } = await this.installation(environment);
    if (!installation.events.includes("check_run")) throw new ReportingError("The GitHub App installation must subscribe to Check run events");
    decode(Token, await request(authorization, `${path}/access_tokens`, "POST", { permissions: PERMISSIONS.approve }));
  }

  static async configureWebhook(environment: unknown, url: URL, secret: string): Promise<void> {
    const credentials = decode(GitHubCredentials, environment);
    const configured = await request(jwt(credentials), "/app/hook/config", "PATCH", { url: url.href, content_type: "json", insecure_ssl: "0", secret });
    decode(v.object({ url: v.literal(url.href), content_type: v.literal("json"), insecure_ssl: v.literal("0") }), configured);
  }

  static async connect(environment: unknown, repositoryName: string, purpose: keyof typeof PERMISSIONS): Promise<GitHubApi> {
    if (!PROJECT_NAME.test(repositoryName)) throw new ReportingError("CircleCI must supply the repository's name");
    const { authorization, path, installation } = await this.installation(environment);
    const access = decode(Token, await request(authorization, `${path}/access_tokens`, "POST", {
      repositories: [repositoryName], permissions: PERMISSIONS[purpose],
    }));
    return new GitHubApi(access.token, installation.app_id, installation.account.login, repositoryName);
  }

  async checks(head: string, query: Record<string, string>): Promise<unknown[]> {
    const collected: unknown[] = [];
    for (let page = 1; ; page++) {
      const parameters = new URLSearchParams({ ...query, per_page: String(PAGE_SIZE), page: String(page) });
      const result = decode(v.object({ check_runs: v.array(v.unknown()) }), await this.read(`/repos/${this.repository}/commits/${head}/check-runs?${parameters}`));
      collected.push(...result.check_runs);
      if (result.check_runs.length < PAGE_SIZE) return collected;
    }
  }

  read(path: string): Promise<unknown> {
    return request(this.token, path, "GET");
  }

  write(path: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> {
    return request(this.token, path, method, body);
  }
}
