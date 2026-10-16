#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables defined here are used by the scripts that source this file
# common.sh — shared helpers for the numbered scripts. Not meant to be run directly.
#
# Every script starts with:   source "$(dirname "$0")/lib/common.sh"
# which:
#   • stops on the first error (set -euo pipefail)
#   • loads config/deploy-settings.env, then the profile (demo/production),
#     then .state/outputs.env (IDs saved by earlier scripts)
#   • gives friendly helpers: step / ok / info / warn / die / console_hint
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"
STATE_DIR="$DEPLOY_DIR/.state"
OUTPUTS="$STATE_DIR/outputs.env"
PAYLOADS="$STATE_DIR/payloads"
mkdir -p "$STATE_DIR" "$PAYLOADS"
chmod 700 "$STATE_DIR"
export AWS_PAGER=""   # never open a pager for AWS CLI output

# ── Pretty output ───────────────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=; G=; Y=; R=; C=; N=; fi
title()        { echo; echo "${B}════ $* ════${N}"; }
step()         { echo; echo "${B}▶ $*${N}"; }
info()         { echo "  $*"; }
ok()           { echo "  ${G}✅ $*${N}"; }
warn()         { echo "  ${Y}⚠️  $*${N}"; }
die()          { echo "  ${R}❌ $1${N}" >&2; [[ $# -gt 1 ]] && echo "     → $2" >&2; exit 1; }
console_hint() { echo "  ${C}🔎 Check it in the AWS console:${N} $*"; }

# ── Settings files ──────────────────────────────────────────────────────────
# Reads KEY=VALUE lines. Ignores blank lines and # comments (also trailing
# "  # comment"). Values are taken literally — no $ expansion — so JSON and
# special characters are safe. Surrounding quotes are removed.
load_env_file() {
  local file=$1 line key val
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; key="${key//[[:space:]]/}"
    val="${line#*=}"
    val="$(sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$val")"
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done < "$file"
}

load_settings() {
  load_env_file "$CONFIG_DIR/deploy-settings.env"
  PROFILE="${PROFILE:-demo}"
  local profile_file="$CONFIG_DIR/$PROFILE.env"
  if [[ ! -f "$profile_file" ]]; then
    if [[ "$PROFILE" == "production" ]]; then
      die "config/production.env not found." "Copy the template first: cp config/production.example.env config/production.env (then fill it in)."
    fi
    die "Profile file config/$PROFILE.env not found." "Set PROFILE=demo or PROFILE=production in config/deploy-settings.env."
  fi
  load_env_file "$profile_file"
  load_env_file "$OUTPUTS"
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" PROFILE
}

# Save a value for later scripts (written to .state/outputs.env).
save_output() {
  local key=$1 val=$2 tmp
  tmp="$(mktemp)"
  { [[ -f "$OUTPUTS" ]] && grep -v "^${key}=" "$OUTPUTS" || true; echo "${key}=${val}"; } > "$tmp"
  mv "$tmp" "$OUTPUTS"; chmod 600 "$OUTPUTS"
  export "$key=$val"
}

# Stop with a clear message if an earlier step hasn't been run.
require_output() {
  local key=$1 hint=$2
  [[ -n "${!key:-}" ]] || die "Missing $key — an earlier step hasn't been run yet." "$hint"
}

# Write a JSON payload file for an AWS call and print its path.
render_payload() {
  local name=$1 file="$PAYLOADS/$1.json"
  node "$SCRIPTS_DIR/lib/payloads.mjs" "$name" > "$file"
  echo "$file"
}

# Repeat a check until it succeeds or time runs out.
#   wait_for "<what we wait for>" <timeout-seconds> <command...>
wait_for() {
  local what=$1 timeout=$2; shift 2
  local start=$SECONDS
  printf "  ⏳ Waiting for %s " "$what"
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS - start > timeout )); then echo; return 1; fi
    printf "."; sleep "${WAIT_INTERVAL:-10}"
  done
  echo " done"
}

aws_account_id() { aws sts get-caller-identity --query Account --output text; }

load_settings
