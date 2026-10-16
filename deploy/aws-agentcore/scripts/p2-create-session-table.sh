#!/usr/bin/env bash
# p2-create-session-table.sh — PRODUCTION: create the DynamoDB table that keeps
# partner and customer login sessions (instead of server memory).
#
# Pay-per-request (no capacity to manage), encrypted at rest, and with "time to
# live" on the expiresAt field so old sessions are deleted automatically.
# Uses SESSION_TABLE_NAME from config/production.env. Safe to re-run.
source "$(dirname "$0")/lib/common.sh"
title "Production — create the session table in Amazon DynamoDB"
table="${SESSION_TABLE_NAME:-}"
[[ -n "$table" ]] || die "SESSION_TABLE_NAME is not set." "Set it in config/production.env and PROFILE=production in deploy-settings.env."

step "Table \"$table\""
if aws dynamodb describe-table --table-name "$table" >/dev/null 2>&1; then
  ok "Already exists"
else
  aws dynamodb create-table --table-name "$table" \
    --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$table"
  ok "Created"
fi

step "Turn on automatic expiry (TTL on \"expiresAt\")"
ttl="$(aws dynamodb describe-time-to-live --table-name "$table" --query TimeToLiveDescription.TimeToLiveStatus --output text)"
if [[ "$ttl" == "ENABLED" || "$ttl" == "ENABLING" ]]; then ok "Already on"
else aws dynamodb update-time-to-live --table-name "$table" --time-to-live-specification "Enabled=true,AttributeName=expiresAt" >/dev/null; ok "Turned on"; fi
save_output CREATED_TABLE_NAME "$table"
console_hint "https://${AWS_REGION}.console.aws.amazon.com/dynamodbv2/home#table?name=$table"
info "Next: re-run ./scripts/03-create-permissions.sh and ./scripts/05-create-agentcore-runtime.sh"
