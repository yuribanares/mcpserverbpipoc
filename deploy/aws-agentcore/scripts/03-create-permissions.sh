#!/usr/bin/env bash
# 03-create-permissions.sh — create the IAM role the MCP server runs as.
#
# An IAM "role" is a set of permissions that AWS services can borrow. This
# role lets the AgentCore Runtime (and only AgentCore, only in your account):
#   • write logs to CloudWatch, report traces and metrics
#   • read the uploaded code zip (or pull the container image)
#   • production only: read the partner-registry secret and the session table
# Safe to re-run: it updates the role to match your current settings. Re-run
# it after switching PROFILE, so new production permissions are added.
source "$(dirname "$0")/lib/common.sh"
title "Step 3 — Create the IAM role \"$IAM_ROLE_NAME\""
require_output ACCOUNT_ID "Run ./scripts/00-check-tools.sh first."
if [[ "$DEPLOY_METHOD" == "code" ]]; then require_output CODE_BUCKET "Run ./scripts/02-upload-mcp-server.sh first."; fi

step "1/2 Create the role (who may use it)"
trust="$(render_payload iam-trust-policy)"
if aws iam get-role --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$IAM_ROLE_NAME" --policy-document "file://$trust"
  ok "Role already exists — trust policy refreshed"
else
  aws iam create-role --role-name "$IAM_ROLE_NAME" --assume-role-policy-document "file://$trust" \
    --description "Runs the BPI MCP Server on Amazon Bedrock AgentCore Runtime" >/dev/null
  ok "Role created"
fi

step "2/2 Attach the permissions (what it may do)"
perms="$(render_payload iam-permissions-policy)"
aws iam put-role-policy --role-name "$IAM_ROLE_NAME" --policy-name BpiMcpRuntimePermissions --policy-document "file://$perms"
role_arn="$(aws iam get-role --role-name "$IAM_ROLE_NAME" --query Role.Arn --output text)"
save_output ROLE_ARN "$role_arn"
ok "Permissions attached (see .state/payloads/iam-permissions-policy.json)"
info "Waiting 10 seconds for IAM changes to reach every AWS region…"; sleep 10
ok "Role ready: $role_arn"
console_hint "https://console.aws.amazon.com/iam/home#/roles/details/$IAM_ROLE_NAME"

echo; ok "${B}Done. Next: ./scripts/04-create-partner-logins.sh${N}"
