#!/usr/bin/env bash
# 06-test-on-aws.sh — run the whole Fund Top-Up journey against AWS, without
# the browser: partner login → MCP tools → customer login at the bank →
# accounts → ₱1 top-up → status. Prints ✅ / ❌ for each step.
source "$(dirname "$0")/lib/common.sh"
title "Step 6 — Test the deployment end to end"
require_output RUNTIME_ARN "Run ./scripts/05-create-agentcore-runtime.sh first."
require_output COGNITO_TOKEN_URL "Run ./scripts/04-create-partner-logins.sh first."

first="${PARTNERS%% *}"
cid_var="CLIENT_ID_${first}"; sec_var="CLIENT_SECRET_${first}"
bank="${MOCK_BANK_URL:-}"
[[ "${BPI_API_URL:-auto}" != "auto" ]] && bank="$BPI_API_URL"
[[ -n "$bank" ]] || die "No bank address." "Run ./scripts/01-deploy-mock-bank.sh (demo) or set BPI_API_URL (production)."
[[ -d "$REPO_ROOT/node_modules" ]] || (cd "$REPO_ROOT" && npm install --no-audit --no-fund --loglevel=error)

AWS_REGION="$AWS_REGION" \
AWS_AGENTCORE_RUNTIME_ARN="$RUNTIME_ARN" \
AWS_BANK_URL="$bank" \
AWS_COGNITO_TOKEN_URL="$COGNITO_TOKEN_URL" \
AWS_COGNITO_CLIENT_ID="${!cid_var}" \
AWS_COGNITO_CLIENT_SECRET="${!sec_var}" \
AWS_COGNITO_SCOPE="$COGNITO_SCOPE" \
  node "$DEPLOY_DIR/src/test-journey.js" || die "The journey test failed." "Read the ❌ line above, then docs/6-troubleshooting.md"

ok "${B}Done. Next: ./scripts/07-write-demo-ui-settings.sh${N}"
