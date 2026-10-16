#!/usr/bin/env bash
# 07-write-demo-ui-settings.sh — point the 4-panel demo UI at AWS.
#
# Copies the AWS addresses and the first partner's Cognito login into the
# repository's .env file and sets MCP_MODE=aws. Nothing to paste by hand.
# A backup of your current .env is kept (.env.backup-<date>).
#
#   Switch back to the local PoC any time:  set MCP_MODE=local in .env
#   Switch to AWS again:                    set MCP_MODE=aws   (or re-run this)
source "$(dirname "$0")/lib/common.sh"
title "Step 7 — Connect the demo UI to AWS"
require_output RUNTIME_ARN "Run ./scripts/05-create-agentcore-runtime.sh first."
require_output COGNITO_TOKEN_URL "Run ./scripts/04-create-partner-logins.sh first."

first="${PARTNERS%% *}"
cid_var="CLIENT_ID_${first}"; sec_var="CLIENT_SECRET_${first}"
bank="${MOCK_BANK_URL:-}"
[[ "${BPI_API_URL:-auto}" != "auto" ]] && bank="$BPI_API_URL"

envfile="$REPO_ROOT/.env"
if [[ -f "$envfile" ]]; then
  cp "$envfile" "$REPO_ROOT/.env.backup-$(date +%Y%m%d-%H%M%S)"
  ok "Backed up your current .env"
else
  cp "$REPO_ROOT/.env.example" "$envfile"
  ok "Created .env from .env.example"
fi

# Update (or add) each setting in place, keeping everything else (e.g. your Gemini key).
ENVFILE="$envfile" \
MCP_MODE=aws \
AWS_REGION="$AWS_REGION" \
AWS_AGENTCORE_RUNTIME_ARN="$RUNTIME_ARN" \
AWS_BANK_URL="$bank" \
AWS_COGNITO_TOKEN_URL="$COGNITO_TOKEN_URL" \
AWS_COGNITO_CLIENT_ID="${!cid_var}" \
AWS_COGNITO_CLIENT_SECRET="${!sec_var}" \
AWS_COGNITO_SCOPE="$COGNITO_SCOPE" \
AWS_MCP_URL="" \
node --input-type=module -e '
  import fs from "node:fs";
  const keys = ["MCP_MODE","AWS_REGION","AWS_AGENTCORE_RUNTIME_ARN","AWS_BANK_URL","AWS_COGNITO_TOKEN_URL","AWS_COGNITO_CLIENT_ID","AWS_COGNITO_CLIENT_SECRET","AWS_COGNITO_SCOPE","AWS_MCP_URL"];
  let text = fs.readFileSync(process.env.ENVFILE, "utf8");
  for (const k of keys) {
    const line = `${k}=${process.env[k] ?? ""}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => line) : text.replace(/\n?$/, "\n") + line + "\n";
  }
  fs.writeFileSync(process.env.ENVFILE, text);
'
chmod 600 "$envfile"
ok "Updated .env: MCP_MODE=aws, plus the AgentCore, bank and Cognito settings (partner: $first)"

echo
info "${B}Now start the demo UI:${N}"
info "   cd $(realpath --relative-to="$PWD" "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT") && npm start"
info "The top bar will show:  MCP: AWS AgentCore ($AWS_REGION) · Bank: Lightsail mock"
info "Tip: send one warm-up message before a live demo — the first AWS call after a pause takes a few seconds."
info "Back to the local PoC: set MCP_MODE=local in .env and restart npm start."
