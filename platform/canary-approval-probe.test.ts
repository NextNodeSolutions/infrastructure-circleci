import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import { APPROVAL_PROBE as probe } from './approval-probe-fixtures.ts'

import type { SpawnSyncReturns } from 'node:child_process'
import type { TestContext } from 'node:test'

const TIMEOUT_MS = 30_000
const FAKE_CURL = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = new URL(args.find(argument => argument.startsWith("https://")));
const workflow = ${JSON.stringify(probe.release.workflow)};
const isProduction = ["approved", "production_failed"].includes(process.env.PROBE_RESPONSE);
const finalStatus = process.env.PROBE_RESPONSE === "approved" ? "success" : "failed";
let response;
if (url.hostname === "probe-output.invalid") {
  const messages = {
    refused: "Production requires a successful GitHub approval\\n",
    unrelated: "Resource deployment failed\\n",
    exported: "application (probe): exported\\nProduction requires a successful GitHub approval\\n",
    approved: "Production deployment passed\\n",
    production_failed: "Production smoke failed\\n"
  };
  response = [{ message: messages[process.env.PROBE_RESPONSE] }];
} else if (url.pathname.endsWith("/pipeline/run")) {
  response = { id: ${JSON.stringify(probe.pipeline)}, number: 1 };
} else if (url.pathname.endsWith("/workflow")) {
  response = { items: [{ id: workflow, status: fs.existsSync(process.env.PROBE_APPROVED) ? finalStatus : "on_hold" }] };
} else if (url.pathname.includes("/api/v2/pipeline/")) {
  response = { id: ${JSON.stringify(probe.pipeline)}, number: 1, state: "created", vcs: { revision: "probe-source-revision" } };
} else if (url.pathname.includes("/approve/")) {
  if (isProduction) throw new Error("The positive canary must wait for GitHub approval, not approve CircleCI directly");
  fs.writeFileSync(process.env.PROBE_APPROVED, "attempted");
  process.exit(0);
} else if (url.pathname.endsWith("/job")) {
  response = { items: [
    { name: "hold", type: "approval", status: "on_hold", approval_request_id: "probe-hold" },
    { name: "deploy-prod", type: "build", status: finalStatus, job_number: 1 }
  ] };
} else if (url.pathname.startsWith("/api/v1.1/")) {
  response = { status: finalStatus, steps: [{ name: isProduction ? "Smoke production" : "Fetch the secrets of production", actions: [{ status: finalStatus, output_url: "https://probe-output.invalid/log" }] }] };
} else {
  throw new Error("Unexpected canary request " + url.pathname);
}
process.stdout.write(JSON.stringify(response));
`

type Outcome =
	| 'refused'
	| 'unrelated'
	| 'exported'
	| 'approved'
	| 'production_failed'

function runCanary(
	context: TestContext,
	outcome: Outcome,
): SpawnSyncReturns<string> {
	const root = mkdtempSync(join(tmpdir(), 'nextnode-canary-probe-'))
	context.after(() => rmSync(root, { recursive: true, force: true }))
	writeFileSync(join(root, 'curl'), FAKE_CURL, { mode: 0o700 })
	writeFileSync(join(root, 'sleep'), '#!/bin/sh\n: >"$PROBE_APPROVED"\n', {
		mode: 0o700,
	})
	const isProduction =
		outcome === 'approved' || outcome === 'production_failed'
	return spawnSync(
		'/bin/bash',
		[
			join(import.meta.dirname, '../scripts/run-canary.sh'),
			'feature-under-review',
		],
		{
			encoding: 'utf8',
			timeout: TIMEOUT_MS,
			env: {
				PATH: [root, process.env.PATH ?? ''].join(delimiter),
				HOME: root,
				LOGS: join(root, 'logs'),
				CIRCLECI_TOKEN: 'probe-only-circle-token',
				...(isProduction ? { WAIT_PRODUCTION: '1' } : { APPROVE: '1' }),
				PROBE_APPROVED: join(root, 'approved'),
				PROBE_RESPONSE: outcome,
			},
		},
	)
}

test("the direct-approval canary passes only for the production guard's refusal", context => {
	const result = runCanary(context, 'refused')
	assert.equal(result.status, 0, result.stderr)
	assert.match(
		result.stdout,
		/PASS: direct CircleCI approval was refused before application production secrets/,
	)
})

test('the production canary waits for GitHub approval and requires deployment success', context => {
	const result = runCanary(context, 'approved')
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /workflow: success/)
	assert.doesNotMatch(result.stdout, /Attempted direct CircleCI approval/)
})

test('the production canary rejects a deployment failure after GitHub approval', context => {
	const result = runCanary(context, 'production_failed')
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stdout, /workflow: failed/)
})

for (const outcome of ['unrelated', 'exported'] satisfies Outcome[]) {
	test(`the direct-approval canary rejects ${outcome} failure evidence`, context => {
		const result = runCanary(context, outcome)
		assert.equal(result.status, 1)
		assert.match(result.stdout, /FAIL: direct approval was not refused/)
	})
}
