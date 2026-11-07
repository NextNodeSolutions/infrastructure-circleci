# Rules for changing this repository

These rules hold for people and agents alike. A directory whose rules differ adds its own `AGENTS.md`. How the platform works is explained in [docs/architecture.md](docs/architecture.md).

## What the project guarantees

A change that weakens one is wrong, even when it compiles.

1. **Every project runs the configuration from `main`.** A merge here is a release to every NextNode project at once. `main` accepts pull requests only, with a squash merge, under the organization rulesets.
2. **No secret value exists in this repository, in CircleCI, or in a log.** A job obtains secrets at run time by trading its OIDC token for a short-lived vault token. No CircleCI context exists, so nothing can be hidden in one.
3. **A branch pipeline touches no secret.** Only jobs that run on `main` log in to the vault, so a pull request from any author is safe to run.
4. **Project code never runs with a job token or the vault token in its environment.** Install, build and migration commands run after the vault step has ended, in an environment built from a list of names written in the configuration. A variable the list does not name is absent, whoever added it.
5. **An application's production secrets are read only by the production deployment job.** That job runs on `main` only, after the approval. The vault cannot tell the deployment jobs apart, so this configuration is what does.
6. **A project repository holds no CI file.** Its pipeline definition points at this repository. Anything a project must express goes through `nextnode.toml` or its package scripts.
7. **A project reaches its own state and its own secrets, and no other project's.** The repository's name, as CircleCI checked it out, names the Pulumi project and the vault project. A value of the project's files never names either, because the vault identity and the state bucket are shared by every project.
8. **GitHub authorizes production in the reviewed workflow.** The approval service accepts only active GitHub Core members. The production job verifies the App-owned approval for its exact workflow, project and revision before exporting application production secrets. Configuration, project-environment, historical-rerun and SSH administrators remain trusted and can replace or bypass this workflow.

## Architecture rules

- **Keep CircleCI as the execution engine and GitHub as the sole operational interface.** Expose checks, deployment progress, failure details and required actions in GitHub, so normal operation never requires CircleCI's UI. Prefer native integration or direct reporting from CI; do not introduce a hosted reporting or approval service unless explicitly requested.
- **Keep the configuration one file, and the programs one package.** Every project runs the same workflow. Behavior differs through what the job reads from `nextnode.toml`, never through a second file or a per-project branch of the configuration. A step is a few lines of shell that call a program of the platform package by name; a program never lives in a YAML string, where nothing checks it. Applications acquire the package from `main`. Only the exact canary project may acquire a reviewed `program_ref`, pinned to the configuration's recorded commit, for CI verification. Project commands still run as the restricted user. Shared service publication always acquires `main` and needs its separate authorization.
- **A project's mistake fails at the earliest job that can see it.** The configuration check job reads `nextnode.toml` for every environment with the same program as the read step, so a rule added to the read step reaches every pull request with no second copy. A check that needs no secret and no project code never waits for the deployment job, and one that must wait says so on the configuration page.
- **Pulumi owns every resource it can express. Wrangler only bundles the Worker, as the project user, and uploads it, as the platform user.** Resource creation that happens outside Pulumi is invisible to the state and will be fought by the next run. Wrangler is the Cloudflare port of the deployment, and another target gets its own port behind the same job.
- **Project code runs as the project user, platform tools as the platform user.** A new step that runs anything from the project repository goes through `project-run`. A step that holds a platform credential never runs project code, reads only what the repository committed, and takes the build's output only as a copy it makes after ending every project process, refusing links. That is why the project user bundles the Worker and the platform uploads the copy without bundling, why Wrangler's configuration is generated from the committed `nextnode.toml` into the platform user's directory before any project code, and why a `build` key in `nextnode.toml` is refused.
- **A value the project controls never reaches a shell as code.** Values from `nextnode.toml` or from a deployment go through the platform's JSON files and `nn`, never into `BASH_ENV`, an `eval`, or an unquoted expansion. The one exception is the migration command, which is the project's own command run as the project user. A file the platform writes once the project user exists goes under the platform user's own directory, never in a shared place, and a directory the platform loads code from is recreated empty first.
- **Migrations are the project's command, named in `nextnode.toml`.** The platform does not know the project's migration tool and must not guess it.
- **Identifiers that are not secret still never reach a project repository as copies.** They live in the vault, in the registration script, or in this configuration, so that a rename happens in one place. The one identifier a project carries is its repository's name, which CircleCI supplies and the job trusts.
- **A pipeline parameter reaches a step as a variable, never as text of its command.** A parameter is substituted into the configuration before the shell runs, so a value placed in a command is code. The job validates the value's shape and refuses, outside the canary, what only the canary may set.
- **A vendor workaround is written next to the vendor fact that forced it.** The constraints table in the architecture page names where to re-check each fact. Remove the workaround when the fact changes, in the same change.

