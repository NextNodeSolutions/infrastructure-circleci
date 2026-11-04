import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CONFIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../circleci/checks.yml"), "utf8");

function block(section: "commands" | "jobs", name: string): string {
  const sectionHead = CONFIG.indexOf(`\n${section}:`);
  assert.notEqual(sectionHead, -1, `the configuration holds no ${section} section`);
  const offset = CONFIG.slice(sectionHead).indexOf(`\n  ${name}:`);
  assert.notEqual(offset, -1, `${section} holds no block named ${name}`);
  const head = sectionHead + offset;
  const bodyStart = CONFIG.indexOf("\n", head + 1) + 1;
  const sibling = /^  [^\s#]/m.exec(CONFIG.slice(bodyStart));
  return CONFIG.slice(head, sibling ? bodyStart + sibling.index : CONFIG.length);
}

test("credential-bearing jobs use platform acquisition and shared service publication pins main", () => {
  for (const name of ["deploy", "github-report", "github-service"]) {
    const section = block("jobs", name);
    assert.match(section, /- platform-package/);
    assert.ok(!section.includes("branch-package"), `${name} must not use the project-owned package`);
  }
  assert.match(block("jobs", "github-service"), /NEXTNODE_PACKAGE_REF: main/);
});

function runRouting(programRef: string, projectId: string, packageRef = ""): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "nextnode-package-routing-"));
  const command = block("commands", "branch-ref").split("command: |\n")[1];
  assert.ok(command);
  try {
    const inspect = command + "\nnode -p \"JSON.stringify(require('/home/circleci/branch.json'))\"";
    return spawnSync("bash", ["-eo", "pipefail", "-c", inspect.replaceAll("/home/circleci/branch.json", join(directory, "branch.json"))], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NEXTNODE_PROGRAM_REF: programRef,
        NEXTNODE_PACKAGE_REF: packageRef,
        NEXTNODE_CANARY_PROJECT_ID: /NEXTNODE_CANARY_PROJECT_ID: (\S+)/.exec(CONFIG)?.[1],
        NEXTNODE_CONFIG_REVISION: "a".repeat(40),
        CIRCLE_PROJECT_ID: projectId,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("non-canary projects refuse branch packages but accept main", () => {
  const refused = runRouting("reviewed-branch", "another-project");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /a platform package other than main is for the canary/);
  assert.equal(runRouting("main", "another-project").status, 0);
});

test("only the exact canary project can acquire a reviewed branch", () => {
  const canaryId = /NEXTNODE_CANARY_PROJECT_ID: (\S+)/.exec(CONFIG)?.[1];
  assert.ok(canaryId);
  const acquired = runRouting("reviewed-branch", canaryId);
  assert.equal(acquired.status, 0);
  assert.equal(acquired.stdout.trim(), JSON.stringify({ ref: "reviewed-branch", revision: "a".repeat(40) }));
  assert.notEqual(runRouting("reviewed-branch", `${canaryId}-suffix`).status, 0);
});

test("malformed refs cannot become clone options or shell commands", () => {
  for (const ref of ["--upload-pack=evil", "bad..ref", "$(touch injected)", "bad ref"]) {
    const refused = runRouting(ref, "another-project");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /the platform package ref is not a git ref/);
  }
});

test("service acquisition pins main and its job refuses branch publication before credentials", () => {
  const service = block("jobs", "github-service");
  const guard = service.indexOf('[ "$NEXTNODE_PROGRAM_REF" = main ]');
  assert.ok(guard !== -1 && guard < service.indexOf("      - platform-package"));
  assert.equal(runRouting("reviewed-branch", "another-project", "main").status, 0);
});

test("the canary jobs acquire the branch under the project user, after the boundary", () => {
  for (const name of ["checks", "probe"]) {
    const section = block("jobs", name);
    assert.ok(!section.includes("NEXTNODE_PACKAGE_REF"), `${name} must hold no package pin`);
    const isolate = section.indexOf("      - isolate-project");
    const acquire = section.indexOf("      - branch-ref");
    const install = section.indexOf("      - branch-package");
    assert.ok(isolate !== -1 && acquire !== -1 && install !== -1 && isolate < acquire && acquire < install, `${name} must acquire the branch only after the boundary`);
    const firstRun = section.indexOf("      - project-run:");
    assert.ok(firstRun !== -1 && install < firstRun, `${name} runs no branch execution before the branch install`);
  }
  assert.match(block("jobs", "probe"), /platform-package/, "the probe draws its trusted fixtures from the platform tree");
});

