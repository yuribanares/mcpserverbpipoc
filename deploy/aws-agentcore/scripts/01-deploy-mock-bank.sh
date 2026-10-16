#!/usr/bin/env bash
# 01-deploy-mock-bank.sh — put the demo mock bank on Amazon Lightsail.
#
# What it does (about 5–10 minutes):
#   1. Builds the mock bank into a container image (Dockerfile.mock-bank).
#   2. Creates a Lightsail "container service" (a small always-on server with
#      its own public HTTPS address).
#   3. Uploads the image and starts it, with a /health check.
#   4. Saves the public address as MOCK_BANK_URL for the next scripts.
# Safe to re-run: it reuses the service and just deploys the latest code.
source "$(dirname "$0")/lib/common.sh"
title "Step 1 — Deploy the mock bank to Amazon Lightsail ($AWS_REGION)"
[[ "$PROFILE" == "demo" ]] || die "The mock bank is for the demo profile only." "In production the server calls the real BPI API (BPI_API_URL in config/production.env)."

IMAGE_TAG="bpi-mock-bank:latest"
LABEL="mockbank"

step "1/4 Build the mock bank container image"
info "Uses server/bpi-api.js unchanged — same accounts, OTP rules and responses as the local PoC."
docker build --platform linux/amd64 -f "$DEPLOY_DIR/Dockerfile.mock-bank" -t "$IMAGE_TAG" "$REPO_ROOT"
ok "Image built: $IMAGE_TAG"

step "2/4 Create the Lightsail container service \"$LIGHTSAIL_SERVICE\" (if needed)"
service_state() { aws lightsail get-container-services --service-name "$LIGHTSAIL_SERVICE" --query 'containerServices[0].state' --output text 2>/dev/null; }
if state="$(service_state)"; then
  ok "Service already exists (state: $state)"
else
  aws lightsail create-container-service --service-name "$LIGHTSAIL_SERVICE" --power "$LIGHTSAIL_POWER" --scale 1 >/dev/null
  ok "Service created (power: $LIGHTSAIL_POWER, 1 copy)"
fi
is_ready() { [[ "$(service_state)" =~ ^(READY|RUNNING)$ ]]; }
wait_for "the service to be ready (usually 2–5 minutes)" 900 is_ready || die "The service did not become ready." "Open the Lightsail console and check the service's status."

step "3/4 Upload the image and start it"
push_out="$(aws lightsail push-container-image --service-name "$LIGHTSAIL_SERVICE" --label "$LABEL" --image "$IMAGE_TAG" 2>&1)" \
  || die "Upload failed: $push_out" "Is lightsailctl installed? Run ./scripts/00-check-tools.sh"
MOCK_BANK_IMAGE="$(grep -oE '":[a-zA-Z0-9.-]+\.'"$LABEL"'\.[0-9]+"' <<<"$push_out" | tail -1 | tr -d '"')"
[[ -n "$MOCK_BANK_IMAGE" ]] || die "Couldn't read the uploaded image name from: $push_out"
export MOCK_BANK_IMAGE
ok "Image uploaded as $MOCK_BANK_IMAGE"
payload="$(render_payload lightsail-deployment)"
aws lightsail create-container-service-deployment --cli-input-json "file://$payload" >/dev/null
ok "Deployment started (settings sent: .state/payloads/lightsail-deployment.json)"
is_running() {
  [[ "$(aws lightsail get-container-services --service-name "$LIGHTSAIL_SERVICE" \
      --query 'containerServices[0].[state, currentDeployment.state]' --output text 2>/dev/null)" == $'RUNNING\tACTIVE' ]]
}
wait_for "the mock bank to start (usually 3–5 minutes)" 1200 is_running \
  || die "The deployment did not become active." "Lightsail console → $LIGHTSAIL_SERVICE → Deployments shows why (often a failed /health check)."

step "4/4 Check the mock bank answers on the internet"
url="$(aws lightsail get-container-services --service-name "$LIGHTSAIL_SERVICE" --query 'containerServices[0].url' --output text)"
url="${url%/}"
save_output MOCK_BANK_URL "$url"
health_ok() { curl -fsS "$url/health" | grep -q '"status":"ok"'; }
wait_for "$url/health to answer" 300 health_ok || die "The bank doesn't answer at $url/health yet." "Wait a minute and run: curl $url/health"
ok "Mock bank is live: $url"
console_hint "https://lightsail.aws.amazon.com/ls/webapp/home/containers → $LIGHTSAIL_SERVICE"

echo; ok "${B}Done. Next: ./scripts/02-upload-mcp-server.sh${N}"