## Code rules

- **In a `run` step, escape a heredoc marker as `\<<`.** CircleCI reserves `<<` in configuration files and fails the pipeline otherwise.
- **Write a `run` step on one line when its name would repeat its command.** A named step earns its name by explaining something the command does not.
- **Pin the executor image by tag and every platform tool by exact version.** A floating version changes the toolchain under every project at once. The Pulumi CLI and the Cloudflare plugin are released with their SDKs under one version and are installed at the versions the platform package's manifest pins: a bump of the SDKs is the bump of the tools.
- **Comments are in English and explain intent, not syntax.** The file is read by people who did not write it, in every project's pipeline view.
- **Keep the install step strict.** The pnpm version comes from the project's `packageManager` field, accepted only as a plain version, and the lockfile is frozen. A project that drifts fails loudly at the first step instead of deploying something else.

## Checks

There is no local validator for the configuration in this repository. A change to a pipeline file is checked by running the canary's pipeline from the branch with the canary script of this repository, which triggers it through the CircleCI API with the configuration branch and the platform package set to the pull request branch and the checkout set to the canary's `main`, and prints the job outputs. The pipeline names the revision of its configuration branch, and each job prints the OIDC claims it runs under, so the run's records name what executed. A green canary run is the check that a pull request cites.

A change to the platform package passes its own type check and a preview run of the driver against the canary's stack, as its `AGENTS.md` describes, before the canary run of the pipeline from the branch.

A change to the boundary between the platform and the project, which is anything about users, sudo, the sourced file, the platform's directory, the vault step or what Wrangler reads, cites a green run of the probe job as well, started on the canary with the `probe` pipeline parameter. Before its pull request is opened it goes through the adversarial reviews at the highest effort the harness offers, in Claude Code `/code-review xhigh` then `/security-review`, and a finding is fixed by closing the whole class of channel it used, never that one finding. The pull request names each guarantee it touches and the run that covers it.

A documentation change is checked with the docs checker of the `project-docs` skill, which renders every Mermaid block and follows every relative link.

## Commits

One intention per commit, in the conventional form the history shows, such as `ci:` for pipeline files and `docs:` for documentation. Pull requests are squash-merged, so the pull request title becomes the commit on `main` and must read as one.

## Documentation

The docs carry concepts, flows, states, rules and reasons. They never copy what the repository already says. A line fails if the code can change without a change of intent and make the line false. Identifiers of shared external resources are the one exception, kept on the architecture page until the registration script owns them.

**The docs describe the intended behavior.** That covers `docs/`, the README and the `AGENTS.md` files. When a change makes them wrong, do not just rewrite them to match. First check that the change is expected: the task asks for it, or the user confirms it.
- If it is expected, update the docs in the same commit as the change.
- If it is not, the docs win. Bring the code back in line with them, or stop and ask.

## Working against real systems

- **The canary repository is free to use, always.** Push, merge, rerun, break it. It exists for end-to-end runs of this configuration and holds nothing else.
- **The CircleCI organization, the Infisical organization and the Cloudflare account are shared state.** Creating, renaming or deleting anything there that is not the canary's needs the user's go-ahead first, and a cleanup afterwards. List before acting, act on exact identifiers, list again to show the result.
- **Secret values enter through the Infisical dashboard or a non-echoing prompt, never through a chat, an argument, a log or a file.** Verify a write by its name, never by its value. A value that was displayed is compromised and gets rotated.
- **Deleting an Infisical identity that has delete protection takes two calls.** Send its name together with `hasDeleteProtection: false`, because the flag alone is ignored, then delete.

## Extending

- **A new job** goes into the pipeline's workflow with its `requires` chain and, when it needs the vault, the same login and export steps as the deployment job. A second workflow exists for one reason only: a job selected by a pipeline parameter that must run in place of the pipeline, as the probe job is. It is validated on the canary before merge.
- **A new resource kind** is a key of the schema of `nextnode.toml` in the platform package, which the read step parses into the spec, and a Pulumi resource of the platform package's program keyed by that entry, with its identifier returned as a stack output for the Worker bindings. The key is documented on the configuration page and its failure mode in the table on the architecture page.
- **A new guarantee, or a new mechanism behind one,** comes with its probe: a step of the probe job that runs the attack as the project would and passes only when the attack fails. The docs name the guarantee, the probe is what keeps it true on every change.
- **A new deployment target** is a port beside the Wrangler one, behind the same job and the same `nextnode.toml` keys where they apply.
- **A new project** is registered by the registration script, never by clicking through the three dashboards.
