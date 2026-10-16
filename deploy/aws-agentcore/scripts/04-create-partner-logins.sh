#!/usr/bin/env bash
# 04-create-partner-logins.sh — create the partners' logins in Amazon Cognito.
#
# This is the "front door" lock. Each partner (DRAGONPAY, JUANPAY…) gets its
# own Cognito "app client" — a machine login made of a client id + client
# secret. The partner app trades them for a short-lived token (OAuth2 "client
# credentials"), and AgentCore lets a request in only with a valid token.
#
# Creates: a user pool (a container for logins), a login web address (domain),
# a permission name ("bpi-mcp/invoke"), and one app client per partner.
# Safe to re-run: existing pieces are reused.
#
# ⚠️  The client secrets are saved in .state/outputs.env (git-ignored, readable
#    only by you). Treat that file like a password.
source "$(dirname "$0")/lib/common.sh"
title "Step 4 — Create partner logins in Amazon Cognito"
require_output ACCOUNT_ID "Run ./scripts/00-check-tools.sh first."
RESOURCE_SERVER="bpi-mcp"; SCOPE_NAME="invoke"; SCOPE="$RESOURCE_SERVER/$SCOPE_NAME"

step "1/4 User pool \"$COGNITO_POOL_NAME\""
pool_id="$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$COGNITO_POOL_NAME'].Id | [0]" --output text)"
if [[ -z "$pool_id" || "$pool_id" == "None" ]]; then
  pool_id="$(aws cognito-idp create-user-pool --pool-name "$COGNITO_POOL_NAME" --query UserPool.Id --output text)"
  ok "Created user pool $pool_id"
else
  ok "Using existing user pool $pool_id"
fi
save_output USER_POOL_ID "$pool_id"
save_output COGNITO_DISCOVERY_URL "https://cognito-idp.${AWS_REGION}.amazonaws.com/${pool_id}/.well-known/openid-configuration"

step "2/4 Login web address (Cognito domain)"
domain="$(aws cognito-idp describe-user-pool --user-pool-id "$pool_id" --query UserPool.Domain --output text)"
if [[ -z "$domain" || "$domain" == "None" ]]; then
  domain="${NAME_PREFIX}-${ACCOUNT_ID}"
  aws cognito-idp create-user-pool-domain --user-pool-id "$pool_id" --domain "$domain" >/dev/null
  ok "Created domain $domain"
else
  ok "Using existing domain $domain"
fi
token_url="https://${domain}.auth.${AWS_REGION}.amazoncognito.com/oauth2/token"
save_output COGNITO_TOKEN_URL "$token_url"
save_output COGNITO_SCOPE "$SCOPE"

step "3/4 Permission name \"$SCOPE\""
if aws cognito-idp describe-resource-server --user-pool-id "$pool_id" --identifier "$RESOURCE_SERVER" >/dev/null 2>&1; then
  ok "Already exists"
else
  aws cognito-idp create-resource-server --user-pool-id "$pool_id" --identifier "$RESOURCE_SERVER" --name "BPI MCP Server" \
    --scopes "ScopeName=$SCOPE_NAME,ScopeDescription=Call the BPI MCP Server" >/dev/null
  ok "Created"
fi

step "4/4 One app client per partner: $PARTNERS"
client_ids=(); map="{"
for p in $PARTNERS; do
  cid="$(aws cognito-idp list-user-pool-clients --user-pool-id "$pool_id" --max-results 60 --query "UserPoolClients[?ClientName=='$p'].ClientId | [0]" --output text)"
  if [[ -z "$cid" || "$cid" == "None" ]]; then
    cid="$(aws cognito-idp create-user-pool-client --user-pool-id "$pool_id" --client-name "$p" --generate-secret \
      --allowed-o-auth-flows client_credentials --allowed-o-auth-scopes "$SCOPE" --allowed-o-auth-flows-user-pool-client \
      --query UserPoolClient.ClientId --output text)"
    ok "Created app client for $p: $cid"
  else
    ok "Using existing app client for $p: $cid"
  fi
  secret="$(aws cognito-idp describe-user-pool-client --user-pool-id "$pool_id" --client-id "$cid" --query UserPoolClient.ClientSecret --output text)"
  save_output "CLIENT_ID_${p}" "$cid"
  save_output "CLIENT_SECRET_${p}" "$secret"
  client_ids+=("$cid"); map+="\"$cid\":\"$p\","
done
save_output COGNITO_CLIENT_IDS "$(IFS=,; echo "${client_ids[*]}")"
save_output PARTNER_JWT_CLIENT_MAP "${map%,}}"

first="${PARTNERS%% *}"
step "Test: get a login token for \"$first\" (a new domain can take a minute to work)"
cid_var="CLIENT_ID_${first}"; sec_var="CLIENT_SECRET_${first}"
token_ok() {
  curl -fsS -X POST "$token_url" -u "${!cid_var}:${!sec_var}" \
    -H 'Content-Type: application/x-www-form-urlencoded' -d "grant_type=client_credentials&scope=$SCOPE" | grep -q access_token
}
wait_for "Cognito to issue a token" 300 token_ok || die "Cognito didn't issue a token." "Wait a minute and re-run this script. See 'Cognito' in docs/6-troubleshooting.md"
ok "Token received — partner login works"
console_hint "https://${AWS_REGION}.console.aws.amazon.com/cognito/v2/idp/user-pools → $COGNITO_POOL_NAME → App clients"

echo; ok "${B}Done. Next: ./scripts/05-create-agentcore-runtime.sh${N}"
