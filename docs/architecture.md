# Architecture

This page explains how a change in a NextNode project repository becomes a deployment on Cloudflare, which systems take part, what each boundary promises, and what a failure leaves behind. The rules for changing this repository are in [AGENTS.md](../AGENTS.md).

## Principles

Four choices shape everything below.

- **One source of truth.** The pipeline configuration lives in this repository on `main`. A project repository holds no CI file. It declares what it needs in `nextnode.toml` and exposes a handful of package scripts.
- **No machinery beyond the need.** Every mechanism in the chain exists because a cheaper one failed a concrete requirement. When a vendor adds the feature that made a workaround necessary, the workaround goes.
- **The trust perimeter is the human accounts.** A compromise of the GitHub, CircleCI, Infisical or Cloudflare account of a maintainer is a compromise of everything. The platform does not pretend to isolate projects from each other beyond that perimeter, so it never pays for isolation that the account model would undo.
- **No long-lived secret inside the pipeline.** A job proves who it is with a short-lived OpenID Connect (OIDC) token and trades it for a short-lived vault token. Deployment and approval credentials stay in the vault and reach only trusted platform processes.

## The parts

```mermaid
flowchart LR
    subgraph GitHub
        P[Project repository]
        I[infrastructure on main]
    end
    subgraph CircleCI
        D[Pipeline definition of the project]
        W[Workflow]
    end
    subgraph Infisical
        V[Platform project and one project per application]
    end
    subgraph Cloudflare
        R[Resources such as DNS, D1, KV, R2, Queues, Access]
        K[Worker code and static assets]
    end
    P -- push --> D
    I -- configuration file --> D
    D --> W
    W -- OIDC login then export --> V
    W -- Pulumi --> R
    W -- Wrangler --> K
```

Each boundary carries a contract.

| Boundary | Contract |
| --- | --- |
| Project repository to CircleCI | A push on any branch starts a pipeline. The project is cloned at the pushed ref. The project supplies what [configuration.md](configuration.md) lists: `nextnode.toml`, which also carries the Worker's Wrangler keys, a pinned `packageManager` and a few scripts. |
| This repository to CircleCI | The pipeline definition of every project reads its configuration file from `main` of this repository. CircleCI's GitHub App integration allows the configuration source and the checkout source to be different repositories. A merge here is a release to every project. |
| CircleCI to Infisical | Each job receives several OIDC tokens under names CircleCI chooses. The one the job presents has a subject that names the CircleCI organization, the project, the user who caused the run, the repository and the git ref. Infisical accepts it for one machine identity, bound to the organization and to the `main` ref of the organization's repositories, and returns a vault token that expires within minutes. |
| Job to the platform package | Pulumi owns every Cloudflare resource it can express. The package's program receives what the job read from `nextnode.toml`, keeps its state in an R2 bucket of the platform account, one stack per project and environment, and returns the identifiers the Worker needs as stack outputs. |
| Job to Wrangler | Wrangler does only what Pulumi cannot do cleanly, which is bundling the Worker, as the project user, and uploading code and static assets, as the platform user. It reads the binding identifiers Pulumi produced. It is the Cloudflare-specific port of the deployment. Another target, such as AWS, gets its own port behind the same job. |
| Job to the project | The project is its repository: the repository's name, as CircleCI checked it out, names the Pulumi project and the vault project, and no value of the project's files names either. The project's own commands run for install, build and migrations, as a second user of the job. Their environment is built from a list written in the configuration, plus the application's secrets of the environment being deployed, and nothing else: not the platform's credentials, not a token, not anything that would let them talk to the vault. |

## The pipeline

```mermaid
sequenceDiagram
    autonumber
    participant G as GitHub
    participant C as CircleCI
    participant I as infrastructure main
    participant P as Project checkout
    G->>C: push event through the GitHub App
    C->>I: read the pipeline configuration
    C->>P: clone the project at the pushed ref
    C->>C: checks, nextnode.toml of every environment first
    opt ref is main
        C->>C: deploy-dev, which halts at once when the project declares no development environment
        C->>G: Publish deployment checks and production approval on the original PR
        G->>C: Approval service verifies GitHub Core membership and releases the hold
        Note over C,P: Production rechecks the GitHub approval before reading production secrets
        C->>C: deploy-prod
    end
```

Rules that the diagram encodes:

- **A branch gets checks and nothing else.** No job on a branch uses a vault identity, so a pull request from any author can run without exposing anything. Pull requests merge into `main` by squash, under the organization rulesets.
- **`main` is the only deployment branch.** There is no `develop` branch and no release tag. A merge deploys the development environment when the project declares one, then waits for approval, then deploys production.
- **The project decides whether it has a development environment.** A development environment with a database has its own cost and lifecycle, so it is not forced on every project. The workflow is static, so the development job starts for every project and halts as soon as it has read `nextnode.toml` when no development environment is declared; such a project still goes through the approval. The intended end state, listed under open points, reads the file before the jobs are chosen and sends a project without a development environment to production straight after the checks.
- **GitHub controls production approval.** An active member of the GitHub Core team approves from the original pull request's Checks tab. Production verifies the App-owned decision for its exact workflow, project, revision and pull request, and rechecks current membership and the head of `main` before exporting application production secrets. Approving a hold directly in CircleCI does not satisfy this check.

