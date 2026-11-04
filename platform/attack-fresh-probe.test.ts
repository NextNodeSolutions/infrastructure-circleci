import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../circleci/checks.yml");
const MUTATION = "mutation-of-the-first-attack-case";
const ORIGINAL = 'name = "probe"\nproject = { name = "probe-project" }\n';

function harnessLines(config: string): string[] {
  const freshAt = config.indexOf("fresh() { work=$(mktemp -d)");
  assert.ok(freshAt > -1, "the probe harness defines fresh()");
  const freshLineStart = config.lastIndexOf("\n", freshAt) + 1;
  const freshLineEnd = config.indexOf("\n", freshAt);
  const freshLine = config.slice(freshLineStart, freshLineEnd);
  const previousStart = config.lastIndexOf("\n", freshLineStart - 2) + 1;
  const previousLine = config.slice(previousStart, freshLineStart - 1);
  return [previousLine, freshLine].map((line) => line.replace(/^ {12}/, ""));
}

function recordedHarness(): string {
  const config = readFileSync(CONFIG_PATH, "utf8");
  assert.ok(config.includes("checkout=$PWD"), "the harness captures the checkout before the first fresh");
  assert.ok(!config.includes('cp -r . "$work"'), "fresh no longer copies the current working tree");
  return config;
}

function flowScript(configText: string, sandbox: string, withCapture: boolean): string {
  const lines = withCapture ? harnessLines(configText) : harnessLines(configText).slice(1);
  return [
    "set -e",
    `cd '${join(sandbox, "checkout")}'`,
    ...lines,
    "fresh",
    "test ! -e .git",
    `printf '${MUTATION}\\n' >> nextnode.toml`,
    `cp nextnode.toml '${join(sandbox, "after-first.toml")}'`,
    "fresh",
    `cp nextnode.toml '${join(sandbox, "after-second.toml")}'`,
    "",
  ].join("\n");
}

function runFlow(sandbox: string, script: string): void {
  const run = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    cwd: sandbox,
    input: script,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.signal, null, `the harness timed out: ${run.stderr}`);
  assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
}

test("every attack case starts from the original unmodified checkout", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "attack-fresh-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  mkdirSync(join(sandbox, "checkout"));
  writeFileSync(join(sandbox, "checkout", "nextnode.toml"), ORIGINAL);
  mkdirSync(join(sandbox, "checkout", ".git"));
  writeFileSync(join(sandbox, "checkout", ".git", "metadata"), "excluded-checkout-metadata", { mode: 0o000 });

  runFlow(sandbox, flowScript(recordedHarness(), sandbox, true));

  const first = readFileSync(join(sandbox, "after-first.toml"), "utf8");
  assert.ok(first.includes(MUTATION), "the first attack case leaves its mutation in its own copy");
  const second = readFileSync(join(sandbox, "after-second.toml"), "utf8");
  assert.equal(second, ORIGINAL, "the next case starts from the original unmodified checkout");
});

test("the regression rejects a harness that copies the current working tree", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "attack-fresh-old-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  mkdirSync(join(sandbox, "checkout"));
  writeFileSync(join(sandbox, "checkout", "nextnode.toml"), ORIGINAL);

  const config = recordedHarness();
  const fresh = harnessLines(config).at(-1);
  assert.ok(fresh);
  const oldHarness = config
    .replace("            checkout=$PWD\n", "")
    .replace(
      fresh,
      'fresh() { work=$(mktemp -d) && cp -r . "$work" && cd "$work"; }',
    );
  assert.ok(!oldHarness.includes("checkout=$PWD"), "the old harness shipped no checkout capture");

  runFlow(sandbox, flowScript(oldHarness, sandbox, false));

  const second = readFileSync(join(sandbox, "after-second.toml"), "utf8");
  assert.ok(second.includes(MUTATION), "copying the current tree leaks one case's mutation into the next, which the green leg refuses");
});