test("platform acquisition uses the validated canary ref and records its exact commit", () => {
  const platform = block("commands", "platform-package");
  assert.match(platform, /- branch-ref/);
  assert.match(platform, /--branch "\$ref"/);
  assert.match(platform, /rev-parse HEAD/);
  assert.match(platform, /\[ "\$revision" = "\$expected" \]/);
  const branch = block("commands", "branch-ref");
  assert.match(branch, /ref=\$\{NEXTNODE_PACKAGE_REF:-\$NEXTNODE_PROGRAM_REF\}/);
  assert.match(branch, /\[\[ \$ref =~ \^\[A-Za-z0-9\]/);
  assert.match(branch, /\[ "\$ref" = main \] \|\| \[ "\$CIRCLE_PROJECT_ID" = "\$NEXTNODE_CANARY_PROJECT_ID" \]/);
  const acquire = block("commands", "branch-package");
  assert.match(acquire, /- project-run:/, "the branch clone and install run under the project user, behind the boundary");
});

test("application commands and project-owned package probes run under the project user", () => {
  const probe = block("jobs", "probe");
  assert.ok(probe.includes('- project-run:\n          command: node --test --test-concurrency=1 "$HOME/platform-src/platform/"*probe.test.ts'), "the branch tests run project-side");
  const attackHead = probe.indexOf('step: "Probe: a Wrangler key that names, builds, routes or binds the Worker, and a path outside the repository, are refused"');
  assert.ok(attackHead > -1, "the attack step exists");
  const attack = probe.slice(probe.lastIndexOf("      - project-run:", attackHead));
  assert.ok(attack.startsWith("      - project-run:\n          step: \"Probe: a Wrangler key that names, builds, routes or binds the Worker, and a path outside the repository, are refused\"\n"), "the attack step runs under the project user");
  assert.match(attack, /checkout=\$PWD/);
  assert.match(attack, /fresh\(\) \{ work=\$\(mktemp -d\) && cp -r "\$checkout"\/\. "\$work" && cd "\$work"; \}/);
  assert.match(attack, /node "\$HOME\/platform-src\/platform\/read\.ts"/);
  assert.match(attack, /toml = require\(process\.argv\[2\] \+ "\/node_modules\/smol-toml"\)/);
  const checks = block("jobs", "checks");
  assert.ok(checks.includes('- project-run:\n          command: node "$HOME/platform-src/platform/read.ts" --repository "$CIRCLE_PROJECT_REPONAME" --check'), "the checks reader runs project-side");
});

test("restricted acquisition uses the recorded revision without inheriting platform variables", context => {
  const directory = mkdtempSync(join(tmpdir(), "nextnode-restricted-acquire-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const revision = "b".repeat(40);
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = clone ]; then mkdir -p "$HOME/platform-src/platform"; exit 0; fi
[ "$1" = -C ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ] || exit 1
printf '%s\\n' '${revision}'
`, { mode: 0o700 });
  writeFileSync(join(bin, "corepack"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const record = join(directory, "branch.json");
  writeFileSync(record, JSON.stringify({ ref: "reviewed-branch", revision }));
  const command = block("commands", "branch-package").split("command: |\n")[1];
  assert.ok(command);
  const script = command.replaceAll("/home/circleci/branch.json", record);
  const environment = { HOME: directory, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const accepted = spawnSync("/bin/bash", ["-eo", "pipefail", "-c", script], { env: environment, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /the project's branch clone is at b{40}/);
  writeFileSync(record, JSON.stringify({ ref: "reviewed-branch", revision: "c".repeat(40) }));
  const refused = spawnSync("/bin/bash", ["-eo", "pipefail", "-c", script], { env: environment, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /the acquired project package differs from the reviewed configuration revision/);
});

test("the claims step prints the claims and the revision, never a token value", () => {
  const text = block("commands", "token-claims");
  assert.match(text, /console\.log\(name \+ ": absent"\)/);
  assert.match(text, /console\.log\(name, claims\.aud, JSON\.stringify\(claims\.sub\)\)/);
  assert.ok(!/console\.log\((?:t|claims|\*?name\s*=)\)/.test(text), "the claims step must print no token value");
});

test("the claims step runs at the start of every job that holds or proves a credential", () => {
  for (const name of ["deploy", "github-report", "github-service", "probe"]) {
    assert.match(block("jobs", name), /^      - token-claims$/m, `${name} must run the claims step`);
  }
});

test("the run names its configuration revision to the jobs", () => {
  assert.match(CONFIG, /config_revision:/);
  assert.match(CONFIG, /NEXTNODE_CONFIG_REVISION: << pipeline\.parameters\.config_revision >>/);
});

test("the branch service preview no longer exists", () => {
  assert.ok(!CONFIG.includes("github_service_mode"), "the preview mode of a branch service package must be gone");
  assert.ok(!CONFIG.includes("--preview"), "the service job must publish, not preview");
});

test("the probe prints the claims, proves its token, removes it, then runs no branch code", () => {
  const probe = block("jobs", "probe");
  const claims = probe.indexOf("      - token-claims");
  const holder = probe.indexOf("Hold the job's tokens for the recovery probes");
  const forget = probe.indexOf("      - forget-job-token");
  const guard = probe.indexOf("name: The probe job runs on the canary only");
  assert.ok(claims !== -1 && forget !== -1 && claims < forget && forget < guard, "the tokens must be printed, then removed before the probe code");
  assert.ok(claims < holder && holder < forget, "the positive control must hold and prove the token before the removal");
  const tools = probe.indexOf("      - platform-tools");
  const isolate = probe.indexOf("      - isolate-project");
  assert.ok(tools > -1 && tools < isolate, "the Pulumi toolchain installs as the platform user, before the boundary");
  assert.equal((probe.match(/- isolate-project/g) ?? []).length, 1, "the probe isolates the project exactly once");
});

for (const initial of ["missing", "existing"]) {
  test(`job token removal handles ${initial} BASH_ENV and preserves its contents`, context => {
    const directory = mkdtempSync(join(tmpdir(), "nextnode-token-removal-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const environmentFile = join(directory, "bash-env");
    if (initial === "existing") writeFileSync(environmentFile, "export KEPT_PROBE=preserved\n");
    const command = block("commands", "forget-job-token").split("command: |\n")[1];
    assert.ok(command);
    const inspect = command + '\nunset KEPT_PROBE\n. "$BASH_ENV"\ntokens=${!CIRCLE_OIDC_TOKEN@}\nprintf "%s|%s" "$tokens" "${KEPT_PROBE-absent}"';
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", inspect], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BASH_ENV: environmentFile, CIRCLE_OIDC_TOKEN_V2: "probe-marker", CIRCLE_OIDC_TOKEN_V3: "probe-marker" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, initial === "existing" ? "|preserved" : "|absent");
  });
}

test("the checks job removes the job tokens before any code runs", () => {
  const checks = block("jobs", "checks");
  const forget = checks.indexOf("      - forget-job-token");
  assert.ok(forget !== -1 && forget < checks.indexOf("      - checkout"), "the token removal must precede the checkout");
});

test("the vault exchange uses the V3 job token", () => {
  const login = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vault-login.ts"), "utf8");
  assert.match(login, /CIRCLE_OIDC_TOKEN_V3/);
  assert.ok(!login.includes("CIRCLE_OIDC_TOKEN_V2"), "the exchange must not fall back to the V2 token");
});

test("the credential exchange guards name the V3 token", () => {
  const deploy = block("jobs", "deploy");
  assert.match(deploy, /\$\{CIRCLE_OIDC_TOKEN_V3:\?/, "the deployment exchange must require the V3 token");
  for (const name of ["deploy", "github-report", "github-service"]) {
    assert.ok(!block("jobs", name).includes("CIRCLE_OIDC_TOKEN_V2:?"), "no job may keep a V2 prerequisite");
  }
});

test("the configuration restores and saves no cached content", () => {
  const config = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../circleci/checks.yml"), "utf8");
  assert.ok(!config.includes("restore_cache"), "no job may restore cache content written by another run");
  assert.ok(!config.includes("save_cache"), "no job may save cache content for another run to restore");
});