### Pull request checks

CircleCI reports branch checks through its native GitHub Checks app. After merge, the platform's GitHub App reports each deployment and the production approval on the original pull request's head commit. Progress, approval and failure summaries stay in GitHub's Checks tab, written for the reviewer: a check names what happened and what to do next, never a workflow or commit identifier, which the check's record carries for the programs. A successful deployment check links to the environment it deployed; a failed one links to the native main-branch workflow report, so the failed job remains readable in GitHub. GitHub shows an approval button only on a completed check, so the approval check completes as neutral, waiting rather than failed, until a Core member decides, and then names who approved. Reporting credentials never reach project code. No bot comment or GitHub Actions workflow is needed.

The approval service is a platform-owned Worker. It accepts a GitHub action only after verifying the webhook signature, the App-owned approval record, the original merged pull request, current GitHub Core membership, and the matching CircleCI main-branch workflow. The approval record stays in GitHub, not a separate database. Approvals belong to one workflow; a full rerun creates a new approval, and a failed-job-only rerun cannot reuse the old decision. It records the decision before releasing the CircleCI hold, so a failed API call can be retried from the same check while the workflow is active. An ended workflow, or a hold released before any GitHub decision, requires a full rerun from the native CircleCI check in GitHub and a new approval. Approval failure details update the App-owned check without changing its recorded decision.

The service runs only trusted platform code. Its credentials live in Worker secret bindings and in the platform vault. Jobs fetch only their credential role: resource tools never receive the CircleCI token, webhook secret or GitHub App key; reporting processes receive only the App credentials. Wrangler creates its Worker and uploads its code and secret bindings, as it does for an application Worker, in a separate service workflow that neither checks out nor runs application code. Pulumi owns its domain. Publishing requires a main-branch run on infrastructure or the canary, using the platform package from `main`. The service's changes prove themselves through their probes before the merge, and publish from `main` through CI, so no branch package runs the publication path. Before uploading the service, CI verifies the App's Check run subscription, approval permissions and CircleCI credential. When no service exists, CI installs code and credentials before publishing its domain. Updates first enter an inactive version, whose preview must pass runtime signing and a signed webhook ping before promotion. Preview origins cannot authorize approvals, so an older version cannot release production using a retired webhook key. CI checks the public domain before configuring the App webhook URL and signing key to match the deployed service.

Applications acquire the platform package from `main`. Only the exact canary project may acquire a reviewed package branch for CI verification, and acquisition refuses a commit that differs from the recorded configuration revision. That canary package is trusted platform code. Application commands still run as the restricted project user. Shared service publication always acquires `main` and requires separate authorization. The checks and probe jobs remove job tokens before running project commands, and the vault exchange uses the V2 job token. Claims and the acquired commit are recorded with canary evidence.

GitHub approval constrains the reviewed production workflow, not trusted administrators. Operators who select configuration branches, change privileged startup variables, rerun historical workflows or use SSH can replace or bypass that workflow. External enforcement against those operators is outside this release. Within the reviewed workflow, approving the CircleCI hold directly cannot replace the App-owned Core decision checked before application production-secret export.

Each registered repository requires its branch workflow check before merging into the default branch. The rule accepts reports only from the CircleCI Checks app and requires the branch to be up to date. Deployment approvals and the probe workflow are not pull request requirements. CircleCI's job-level **VCS Status Updates** setting is disabled to avoid publishing the same result twice.

