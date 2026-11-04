import * as v from "valibot";
import { ApprovalEvent } from "./src/approval-record.ts";
import { ApprovalDenied, ApprovalUnavailable, authorizeApproval } from "./src/authorize-approval.ts";
import { CircleApproval } from "./src/circle-approval.ts";
import { decode, GitHubApi } from "./src/github-api.ts";
import { GitHubApproval } from "./src/github-approval.ts";
import { GITHUB_WEBHOOK, WorkerSecrets } from "./src/github-service-config.ts";
import { PlatformError } from "./src/platform-error.ts";
import { verifyWebhook } from "./src/verify-webhook.ts";
import { isRecord } from "./src/record.ts";

export default {
  async fetch(request: Request, bindings: WorkerSecrets): Promise<Response> {
    const url = new URL(request.url);
    const isHealth = request.method === "GET" && url.pathname === "/health";
    if (!isHealth && (request.method !== "POST" || url.pathname !== GITHUB_WEBHOOK.pathname)) return new Response("Not found", { status: 404 });
    try {
      const secrets = decode(WorkerSecrets, bindings);
      if (isHealth) { GitHubApi.verifySigning(secrets); return Response.json({ ok: true }); }
      const payload = await verifyWebhook(request, secrets.GITHUB_WEBHOOK_SECRET);
      const eventName = request.headers.get("x-github-event");
      if (eventName === "ping") return Response.json({ accepted: true });
      if (url.origin !== GITHUB_WEBHOOK.origin) throw new ApprovalDenied("Production approvals require the configured webhook origin");
      if (eventName !== "check_run") return Response.json({ ignored: true });
      if (!isRecord(payload) || payload.action !== "requested_action") return Response.json({ ignored: true });
      const parsed = v.safeParse(ApprovalEvent, payload);
      if (!parsed.success) throw new ApprovalDenied("The requested approval event is malformed");
      const event = parsed.output;
      if (String(event.installation.id) !== secrets.GITHUB_APP_INSTALLATION_ID) throw new ApprovalDenied("The approval installation does not match this GitHub App");
      const api = await GitHubApi.connect(secrets, event.repository.name, "approve");
      const github = new GitHubApproval(api);
      try {
        await authorizeApproval(event, github, new CircleApproval(secrets.CIRCLECI_TOKEN));
      } catch (error) {
        await github.notifyFailure(event.check_run.id, PlatformError.describe(error, "Approval service operation failed")).catch(() => {
          console.error(JSON.stringify({ event: "approval-report-failed", check: event.check_run.id }));
        });
        throw error;
      }
      console.log(JSON.stringify({ event: "production-approved", repository: api.repository, check: event.check_run.id, actor: event.sender.id }));
      return Response.json({ approved: true });
    } catch (error) {
      const status = error instanceof ApprovalDenied || error instanceof ApprovalUnavailable ? error.status : 503;
      const reason = PlatformError.describe(error, "Approval service operation failed");
      console.error(JSON.stringify({ event: "approval-refused", status, reason }));
      return Response.json({ approved: false, error: status === 403 ? "Approval refused" : "Approval could not complete. Retry from GitHub." }, { status });
    }
  },
};
