#!/usr/bin/env bash
# 99-delete-everything.sh — remove everything the scripts created, so nothing
# keeps costing money. Asks for confirmation first.
#
# Deletes: the AgentCore Runtime, the Cognito user pool (partner logins), the
# IAM role, the code bucket / ECR repository, the Lightsail mock bank, and —
# only if the production helper scripts created them — the partner-registry
# secret and the session table. Your code and .env stay untouched.
# Safe to re-run: things already gone are skipped.
source "$(dirname "$0")/lib/common.sh"
title "Delete everything created in AWS ($AWS_REGION)"
warn "This permanently deletes the BPI MCP deployment in account ${ACCOUNT_ID:-?}."
read -r -p "  Type DELETE to continue: " answer
[[ "$answer" == "DELETE" ]] || die "Cancelled — nothing was deleted."
gone() { ok "$1"; }
skip() { info "– $1 (not found, skipped)"; }

step "AgentCore Runtime"
rid="${RUNTIME_ID:-$(aws bedrock-agentcore-control list-agent-runtimes --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text 2>/dev/null || true)}"
if [[ -n "$rid" && "$rid" != "None" ]] && aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$rid" >/dev/null 2>&1; then
  gone "Runtime $rid deleted"
else skip "Runtime"; fi

step "Cognito partner logins"
pool="${USER_POOL_ID:-}"
if [[ -n "$pool" ]] && aws cognito-idp describe-user-pool --user-pool-id "$pool" >/dev/null 2>&1; then
  dom="$(aws cognito-idp describe-user-pool --user-pool-id "$pool" --query UserPool.Domain --output text)"
  [[ -n "$dom" && "$dom" != "None" ]] && aws cognito-idp delete-user-pool-domain --user-pool-id "$pool" --domain "$dom" >/dev/null
  aws cognito-idp delete-user-pool --user-pool-id "$pool"
  gone "User pool $pool deleted"
else skip "User pool"; fi

step "IAM role"
if aws iam get-role --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1; then
  aws iam delete-role-policy --role-name "$IAM_ROLE_NAME" --policy-name BpiMcpRuntimePermissions >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$IAM_ROLE_NAME"
  gone "Role $IAM_ROLE_NAME deleted"
else skip "Role"; fi

step "Uploaded code"
if [[ -n "${CODE_BUCKET:-}" ]] && aws s3api head-bucket --bucket "$CODE_BUCKET" >/dev/null 2>&1; then
  aws s3 rb "s3://$CODE_BUCKET" --force >/dev/null
  gone "Bucket $CODE_BUCKET deleted"
else skip "Code bucket"; fi
if aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then
  aws ecr delete-repository --repository-name "$ECR_REPO" --force >/dev/null
  gone "ECR repository $ECR_REPO deleted"
else skip "ECR repository"; fi

step "Lightsail mock bank"
if aws lightsail get-container-services --service-name "$LIGHTSAIL_SERVICE" >/dev/null 2>&1; then
  aws lightsail delete-container-service --service-name "$LIGHTSAIL_SERVICE" >/dev/null
  gone "Lightsail service $LIGHTSAIL_SERVICE deleted"
else skip "Lightsail service"; fi

step "Production extras (only if the p1/p2 scripts created them)"
if [[ -n "${CREATED_SECRET_ID:-}" ]] && aws secretsmanager describe-secret --secret-id "$CREATED_SECRET_ID" >/dev/null 2>&1; then
  aws secretsmanager delete-secret --secret-id "$CREATED_SECRET_ID" --recovery-window-in-days 7 >/dev/null
  gone "Secret $CREATED_SECRET_ID scheduled for deletion (recoverable for 7 days)"
else skip "Partner-registry secret"; fi
if [[ -n "${CREATED_TABLE_NAME:-}" ]] && aws dynamodb describe-table --table-name "$CREATED_TABLE_NAME" >/dev/null 2>&1; then
  aws dynamodb delete-table --table-name "$CREATED_TABLE_NAME" >/dev/null
  gone "Table $CREATED_TABLE_NAME deleted"
else skip "Session table"; fi

mv "$OUTPUTS" "$OUTPUTS.deleted-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
echo; ok "${B}All done.${N} Set MCP_MODE=local in .env to keep using the local PoC."
