import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the environment allowlist checks names rather than multiline values", () => {
  const config = readFileSync(CONFIG_PATH, "utf8");
  const command = /step: "Probe: the project's environment holds only the listed names"[\s\S]*?command: '([^\n]*)'/.exec(config)?.[1];
  assert.ok(command);
  const environment = { PATH: process.env.PATH, SUDO_COMMAND: "bash -c\nset -a\nproject command", APP_PROBE: "application" };
  const script = "unset __CF_USER_TEXT_ENCODING\n" + command;
  const accepted = spawnSync("/bin/bash", ["-eo", "pipefail", "-c", script], { encoding: "utf8", env: environment });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const rejected = spawnSync("/bin/bash", ["-eo", "pipefail", "-c", script], {
    encoding: "utf8", env: { ...environment, E2E_LEAK: "probe-only-private-value" },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /not in the list: E2E_LEAK/);
  assert.ok(!rejected.stdout.includes("probe-only-private-value"));
});

const TERMINATOR = "NNPROJECTRUN";
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../circleci/checks.yml");

function wrapperLines(): string[] {
  const config = readFileSync(CONFIG_PATH, "utf8");
  const sectionAt = config.indexOf("\n  project-run:");
  assert.ok(sectionAt > -1, "the configuration defines project-run");
  const keptAt = config.indexOf("\n            kept=(PATH=", sectionAt);
  const endAt = config.indexOf("\njobs:", keptAt);
  assert.ok(keptAt > -1 && endAt > keptAt, "the wrapper builds its environment from the kept list");
  assert.equal(config.split("\n").filter((line) => line.trim() === TERMINATOR).length, 1, "no command body may close the wrapper's literal heredoc");
  return config.slice(keptAt + 1, endAt).trimEnd().split("\n");
}

function runnableScript(lines: string[], stubBin: string): string {
  const execLine = lines.find((line) => line.startsWith("            exec env -i"));
  assert.ok(execLine?.endsWith('-c "$project_command"'), "the restricted shell receives its script separately from stdin");
  assert.ok(lines.some((line) => line.endsWith(`project_command=$(cat \\<<'${TERMINATOR}'`)), "the command capture is a standalone assignment with a quoted heredoc");
  assert.ok(lines.some((line) => line.slice(12) === TERMINATOR), "the terminator stays the heredoc close");
  assert.ok(!lines.some((line) => line.slice(12) === "<< parameters.command >>"), "the parameter is replaced by the recorded body");
  let script = lines.map((line) => line.slice(12)).join("\n") + "\n";
  script = script.replace("\\<<", "<<");
  return script.replace(
    "kept=(PATH=/usr/local/bin:/usr/bin:/bin ",
    `kept=(PATH=${stubBin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin `,
  );
}

test("the expanded project-run wrapper accepts single quotes, guarded substitutions and multiline JavaScript", (t) => {
  const run = mkdtempSync(join(tmpdir(), "wrapper-transport-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const stubBin = join(run, "bin");
  const out = (name: string): string => join(run, "out", name);
  mkdirSync(stubBin);
  mkdirSync(out(""));

  const payload = [
    `node -e 'require("node:fs").readFileSync(0)'`,
    `umask > ${out("umask")}`,
    `printf 'ran-once\\n' >> ${out("exec-count")}`,
    `echo 'outer-guard $(touch ${out("outer-marker")}) \`backtick-guard\` "dq"' > ${out("quoted")}`,
    `r=$(echo three | tr a-z A-Z)`,
    `printf '%s\\n' "$r" > ${out("dollar")}`,
    `[ -z "\${E2E_LEAK:-}" ] || { echo outer-execution > ${out("leak")}; }`,
    `node -e 'const parts = ["js", "multiline"];`,
    `console.log(parts.join(":"));' > ${out("js")}`,
  ].join("\n");

  const stub = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${join(run, "argv")}`,
    `env > ${join(run, "env")}`,
    "shift 3",
    'exec "$@"',
    "",
  ].join("\n");
  writeFileSync(join(stubBin, "sudo"), stub);
  chmodSync(join(stubBin, "sudo"), "755");

  const lines = wrapperLines();
  const paramAt = lines.indexOf(`            << parameters.command >>`);
  assert.ok(paramAt > -1, "the wrapper carries the command parameter");
  lines.splice(paramAt, 1, ...payload.split("\n").map((line) => `            ${line}`));
  const script = runnableScript(lines, stubBin);

  const expanded = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    cwd: run,
    env: { PATH: process.env.PATH, E2E_LEAK: "outer-side" },
    input: script,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(expanded.signal, null, `the wrapper timed out: ${expanded.stderr}`);
  assert.equal(expanded.status, 0, `exit ${expanded.status}: ${expanded.stderr}`);

  assert.deepEqual(
    readFileSync(join(run, "argv"), "utf8").split("\n").slice(0, 7),
    ["-nE", "-u", "project", "bash", "-eo", "pipefail", "-c"],
    "the body runs through the sudo transition argument list",
  );
  const keptEnv: Record<string, string> = {};
  for (const line of readFileSync(join(run, "env"), "utf8").split("\n")) {
    if (line) {
      const separator = line.indexOf("=");
      keptEnv[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  const allowed = new Set([
    "CI",
    "HOME",
    "PATH",
    "npm_config_store_dir",
    "PWD",
    "SHLVL",
    "_",
    "SUDO_COMMAND",
    "SUDO_USER",
    "SUDO_UID",
    "SUDO_GID",
    "SUDO_HOME",
  ]);
  const outside = Object.keys(keptEnv).filter((key) => !allowed.has(key));
  assert.deepEqual(outside, [], "the environment holds only the kept names and the markers of the transition");
  assert.ok(!Object.keys(keptEnv).some((key) => key === "E2E_LEAK" || /^CIRCLE_OIDC/.test(key)), "no token-shaped or outer variable reaches the restricted shell");
  assert.equal(keptEnv.HOME, "/home/project");
  assert.equal(keptEnv.CI, "true");
  assert.equal(keptEnv.npm_config_store_dir, "/home/circleci/.pnpm-store");
  assert.ok(keptEnv.PATH.startsWith(stubBin));

  assert.ok(!exists(out("outer-marker")), "the quoted substitution must never fire");
  assert.ok(!exists(out("leak")), "the body runs only through the cleared environment, never on the outside");
  assert.equal(
    parseInt(readFileSync(out("umask"), "utf8").trim(), 8) & 0o777,
    0o002,
    "the restricted shell runs with the preamble umask",
  );
  assert.equal(readFileSync(out("exec-count"), "utf8").split("ran-once\n").length - 1, 1, "the body runs exactly once");
  assert.equal(
    readFileSync(out("quoted"), "utf8"),
    `outer-guard $(touch ${out("outer-marker")}) \`backtick-guard\` "dq"\n`,
    "quotes reach the restricted shell verbatim",
  );
  assert.equal(readFileSync(out("dollar"), "utf8"), "THREE\n", "dollar substitutions run in the restricted shell");
  assert.equal(readFileSync(out("js"), "utf8"), "js:multiline\n", "multiline JavaScript runs in the restricted shell");
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