The [CircleCI status updates guide](https://circleci.com/docs/guides/integration/status-updates/) defines the check's name. With the GitHub App integration, it includes the pipeline definition's identifier, so each repository must require its own observed check rather than an organization-wide name. Replacing a pipeline definition requires updating the required check before removing the old definition, or pull requests wait for a check that no longer reports.

`checks` first reads `nextnode.toml` for every environment with the platform package, as the restricted project user and before running project scripts, so a file the deployment jobs would refuse fails the pull request instead of `main` or the production job after its approval. It then installs the pnpm version pinned in the project's `package.json`, installs with a frozen lockfile, and runs the project's lint, format check and type check, and its tests when a `test` script exists. It enforces nothing of its own beyond the file, the pin and the lockfile. The contract with a project is the set of scripts, not their content. Even on a branch, project scripts run as a second user of the job, the same way as in the deployment job.

## The deployment job

One job, parameterized by the environment. It runs on CircleCI's Node image at a pinned tag. Its first step clones the platform package of this repository, which holds every program the job runs, and the next reads `nextnode.toml` with it, so a job that halts has paid for little. It then installs the platform tools at exact versions into the platform user's home: Wrangler, the Infisical CLI, Pulumi with its Cloudflare provider, the last two at the versions the package's manifest pins for their SDKs. Each job installs from pinned versions and a frozen lockfile without restoring executable content from another run. This prevents another pipeline from supplying code through a shared cache.

```mermaid
sequenceDiagram
    autonumber
    participant J as Deployment job
    participant O as CircleCI OIDC issuer
    participant V as Infisical
    participant S as State bucket in R2
    participant F as Cloudflare API
    J->>J: read nextnode.toml, write the spec and the Wrangler configuration, before any project code
    O-->>J: job token whose subject ends with the git ref
    J->>V: login with the identity id and the job token
    V-->>J: vault token that expires within minutes
    J->>V: export the environment's secrets into the step shell
    J->>J: install, build, bundle and migrate in an environment built from a list
    J->>J: end every process of the project user, copy the bundle and the static assets, refusing links
    J->>F: wrangler uploads the copy without bundling and without source maps
    J->>S: pulumi reads and locks the stack state
    J->>F: pulumi attaches the domain to the Worker and converges the environment's resources
    J->>F: smoke request on the health route
    alt production and the smoke passes
        J->>F: promote the uploaded version to all traffic
    else production and the smoke fails
        Note over J,F: the previous version keeps serving
    end
```

Pulumi runs after the upload and before the smoke request. A custom domain attaches to a Worker that exists, and a domain that serves is never touched before its replacement is uploaded. A Worker rename moves the domain to the new Worker once that Worker is there, by deleting the attachment and creating it again, so the domain answers nothing for the few seconds in between. The old Worker stays in the account until deleted by hand. A version uploaded for production receives no traffic until the promotion, so attaching the domain to its Worker first changes nothing for the version that serves.

The platform package of this repository is a Node package that holds every program the job runs: the read step, the filter that turns the vault's export into a file of shell exports, the reader of Wrangler's structured output that writes the deployment record, and the Pulumi program as a function with a driver built on Pulumi's Automation API. The driver does in code what a shell would do in commands: it names the project, points at the state bucket, selects or creates the stack, refreshes, updates, and prints the stack outputs as JSON for the Worker bindings. The job clones this repository at the `program_ref` pipeline parameter, `main` by default, before anything else, installs the package's dependencies with the pnpm its manifest pins, into a store of the platform's own, without restoring a cross-run cache, and runs each program as the platform user from that clone, never from the checkout. The pipeline file keeps a few lines of shell per step and no program of its own. A project cannot set a pipeline parameter from a push, so a project always runs the program `main` holds, as it runs the configuration from `main`. The canary script sets the parameter to the pull request's branch, so a pull request is validated with its own program. This repository is public and holds no secret by construction, which is why the clone needs no credential; were it private, a read-only deploy key in the platform vault would take that place.

The rules that keep the secrets where they belong.

- **The vault token never leaves the step that obtained it.** Login and export happen in one shell. Infisical runs outside the project checkout, with its origin supplied by the platform, so project configuration cannot redirect a credential-bearing request. Nothing is written to the file CircleCI sources before each step.
- **Project code never sees a job token, nor the platform's credentials.** Project commands run as a second user, in a process that replaced the step shell with an environment built from a list: a variable that is not on the list, whoever added it, is not there. The token variables leave the platform's own steps once the vault step has ended, the platform's secrets live in a file only the platform user reads, and root access ends before the first project command. A dependency with a lifecycle script, even one that leaves a process behind, finds neither token in its environment, in a file it may read, or in a process it may inspect.
- **Wrangler is the platform's, not the project's.** It runs as the platform user with the Cloudflare credential, from the platform's directory, on a configuration the read step generated from the committed `nextnode.toml` before any project command ran, into the platform user's directory, so a Wrangler file the build writes in the checkout is never read. Wrangler reads dotenv files from its working directory into its own environment, which is why it never runs from the checkout, and is given an empty one. A key that would make Wrangler run project code, such as a build command, is refused when the job reads it, because the build is the project's build script, run as the project user. Before Wrangler runs, every process of the project user is ended, so nothing of the project changes the checkout while the platform reads it. The platform then copies the bundle the project user built and the static assets into its own directory, refusing any link, hard link or pipe, since a link could name a file of the platform, and Wrangler uploads that copy alone: without bundling again, because a bundler follows every import of the project's code, and without source maps, because a source map comment names a file Wrangler would read. A path of the Wrangler keys that leaves the repository is refused when the job reads it.
- **Routes and domains belong to Pulumi.** The approval service's hostname is reserved and refused as an application domain. The environment's domain is the one `nextnode.toml` declares, attached as a custom domain to the Worker that Wrangler deploys for that environment. A route among the Wrangler keys of `nextnode.toml` is refused when the job reads it, because every deployment would otherwise fight over it.
- **Nothing the project controls is evaluated by a shell.** The values of `nextnode.toml` and the results of a deployment travel between steps as JSON files owned by the platform user, never as lines of a sourced shell file.
- **The platform writes only where the project cannot.** Once the project user exists, every file the platform writes and later reads or loads, from the deployment record to the Pulumi program and its packages, lives in a directory of the platform user's home that the project user cannot write, and a program directory is recreated empty before use. A file created in a shared place after project code ran could be the project's.
- **The platform package runs with the platform's credentials, from the platform's clone.** It is the only code besides this file that runs with the Cloudflare token, and it comes from this repository, at a ref a project cannot choose.
- **An application's secrets are its own.** The job exports the vault project named after the repository CircleCI checked out, found among the projects the identity belongs to, and refuses when there is none or two. A project that named another's vault project in its files would get nothing: the files name no project. The same name selects the Pulumi project in the shared state bucket, so no project can select another's stack.
- **An application's production secrets exist only in `deploy-prod`.** That job exports the application's production environment and no other. It runs on `main` only, after verifying the GitHub approval and current Core membership. Infisical cannot tell the two deployment jobs apart, because both tokens carry the same subject. The central configuration is what tells them apart, and only a pull request here can change it.

Development deploys directly to all traffic. Production uploads a version that receives no traffic, runs the smoke request against its preview URL, and promotes it only on success. The preview URL is the gate, so a production Worker keeps preview URLs enabled.

### The probes

Each rule above is a claim about what project code cannot do, and the `probe` job replays the attacks behind the claims. A step that is the project's attack runs as the project user through the same entry point as a project command. A step that is a change to what the platform reads runs as the platform user on a copy of the checkout. A step passes only when the attack fails, and a refusal is matched on its reason, so a tool that crashes does not pass for one that refuses. The job holds no secret: the files it attacks are stand-ins, written the way the vault step writes the real ones. The approval probes also reject forged signatures, unauthorized approvers, mismatched release bindings, prematurely released holds, malformed or duplicate approval records and application claims to the approval hostname. Scoped credential probes refuse missing keys and project-controlled Infisical configuration. The `APPROVE=1` canary run passes only when the GitHub production guard refuses direct CircleCI approval before application secret export. An unrelated deployment failure cannot pass that check. The `probe` pipeline parameter selects the job in place of the pipeline, and the job refuses to run on any project but the canary, as the deployment job refuses a `program_ref` other than `main` anywhere else: both parameters can be set by anyone who can trigger a pipeline through the API. A rule the job cannot replay, such as which job exports which environment, is held by the configuration file itself and checked by reading it.

### What a failure leaves behind

| Failure | What is left |
| --- | --- |
| `checks` fails | Nothing deployed. The pull request shows the failing step. |
| Vault login fails | Nothing deployed. Either the identity binding rejects the ref, or the identity is not a member of the project. The step prints a fixed authentication failure without exposing credential-command output. |
| Pulumi fails part way | The stack state records what was created. The next run converges, because the program is declarative. The lock is released when the process ends. |
| A resource was deleted outside Pulumi, by hand or with the Worker it was attached to | The refresh that precedes every update drops it from the state, and the program recreates what it still declares. |
| The platform package cannot be cloned | Nothing deployed: the clone is the job's first step. |
| The job ends between the Worker's upload and the Pulumi step, or the driver fails | A first deployment serves on its workers.dev URL only; a later one keeps its domain, which stays attached to the Worker's name. A production version serves nothing. The next run converges the resources. |
| Migration fails | Nothing uploaded, resources untouched, the previous Worker still serves. The project's migration tool owns the recovery. |
| Development smoke fails | The development Worker has already been replaced, production is untouched. |
| Production smoke fails | The new version is uploaded but never promoted. The previous version keeps serving. |
| GitHub reporting fails | Dependent jobs stop. The deployment check can retain its last reported state. Its linked native workflow report shows the reporting failure, even if production already serves. |
| Approval never given | The pipeline stays on hold. Development is deployed, production is not. A later merge starts a new pipeline. |
| Direct CircleCI approval or revoked Core membership | The production guard refuses before exporting application production secrets. |
| Approval service cannot release the CircleCI hold | The GitHub decision remains recorded. An active Core member can retry while the workflow is active. |

## Secrets and identities

Infisical holds every value. Nothing secret is written in this repository, in a project repository, in CircleCI or in a pipeline log.

- **One platform project** holds what every deployment needs, in a single Infisical environment named `main`. That is the Cloudflare API token and account, created and stored by the token script of this repository from a short-lived bootstrap token, and the passphrase that encrypts Pulumi's secret outputs. The state bucket needs no credential of its own: R2's S3 API accepts the API token as a key pair, so the token that creates the resources also keeps their state. One account serves every deployment environment, so a split by environment would hold the same values twice while every job could read both anyway.
- **One project per application**, named after the repository, with one Infisical environment per deployment environment, holds the application's own secrets. Locally, `infisical run --env development` replaces a dotenv file.
- **One machine identity**, Viewer of the platform project and of every application project. It logs in through OIDC Auth, bound to the CircleCI organization as audience and to a subject pattern that names the organization, the GitHub organization and the `main` ref. A pipeline on another ref gets nothing.

Why a single identity rather than one per environment or per repository. On Infisical's free plan, a role covers every environment of a project, and the mechanisms that would scope an identity to one environment are paid or retired. Identities are billed per unit, humans and machines together. Splitting projects per environment would buy a boundary that the account model already undoes. So the identity sees everything, and the configuration decides what each job exports. Re-check this when the plan or the vendor changes, in the Infisical pricing page and in the access-control documentation.

Why the subject is the only binding, and why it cannot name a job. Infisical matches bound claims by splitting the claim name on dots and matching string values, and CircleCI names every custom claim under a dotted prefix, such as the list of contexts a job used. Those claims are unreachable, so only the subject and the audience are enforceable, and nothing in the subject tells one job of a pipeline from another. The vault therefore accepts the token of any job on `main`, which is why the project's environment is built from a list and probed: the boundary inside the job is what keeps project code from presenting a token. The day Infisical can read the context claim, a context on the deployment job alone would let the vault itself refuse every other job, and the day CircleCI names the job in the subject, no context is needed.

Where values enter. A person types them in the Infisical dashboard, or pipes them to the CLI from a prompt that does not echo. They never pass through a chat, a command argument, a log or a file in a repository. Verification reads names, never values.

Durable credentials and their rotation:

| Credential | Lives in | Rotated when |
| --- | --- | --- |
| Cloudflare API token, allowed on every product of the account but not on what manages the account itself, such as tokens, members, settings and billing | Platform project | A maintainer leaves, a value was displayed, or on a fixed schedule. Cloudflare offers no OIDC federation, so this is the one long-lived secret of a deployment. |
| CircleCI API token used by the operator and the approval service | Platform vault and approval Worker secret bindings | Same triggers. The token can control the workflows its account can access. Anyone who can trigger a pipeline can set its parameters and configuration branch, which is why the job validates both. The service must never execute application code. |
| GitHub App private key and webhook secret | Platform vault and Worker secret bindings | Same triggers. Neither credential reaches application code. |
| Pulumi passphrase | Platform project | Same triggers. Rotating the passphrase re-encrypts the stacks. |

## The project's contract

`nextnode.toml`, which also carries the Worker's Wrangler keys, and a few package scripts are all a project supplies. [configuration.md](configuration.md) lists the keys, the Wrangler keys the read step refuses, and where each mistake is reported. The file never holds a secret value, and the presence of a development environment in it is what gives the project a development deployment.

## Registering a repository

Registration is a script in this repository, run once per repository by a maintainer. It is idempotent so it can be rerun after a partial failure. By role, it:

1. creates the CircleCI project, a pipeline definition whose configuration source is this repository's file on `main` and whose checkout source is the new repository, and a trigger on all pushes;
2. creates the Infisical project named after the repository with its environments, and adds the machine identity as Viewer;
3. verifies that the CircleCI Checks GitHub App has access to the repository, then runs a branch pipeline and confirms its native check completes successfully on a pull request;
4. disables **VCS Status Updates** in the CircleCI project's advanced settings, then verifies a fresh commit receives the native check without duplicate job statuses;
5. creates a repository-level required-check rule for the observed branch workflow check, bound to the CircleCI Checks app, with an up-to-date branch required and no bypass. The rule targets the default branch and leaves the organization's existing pull request and squash-merge rules intact;
6. leaves `nextnode.toml` to the project, which the standards tooling writes.

Until the script exists, the same steps are done by hand against the APIs. The identifiers of the shared resources it needs are listed at the end of this page.

## Decisions

| Decision | Reason | Rejected |
| --- | --- | --- |
| CircleCI with the configuration in this repository | The only CI of the shortlist whose GitHub App integration runs a configuration from another repository against the project's checkout, so projects hold no CI file. | GitHub Actions reusable workflows, which still need a caller file in each repository and whose required-workflow rulesets cover pull requests only. |
| Pulumi from the first deployment | DNS ships with the first Worker, databases follow, and the same program will drive AWS. | Wrangler alone, which is Cloudflare-only and imperative for resources. |
| Wrangler kept for the bundle and the assets | Pulumi can create a Worker, but uploading static assets through it means redoing Wrangler's upload protocol by hand. | Pulumi-only Worker deployment. |
| No CLI or npm package in projects | A project should not depend on a tool to be deployable. The configuration carries the tooling, at pinned versions. | A published pipeline CLI, as the previous platform had. |
| `nextnode.toml` carries the Worker's Wrangler keys | One deployment file to maintain. Wrangler, Vite and Astro read it natively, and `wrangler types` gives the Worker's types, so no generator ships to projects. The job still generates what Wrangler reads with the credential. | A committed Wrangler file beside `nextnode.toml`, which declared the Worker twice. A NextNode package that generated the Wrangler file and the types, as the previous platform's worker types did. |
| The Pulumi program is a package driven through the Automation API | Pulumi's own answer for tooling built over it: the program is a function, the driver is code, and both are checked with the package's own tooling. | The program written into the pipeline file, which validated with the configuration but put a growing program in a YAML string. |
| Project commands run in an environment built from a list | A list of names to remove is broken by the next name the vendor adds, which happened: a third token variable appeared and reached project code until a probe caught it. A list of names to keep cannot be broken that way. | Removing the token variables by name, or by prefix. |
| Merged platform code with an explicit canary exception | The [canary verification exception](#pull-request-checks) uses trusted platform code. Application commands still run as the restricted user. | Unreviewed branch programs running as the platform user. |
| The npm tools are dependencies of the platform package | One lockfile pins the tools and every transitive dependency, where a global install pinned only the top-level versions. | A global install of each tool at its version. |
| Fresh pinned tools rather than shared executable caches | A configuration-branch run cannot seed executable content for a later credential-bearing job. | A platform image built through a separately protected release process. |
| One pipeline on `main`, no `develop`, no tags | Trunk-based flow with one manual gate. Fewer refs, fewer rules to protect. | Production on tags, which would have let the vault distinguish the two environments by ref, at the cost of a second flow. |
| Dynamic configuration for the development step, once it works with a configuration source in another repository | The project decides whether it has a development environment, and CircleCI offers no other way to read a file before choosing jobs. Until then the development job halts itself. | Forcing a development environment on every project. |
| One vault identity | Scoping by environment is paid on the vendor side, and the account model already makes projects share a fate. | One identity per environment or per repository. |
| Migrations run by the project's command in the deployment job | The platform does not know the project's migration tool. | A platform-owned migration step. |
| The previous platform is documentation only | Its workflows and CLI are not consumed by anything. Its secrets model and its lessons inform this page. | Porting it. |

## Constraints verified against the vendors

These are the facts that forced the decisions above. Each names where to look when something behaves differently.

| Fact | Consequence | Re-check in |
| --- | --- | --- |
| The subject of the OIDC token the job presents, the one CircleCI names `CIRCLE_OIDC_TOKEN_V2`, ends with the repository and the git ref, and custom-webhook runs carry no ref. | The subject binding can pin `main`. API-triggered runs must be checked before relying on them. | CircleCI documentation, OpenID Connect tokens. |
| Every CircleCI job receives several OIDC tokens, with or without a context, under names CircleCI chooses and extends without notice: a third token, `CIRCLE_OIDC_TOKEN_V3` with a subject of its own, appeared in October 2026 while the configuration removed two by name. The tokens cannot be turned off, and a job can mint more through the agent. | No context is used. The identifiers a job needs are written in the configuration. The project's environment is built from a list of names to keep, the probe job matches a token by its shape rather than by a name, and it checks that the project cannot have the agent mint one. | CircleCI documentation, OpenID Connect tokens, the CircleCI changelog, and the probe job. |
| A pipeline whose configuration comes from another repository is not displayed in the CircleCI configuration editor, and `CIRCLE_REPOSITORY_URL` is empty. | Read the file from this repository. Take the repository from the checkout, not from that variable. | CircleCI documentation, GitHub App pipelines. |
| CircleCI reserves `<<` in configuration files. | A shell heredoc inside a `run` step must escape its marker as `\<<`. | CircleCI documentation, configuration reference. |
| On the `cimg` images, a global npm install needs `sudo`, and `CI=true` makes `pnpm install` frozen by default. | The install step says so. Error messages at that step point here. | The image documentation. |
| Corepack ships with Node up to 24 and is no longer bundled from Node 25. It runs the pnpm that a manifest's `packageManager` names and checks the hash the field carries. | The platform package installs through Corepack, with the pnpm version and its hash pinned in its manifest, so the project's pnpm never installs the platform's tools. An executor image past Node 24 needs Corepack installed first. | Node.js release notes, Corepack. |
| On the `cimg` images sudo is passwordless, the CircleCI agent that holds the job token runs as root, and a process may read the environment and overwrite the files of any process of its own user. | Project commands run as a second user created in the job, through `exec` into an environment built from a list; the token variables are unset at the head of `BASH_ENV` after the vault step; root access ends once the tools are installed and sudo keeps one rule, to become the project user. | The image documentation, and the probe job on the canary. |
| Infisical reads a bound claim by splitting its name on dots and matches string values only, so no claim under `oidc.circleci.com/` is reachable, array or not. | Only `sub` and `aud` can be bound for CircleCI, and neither names a job. | Infisical source, OIDC auth service and the dot-access helper. |
| On the Infisical free plan, custom roles are refused with a plan error, additional privileges are refused for recent projects as a retired feature, folder access controls are paid, and identities are billed per unit. | A free identity sees every environment of each project it belongs to. | Infisical pricing page and access-control documentation. |
| Infisical ignores a request that only turns delete protection off. | To delete a protected identity, send the name together with the flag, then delete. | Infisical source, identity service. |
| Cloudflare offers no OIDC federation for its API. | An API token stays in the vault and is rotated. | Cloudflare API documentation. |
| A shared temporary directory accepts a file from any user, and a path that exists is reused by the commands that create files and links. | After the project user exists, the platform writes under its own home only, in a directory that user cannot write, and recreates a program directory empty before loading anything from it. | POSIX semantics of the shared temporary directory, `mkdir -p` and `ln -s`. |
| Wrangler reads `.env`, `.env.local` and the environment's dotenv files from its working directory into its own environment, for every command. | Wrangler runs from the platform's directory, never from the checkout, with an empty dotenv file named to it. | Wrangler source, the dotenv loading of its command line. |
| CircleCI caches are shared by every branch of a project, and a key is written once. | Credential-bearing jobs restore no executable content from shared caches. | CircleCI documentation, caching. |
| Wrangler reads whatever path its configuration names, absolute or above the configuration's directory, including the module root it walks for additional modules, and follows a symbolic link of the checkout wherever it points, as it is when read. | The read step refuses a path of the Wrangler keys that leaves the repository, and the upload reads only the platform's copy of the bundle and the assets, made once every process of the project has ended and refusing any link. The probe job plants each. | Wrangler documentation on configuration, the bundling page, and a dry run with a module root above the configuration's directory. |
| Wrangler's bundler follows every import of the entry point, with the permissions of the user running it, and a module rule turns any file into a text module. | The bundle is written by a dry run as the project user and its copy uploaded as it is, with bundling off: the Wrangler that holds the credential reads the platform's copy, never an import. The probe job bundles an import of the platform's secrets both ways. | Wrangler documentation on bundling, and a dry run of an entry point that imports a file outside the checkout. |
| A hard link to a file needs no permission on it unless the kernel's `fs.protected_hardlinks` is set, and a hard link is a plain file to every check but its link count. | The step that creates the project user refuses to go on without the setting, the copy for the upload refuses a file with several links, and the probe job tries both. | Linux kernel documentation on `fs.protected_hardlinks`. |
| Wrangler calls git in the working directory for version metadata, and git runs commands the repository configures, such as hooks or a file system monitor. | After the project user is created, the platform user's git points at no repository, so Wrangler finds none and runs nothing from the checkout. | Wrangler source, the deployment metadata helpers, and git configuration documentation. |
| Wrangler reads the file that a bundle's source map comment names when it uploads source maps, and quotes it in its error when it is not JSON. | The platform uploads with source maps off, the key is not accepted from `nextnode.toml`, and the probe job turns them on as its positive control. | Wrangler documentation, source maps; a dry run with a comment that names a file outside the bundle. |
| Wrangler refuses to upload a version of a Worker that was never deployed, and a version carries no change of routes or domains. | The first production deployment of a Worker goes through a direct deployment, with nothing serving yet. Routes and domains are Pulumi's, never a version's. | Wrangler documentation on versions and gradual deployments. |
| A hostname holds one Workers custom domain, and the Cloudflare provider replaces a custom domain whose Worker changes. | The domain resource is deleted before its replacement is created, since the replacement would otherwise be refused while the old one holds the hostname. | Cloudflare API documentation, Workers custom domains, and the provider's resource schema. |
| A Workers custom domain attaches to a Worker that exists. | Pulumi runs after Wrangler's upload, so a first deployment is reachable on its domain for the smoke request even without a workers.dev URL. | Cloudflare API documentation, Workers custom domains. |
| R2's S3 API accepts an API token as credentials: the token's id as access key, its SHA-256 as secret key, with path-style addressing and the automatic region. | Pulumi's state lives in R2 behind its S3 backend with no second credential. The lock is a file, so one deployment at a time per stack. | Cloudflare documentation, R2 S3 API tokens. |
| A Workers service name is the `name` of the Wrangler configuration that uploads it. | The read step writes `<repository>-<environment>` as that name and gives the same name to Pulumi for the domain. | Wrangler documentation, configuration. |
| Wrangler reads any configuration file named with `--config`, in TOML by its extension, and only warns about top-level keys it does not know. | `nextnode.toml` is the Wrangler configuration on a laptop, and Wrangler generates the Worker's types from it. | Wrangler documentation, configuration; the warning on a local run. |
| Wrangler resolves the paths of a configuration file against the file's directory and writes its working files beside it. | The generated configuration lives outside the checkout, so the read step anchors its paths to the checkout root, where `nextnode.toml` is. The project user bundles from a copy in its home, and the copy for the upload has a configuration of its own that names only the copied files. | Wrangler documentation, configuration and bundling. |
| Wrangler 4 creates a database, a key-value namespace or a bucket on deployment when a binding names none, and each Wrangler version may add keys that bind or create account resources. | The schema of `nextnode.toml` accepts a fixed set of Wrangler keys. A binding kind enters it once the platform package creates that kind and hands the identifiers to the generated configuration. | Wrangler documentation, automatic resource provisioning; the configuration schema of each new Wrangler version. |
| GitHub App pipelines expose checkout metadata in pipeline values, not the pipeline response's `vcs` field. | The approval service reads the checkout repository, branch and revision from the pipeline values API, independently of the configuration source. | [CircleCI pipeline values](https://circleci.com/docs/reference/variables/), and the API's get pipeline values operation. |
| New GitHub REST versions can remove `merge_commit_sha` from pull request responses. | Release reporting pins a supported contract that exposes the merge commit used to bind approval and deployment. | [GitHub REST breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes) and [supported API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions). |
| CircleCI workflow approval uses its API, and a hold alone does not enforce GitHub team membership. | The approval service verifies GitHub membership before releasing the hold. Production independently verifies the recorded GitHub decision before application secrets are exported. | CircleCI API documentation, approve a job, and GitHub Checks requested actions. |
| The Infisical CLI prints a missing secret as `*not found*`. | The scoped credential exporter refuses that placeholder before rendering an environment or runtime bindings. | [Infisical CLI reference](https://infisical.com/docs/cli/reference.md), secret retrieval. |
| Cloudflare secret bindings belong to uploaded Worker versions. In the service's first publication, a Pulumi refresh after Wrangler's upload no longer found the Worker the provider's `Worker` resource had created, and recreating it was refused as a duplicate name. | Wrangler creates the shared service's Worker and uploads its code and secret bindings. Pulumi owns its domain only, as for every application Worker. The service's vault export is never supplied to application code. | Cloudflare Workers API, Worker versions and secret bindings; the Pulumi Cloudflare provider's `Worker` resource at the version the platform package pins. |
| GitHub's REST API answers an occasional request with HTTP 500, seen on filtered check-run listings at about one call in six while its status page reported no incident. A release makes a dozen such reads across its reporting jobs, so one bad answer failed the whole release. | Reads of the GitHub client retry an HTTP 5xx a bounded number of times, with a delay short enough for the approval Worker to answer GitHub's webhook in time; a network failure or a timeout is not retried, so a hung GitHub costs one timeout. Writes never retry: a check-run creation is not idempotent, and a duplicate is refused by the next job. | The canary's reporting job logs, and GitHub's status page. |
| The Workers runtime implements the `follow` and `manual` redirect modes of `fetch` and throws on `error`, which Node accepts. The approval service's first live approval failed on every outbound call for that reason, after a preflight that ran in Node. | Code shared between the deployment programs and the Worker, the GitHub and CircleCI clients, requests with `manual` and treats a redirect as a failed response, so a credential never follows a redirect in either runtime. | [Workers `fetch` request options](https://developers.cloudflare.com/workers/runtime-apis/request/#options), and a local `wrangler dev` of a request with each mode. |
| Wrangler does not carry `vars` and bindings from the top level into an environment section. | The generated configuration holds the one environment, flat, and Wrangler runs on it without an environment flag, so a top-level key reaches every environment. | Wrangler documentation, environments. |

## Open points

Each is validated on the canary repository before it reaches a real project.

- Dynamic configuration when the configuration source is another repository, through the continuation API. It is what lets a project without a development environment reach production straight after the checks. The fallback, a static workflow where the development job halts at once when the project has no development environment, still routes such a project through the approval.
- The scopes of the Cloudflare API token.
- Resources the Worker binds to, such as a database, must exist before the upload. They get a Pulumi run before the build that must not touch what the serving Worker holds, which means a stack or a target set of their own.

## Identifiers of the shared resources

These live nowhere else yet. The registration script becomes their home when it exists.

| Resource | Identifier |
| --- | --- |
| CircleCI organization `Nextnode` | `d5f82c19-9496-4d58-bc57-6ab0c112163f`, slug `circleci/TRU8GsHNL2QX13BVQE2UK8`. OIDC issuer `https://oidc.circleci.com/org/d5f82c19-9496-4d58-bc57-6ab0c112163f` |
| This repository's GitHub id, used as configuration source | `1431173996` |
| Infisical organization | `5082d2f8-c593-4058-8643-11f685d6d7d2` |
| Infisical platform project `nextnode-platform` | `721a5f71-3801-40e2-a06d-a4a9b431e1c7` |
| Infisical machine identity of the pipeline | `17af2913-5649-4771-b149-aa9bf50ff39d` |
| Canary: GitHub repository `NextNodeSolutions/canary` | GitHub id `1433288639`, CircleCI project `01fc0b41-1871-4e49-85f1-6780a36e5b23`, pipeline definition `3b27438e-17b8-41f4-8e7e-372b32323712`, trigger `0ab5440e-27ab-49de-aa0f-bce23f906830` |
