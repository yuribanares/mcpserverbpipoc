#!/usr/bin/env bash
# 05-create-agentcore-runtime.sh — register the BPI MCP Server with Amazon
# Bedrock AgentCore Runtime (or update it if it already exists).
#
# It tells AgentCore:
#   • where the code is (the zip from step 2, or the container image)
#   • to speak MCP (port 8000, path /mcp)
#   • which IAM role to run as (step 3)
#   • to let in only tokens from our Cognito partner app clients (step 4)
#   • the server's settings from config/$PROFILE.env (bank address, etc.)
#   • how long idle conversations stay alive
# Takes a few minutes. Safe to re-run — e.g. after uploading new code with
# step 2, or after changing a setting. The full request is saved in
# .state/payloads/agentcore-runtime.json so you can see exactly what was sent.
source "$(dirname "$0")/lib/common.sh"
title "Step 5 — Create the AgentCore Runtime \"$RUNTIME_NAME\" (profile: $PROFILE)"
require_output ROLE_ARN "Run ./scripts/03-create-permissions.sh first."
require_output COGNITO_DISCOVERY_URL "Run ./scripts/04-create-partner-logins.sh first."
require_output COGNITO_CLIENT_IDS "Run ./scripts/04-create-partner-logins.sh first."
if [[ "$DEPLOY_METHOD" == "code" ]]; then require_output CODE_KEY "Run ./scripts/02-upload-mcp-server.sh first."
else require_output IMAGE_URI "Run ./scripts/02-upload-mcp-server.sh first."; fi

step "1/3 Work out the bank address"
if [[ "${BPI_API_URL:-auto}" == "auto" ]]; then
  require_output MOCK_BANK_URL "Run ./scripts/01-deploy-mock-bank.sh first (BPI_API_URL=auto means \"use the Lightsail mock bank\")."
  export RESOLVED_BPI_API_URL="$MOCK_BANK_URL"
  ok "Using the Lightsail mock bank: $MOCK_BANK_URL"
else
  export RESOLVED_BPI_API_URL="$BPI_API_URL"
  ok "Using the bank address from config/$PROFILE.env: $BPI_API_URL"
fi

step "2/3 Send the runtime definition to AgentCore"
existing_id="$(aws bedrock-agentcore-control list-agent-runtimes --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text)"
if [[ -n "$existing_id" && "$existing_id" != "None" ]]; then
  export RUNTIME_ID="$existing_id"
  payload="$(render_payload agentcore-runtime)"
  aws bedrock-agentcore-control update-agent-runtime --cli-input-json "file://$payload" >/dev/null
  ok "Update sent for existing runtime $RUNTIME_ID"
else
  unset RUNTIME_ID
  payload="$(render_payload agentcore-runtime)"
  RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime --cli-input-json "file://$payload" --query agentRuntimeId --output text)"
  ok "Runtime created: $RUNTIME_ID"
fi
info "Request saved in .state/payloads/agentcore-runtime.json"

step "3/3 Wait until it is READY"
runtime_status() { aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query status --output text; }
settled() { [[ "$(runtime_status)" =~ ^(READY|CREATE_FAILED|UPDATE_FAILED)$ ]]; }
wait_for "the runtime to be ready (usually 1–5 minutes)" 900 settled || die "Still not ready after 15 minutes." "Check the runtime in the AgentCore console."
status="$(runtime_status)"
if [[ "$status" != "READY" ]]; then
  reason="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query failureReason --output text)"
  die "Runtime status: $status — $reason" "See 'AgentCore runtime failed' in docs/6-troubleshooting.md"
fi
arn="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
save_output RUNTIME_ID "$RUNTIME_ID"
save_output RUNTIME_ARN "$arn"
ok "Runtime is READY"
info "ARN: $arn"
console_hint "https://${AWS_REGION}.console.aws.amazon.com/bedrock-agentcore/ → Runtime → $RUNTIME_NAME"
info "Server logs: CloudWatch → Log groups → /aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT"

echo; ok "${B}Done. Next: ./scripts/06-test-on-aws.sh${N}"
