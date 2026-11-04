import * as v from "valibot";
import type { Environment } from "./nextnode-toml.ts";
import { decode, GitHubApi, PAGE_SIZE, PositiveId, Pull, ReportingError, Revision } from "./github-api.ts";

const Check = v.object({
  id: PositiveId, external_id: v.nullable(v.string()), app: v.object({ id: PositiveId }),
});
export type Report = { environment: Environment; summary: string; url?: string } & (
  | { status: "queued" | "in_progress" }
  | { status: "completed"; conclusion: "success" | "failure" | "skipped" }
);

export class GitHubChecks {
  private readonly api: GitHubApi;
  constructor(api: GitHubApi) { this.api = api; }

  async mergedPull(revision: string): Promise<Pull> {
    decode(Revision, revision);
    const pulls = decode(v.array(Pull), await this.api.read(`/repos/${this.api.repository}/commits/${revision}/pulls?per_page=${PAGE_SIZE}`));
    const merged = pulls.filter(pull => pull.merged_at && pull.merge_commit_sha === revision && pull.base.ref === "main" && pull.base.repo.full_name === this.api.repository);
    const pull = merged[0];
    if (merged.length !== 1 || !pull) throw new ReportingError("The deployment commit must identify exactly one merged pull request targeting this repository's main");
    return pull;
  }

  private async checks(head: string, query: Record<string, string>): Promise<v.InferOutput<typeof Check>[]> {
    return decode(v.array(Check), await this.api.checks(head, query));
  }

  async publish(pull: Pull, revision: string, workflow: string, report: Report): Promise<void> {
    const name = `Deploy ${report.environment}`;
    const externalId = `nextnode/${workflow}/${report.environment}`;
    const checks = await this.checks(pull.head.sha, { check_name: name, app_id: String(this.api.appId), filter: "all" });
    const matching = checks.filter(check => check.app.id === this.api.appId && check.external_id === externalId);
    if (matching.length > 1) throw new ReportingError("Multiple checks identify the same deployment workflow");
    const existing = matching[0];
    const summary = `${report.summary}\n\n[View the main-branch workflow in GitHub](https://github.com/${this.api.repository}/commit/${revision}/checks)\n\nMerge commit: \`${revision}\`\n\nCircleCI workflow: \`${workflow}\``;
    const body = {
      name, external_id: externalId, status: report.status,
      ...(existing ? {} : { head_sha: pull.head.sha }),
      ...(report.status === "completed" ? { conclusion: report.conclusion, completed_at: new Date().toISOString() } : {}),
      ...(report.status === "in_progress" ? { started_at: new Date().toISOString() } : {}),
      output: { title: report.summary, summary: report.url ? `${summary}\n\n[Open ${report.environment}](${report.url})` : summary, text: "" },
    };
    await this.api.write(`/repos/${this.api.repository}/check-runs${existing ? `/${existing.id}` : ""}`, existing ? "PATCH" : "POST", body);
    console.log(`${name}: ${report.status === "completed" ? report.conclusion : report.status} https://github.com/${this.api.repository}/pull/${pull.number}/checks`);
  }

}
