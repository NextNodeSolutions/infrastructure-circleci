#!/bin/bash
# Run the canary's pipeline with the configuration and the platform package of a branch
# of this repository, on a branch of the canary, wait for it, print each job's status,
# every failed step's output and the output of the steps named by SHOW, and save every
# step's output, one log per job, with token-shaped values redacted.
#
# usage: infisical run ... -- run-canary.sh <branch> [canary-branch]
#   APPROVE=1   attempts direct CircleCI approval; the GitHub production guard must reject it
#   WAIT_PRODUCTION=1 waits for approval from GitHub and requires the production workflow to succeed
#   PROBE=1     runs the probe job in place of the pipeline
#   GITHUB_SERVICE=1 publishes the approval service through CI, post-merge from main only
#   RERUN=1     replays the recorded probe workflow once it completes, observing a rerun
#   SSH_RERUN=1 replays it again with SSH access for the same observation
# A rerun is evidence only when it succeeds; RERUN_POLL sets the poll interval.
#   SHOW=regex  the steps whose output is printed, beside the failed ones
#   LOGS=dir    where the logs go, a new temporary directory by default
#
# The CircleCI token is injected from the platform vault.
# The file-descriptor header keeps the token out of process arguments.
set -euo pipefail

BRANCH=${1:?usage: run-canary.sh <branch> [canary-branch]}
CHECKOUT=${2:-main}
if [ -n "${APPROVE:-}" ] && [ -n "${WAIT_PRODUCTION:-}" ]; then
  echo "APPROVE and WAIT_PRODUCTION select different checks and cannot be combined"
  exit 1
fi
if [ -n "${APPROVE:-}" ] && [ -n "${RERUN:-}${SSH_RERUN:-}" ]; then
  echo "APPROVE ends failed; the rerun legs replay a completed probe workflow"
  exit 1
fi
if [ -n "${RERUN:-}${SSH_RERUN:-}" ] && [ -z "${PROBE:-}" ]; then
  echo "RERUN and SSH_RERUN replay the probe workflow; set PROBE=1"
  exit 1
fi
SHOW=${SHOW:-'Read nextnode|Fetch the secrets|Deploy|Resources|Smoke|Promote|Probe|Stand in'}
LOGS=${LOGS:-$(mktemp -d)}
: "${CIRCLECI_TOKEN:?inject it with infisical run, never type or export it}"
CC=https://circleci.com/api/v2
PROJECT=circleci/TRU8GsHNL2QX13BVQE2UK8/FDPCoATpJwHnVvPDFPNiN
DEFINITION=3b27438e-17b8-41f4-8e7e-372b32323712
mkdir -p "$LOGS"

api() { curl -sS -H @/dev/fd/3 -H 'content-type: application/json' "$@" 3<<<"Circle-Token: $CIRCLECI_TOKEN"; }
redact() { sed -E 's/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_.-]+/<redacted-jwt>/g; s/[A-Za-z0-9_-]{40,}/<redacted>/g'; }

report_step() {
  local name=$1 step=$2 state=$3 output=$4
  printf '===== %s (%s)\n%s\n' "$step" "$state" "$output" >>"$LOGS/$name.log"
  if [ "$name" = deploy-prod ] && [ "$step" = 'Fetch the secrets of production' ] && [ "$state" = failed ] &&
    grep -Fq 'Production requires a successful GitHub approval' <<<"$output" && ! grep -Eq '^application \(' <<<"$output"; then
    guard_refused=1
  fi
  if [ "$state" != success ] || [[ $step =~ $SHOW ]]; then
    echo "  $([ "$state" = success ] && echo 'ok  ' || echo FAIL) $step"
    [ -z "$output" ] || tail -n 15 <<<"$output" | sed 's/^/      | /'
  fi
}

report_workflow() {
  jobs=$(api "$CC/workflow/$id/job")
  jq -r '[.items[] | "\(.name)=\(.status)\(if .job_number then "#\(.job_number)" else "" end)"] | join("  ")' <<<"$jobs"
  while IFS=$'\t' read -r number name; do
    job=$(api "https://circleci.com/api/v1.1/project/$PROJECT/$number")
    echo "== job $name (#$number) $(jq -r .status <<<"$job") -> $LOGS/$name.log"
    while IFS=$'\t' read -r step state url; do
      output=$([ -z "$url" ] || curl -sS "$url" | jq -r '.[].message' | redact)
      report_step "$name" "$step" "$state" "$output"
    done < <(jq -r '.steps[] | .name as $step | .actions[] | [$step, .status, .output_url // ""] | @tsv' <<<"$job")
  done < <(jq -r '.items[] | select(.type == "build" and .job_number) | "\(.job_number)\t\(.name)"' <<<"$jobs")
}

