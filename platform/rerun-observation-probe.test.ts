import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../scripts/run-canary.sh");

const OBSERVATION = "rerun_observation() {";

// The verdict lives in run-canary.sh: this probe executes that recorded source against
// stubbed CircleCI responses, never a rewritten copy.
function observationFunction(): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const start = script.indexOf(OBSERVATION);
  assert.ok(start > -1, "run-canary.sh defines rerun_observation");
  const close = script.indexOf("\n}", start);
  assert.ok(close > -1, "rerun_observation closes");
  const fn = script.slice(start, close + 2);
  assert.ok(!fn.includes("RERUN_EXPECT_POLICY_DENIED"), "unobserved denial contracts cannot authorize success");
  assert.ok(fn.includes("exit 1"), "the observation must propagate failure");
  assert.ok(fn.includes("report_workflow"), "the observation must still report the rerun's jobs");
  return fn;
}

interface Case {
  name: string;
  post: string;
  poll: string;
  // seconds past the observation hour: the poll loop leaves the window at once, status
  // stays unknown, and the script must refuse rather than report success.
  seconds?: string;
  expected?: string;
  accept: boolean;
}

const CASES: Case[] = [
  { name: "a successful rerun", post: '{"id":"wf-a"}', poll: '{"status":"success"}', accept: true },
  { name: "an unexpected failure", post: '{"id":"wf-b"}', poll: '{"status":"failed"}', accept: false },
  { name: "an unexpected error", post: '{"id":"wf-c"}', poll: '{"status":"error"}', accept: false },
  { name: "an unexpected cancellation", post: '{"id":"wf-d"}', poll: '{"status":"canceled"}', accept: false },
  { name: "an unauthorized rerun", post: '{"id":"wf-e"}', poll: '{"status":"unauthorized"}', accept: false },
  {
    name: "a rerun that never ends",
    post: '{"id":"wf-f"}',
    poll: '{"status":"pending"}',
    seconds: "3610",
    accept: false,
  },
  {
    name: "a claimed policy denial without an observed vendor contract",
    post: '{"id":"wf-g"}',
    poll: '{"status":"canceled","errors":[{"type":"policy","message":"the configuration did not comply with the organization policy"}]}',
    expected: "policy",
    accept: false,
  },
  {
    name: "an expected denial the record does not name",
    post: '{"id":"wf-h"}',
    poll: '{"status":"failed","message":"ssh key not available for rerun"}',
    expected: "policy",
    accept: false,
  },
  {
    name: "a timeout with incidental matching policy text",
    post: '{"id":"wf-timeout","message":"policy"}',
    poll: '{"status":"pending","message":"policy"}',
    seconds: "3610",
    expected: ".*",
    accept: false,
  },
  {
    name: "a rerun request refused outright",
    post: '{"message":"rerun access is refused"}',
    poll: '{"status":"success"}',
    accept: false,
  },
];

function sandbox(fn: string, c: Case, dir: string): string {
  return [
    "set -eu",
    `SECONDS=${c.seconds ?? "0"}`,
    "RERUN_POLL=0",
    "CC=https://circleci.com/api/v2",
    `LOGS=${dir}`,
    "id=wf-main",
    "pipeline=pl-main",
    ...c.expected ? [`RERUN_EXPECT_POLICY_DENIED=${JSON.stringify(c.expected)}`] : [],
    `post_body=${JSON.stringify(c.post)}`,
    `poll_body=${JSON.stringify(c.poll)}`,
    "api() { local a",
    "  for a in \"$@\"; do",
    "    case \"$a\" in",
    "      */rerun) printf %s \"$post_body\" ; return;;",
    "      */pipeline/*) printf '{}' ; return;;",
    "      http*) printf %s \"$poll_body\" ; return;;",
    "    esac",
    "  done }",
    "redact() { cat; }",
    "report_workflow() { echo reported; }",
    fn,
    "rerun_observation false",
  ].join("\n");
}

function runCase(fn: string, c: Case): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "rerun-observation-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sandbox.sh"), sandbox(fn, c, dir));
    const run = spawnSync("/bin/bash", ["--noprofile", "--norc", join(dir, "sandbox.sh")], {
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the rerun observation accepts only successful execution", () => {
  const fn = observationFunction();
  for (const c of CASES) {
    const run = runCase(fn, c);
    if (c.accept) {
      assert.equal(run.status, 0, `${c.name}: the observation must accept (${run.out})`);
    } else {
      assert.equal(run.status, 1, `${c.name}: the observation must refuse (${run.out})`);
      assert.match(
        run.out,
        /FAIL: rerun ended|access is refused/,
        `${c.name}: the refusal must name the verdict (${run.out})`,
      );
    }
  }
});

test("the timeout leg reports the unknown status and refuses", () => {
  const timeout = CASES.find((c) => c.seconds !== undefined);
  assert.ok(timeout, "the case list carries a timeout leg");
  const run = runCase(observationFunction(), timeout);
  assert.equal(run.status, 1);
  assert.match(run.out, /unknown/, `the timeout reports the unknown status (${run.out})`);
});