# A full rerun re-executes every job of the probe workflow with fresh OIDC tokens; each
# job's claims step then names the rerun's own subject and the run's configuration revision.
# External-policy denials stay failures until their structured vendor contract is observed.
rerun_observation() {
  local rerun rid status=""
  rerun=$(api -X POST "$CC/workflow/$id/rerun" -d "{\"enable_ssh\": $1}")
  rid=$(jq -r '.id // .workflow_id // empty' <<<"$rerun")
  [ -n "$rid" ] || { head -c 300 <<<"$rerun" | redact; echo; exit 1; }
  echo "rerun workflow $rid (enable_ssh=$1)"
  while [ "$SECONDS" -lt 3600 ]; do
    status=$(api "$CC/workflow/$rid" | jq -r '.status // empty')
    case "$status" in success|failed|error|canceled|unauthorized) break;; esac
    sleep "${RERUN_POLL:-10}"
  done
  echo "rerun workflow: ${status:-unknown}"
  if [ "$status" != success ]; then
    echo "FAIL: rerun ended ${status:-unknown} without succeeding" >&2
    exit 1
  fi
  id=$rid
  api "$CC/pipeline/$pipeline" | jq -c '.' | redact > "$LOGS/pipeline-$rid.json"
  report_workflow
}

CONFIG_REVISION=$(git rev-parse "refs/remotes/origin/$BRANCH" 2>/dev/null || echo unknown)
body=$(jq -nc --arg d "$DEFINITION" --arg b "$BRANCH" --arg c "$CHECKOUT" --arg r "$CONFIG_REVISION" \
  --argjson p "$([ -n "${PROBE:-}" ] && echo true || echo false)" \
  --argjson s "$([ -n "${GITHUB_SERVICE:-}" ] && echo true || echo false)" \
  '{definition_id: $d, config: {branch: $b}, checkout: {branch: $c}, parameters: {program_ref: $b, probe: $p, github_service: $s, config_revision: $r}}')
run=$(api -X POST "$CC/project/$PROJECT/pipeline/run" -d "$body")
pipeline=$(jq -r '.id // empty' <<<"$run")
[ -n "$pipeline" ] || { head -c 300 <<<"$run" | redact; echo; exit 1; }
echo "pipeline $(jq -r .number <<<"$run") ($pipeline) branch=$BRANCH canary=$CHECKOUT probe=${PROBE:-} logs=$LOGS"
# CircleCI's own record of this pipeline, for the executed-configuration evidence; the
# caller-supplied revision printed in the claims step is a cross-check, not proof. The
# values document holds the parameters the pipeline selected, including config_revision.
api "$CC/pipeline/$pipeline" | jq -c '.' | redact > "$LOGS/pipeline.json"
api "$CC/pipeline/$pipeline/values" | jq -c '.' | redact > "$LOGS/pipeline-values.json"

status="" id="" approved="" guard_refused=""
while [ "$SECONDS" -lt 3600 ]; do
  workflow=$(api "$CC/pipeline/$pipeline/workflow" | jq -c '.items[0] // {}')
  status=$(jq -r '.status // empty' <<<"$workflow")
  id=$(jq -r '.id // empty' <<<"$workflow")
  if [ "$status" = on_hold ] && [ -n "${APPROVE:-}" ] && [ -z "$approved" ]; then
    request=$(api "$CC/workflow/$id/job" | jq -r '[.items[] | select(.type == "approval" and .status == "on_hold")][0].approval_request_id // empty')
    [ -n "$request" ] || { echo 'No pending production approval request'; exit 1; }
    api --fail-with-body -o /dev/null -X POST "$CC/workflow/$id/approve/$request" || { echo 'Direct approval request failed'; exit 1; }
    approved=1
    echo 'Attempted direct CircleCI approval'
    continue
  fi
  # An approved hold reads as on_hold for a few more polls.
  case "$status" in success|failed|error|canceled|unauthorized) break;; on_hold) [ -n "${APPROVE:-}${WAIT_PRODUCTION:-}" ] || break;; esac
  if [ -z "$status" ]; then
    errors=$(api "$CC/pipeline/$pipeline" | jq -r '[.errors[]? | "\(.type) \(.message)"] | join(" | ")')
    [ -z "$errors" ] || { echo "pipeline error: $errors" | redact; exit 1; }
  fi
  sleep 10
done
echo "workflow: ${status:-unknown}"

report_workflow
if [ -n "${APPROVE:-}" ]; then
  [ "$approved" = 1 ] && [ "$status" = failed ] && [ "$guard_refused" = 1 ] || { echo 'FAIL: direct approval was not refused by the GitHub production guard before application secret export'; exit 1; }
  echo 'PASS: direct CircleCI approval was refused before application production secrets'
  exit 0
fi
[ "$status" = success ] || { [ "$status" = on_hold ] && [ -z "${WAIT_PRODUCTION:-}" ]; } || exit 1
if [ -n "${RERUN:-}" ]; then rerun_observation false; fi
if [ -n "${SSH_RERUN:-}" ]; then rerun_observation true; fi
