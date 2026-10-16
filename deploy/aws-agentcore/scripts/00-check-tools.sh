#!/usr/bin/env bash
# 00-check-tools.sh — make sure everything needed is installed and logged in,
# BEFORE anything is created in AWS. Safe to run as often as you like.
source "$(dirname "$0")/lib/common.sh"
title "Step 0 — Check tools and AWS access (profile: $PROFILE, region: $AWS_REGION)"
problems=0
bad() { warn "$1"; info "   Fix: $2"; problems=$((problems + 1)); }

step "Node.js (runs the scripts and the server)"
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major >= 20 )); then ok "Node.js $(node -v)"; else bad "Node.js $(node -v) is too old (need 20 or newer)." "nvm install 22 && nvm use 22"; fi
else bad "Node.js is not installed." "https://nodejs.org (or: nvm install 22)"; fi

step "zip (packs the MCP server code)"
if command -v zip >/dev/null; then ok "zip is installed"; else bad "zip is not installed." "sudo apt-get update && sudo apt-get install -y zip"; fi

step "AWS CLI version 2 with the AgentCore commands"
if command -v aws >/dev/null; then
  ver="$(aws --version 2>&1)"
  if [[ "$ver" != aws-cli/2* ]]; then
    bad "Found '$ver' — version 2 is required." "See 'Install the AWS CLI' in docs/3-deploy-mcp-server-agentcore.md"
  elif ! aws bedrock-agentcore-control help >/dev/null 2>&1; then
    bad "Your AWS CLI is too old to know about AgentCore ($ver)." "Update it — see 'Install the AWS CLI' in docs/3-deploy-mcp-server-agentcore.md"
  else ok "$ver"; fi
else
  bad "The AWS CLI is not installed." "See 'Install the AWS CLI' in docs/3-deploy-mcp-server-agentcore.md"
fi

step "Logged in to AWS"
if command -v aws >/dev/null && acct="$(aws_account_id 2>/dev/null)"; then
  ok "Logged in to AWS account $acct as $(aws sts get-caller-identity --query Arn --output text)"
  save_output ACCOUNT_ID "$acct"
else
  bad "Not logged in to AWS." "Run: aws configure   (see 'Log in to AWS' in docs/3-deploy-mcp-server-agentcore.md)"
fi

step "Docker (builds the mock bank container for Lightsail)"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then ok "Docker is running"
elif [[ "$PROFILE" == "production" ]]; then info "Docker not found — fine for production (no mock bank needed)."
else bad "Docker is not available or not running." "In Codespaces Docker is usually ready; otherwise see 'Docker' in docs/6-troubleshooting.md"; fi

if [[ "$PROFILE" == "demo" ]]; then
  step "Lightsail container plug-in (lightsailctl) — pushes the mock bank image"
  if command -v lightsailctl >/dev/null; then ok "lightsailctl is installed"
  else bad "lightsailctl is not installed." "sudo curl -fsSL https://s3.us-west-2.amazonaws.com/lightsailctl/latest/linux-amd64/lightsailctl -o /usr/local/bin/lightsailctl && sudo chmod +x /usr/local/bin/lightsailctl"; fi
fi

if [[ "$DEPLOY_METHOD" == "container" ]]; then
  step "Docker can build ARM64 images (only for DEPLOY_METHOD=container)"
  if docker buildx version >/dev/null 2>&1 && docker run --rm --platform linux/arm64 alpine:3.20 uname -m 2>/dev/null | grep -q aarch64; then
    ok "ARM64 builds work"
  else
    bad "This machine can't build ARM64 images." "Easiest: set DEPLOY_METHOD=code in config/deploy-settings.env (no Docker build needed). Or: docker run --privileged --rm tonistiigi/binfmt --install arm64"
  fi
fi

step "AgentCore is reachable in $AWS_REGION"
if command -v aws >/dev/null && aws bedrock-agentcore-control list-agent-runtimes --max-results 1 >/dev/null 2>&1; then
  ok "AgentCore Runtime responds in $AWS_REGION"
else
  bad "Could not call AgentCore in $AWS_REGION." "Check you are logged in and your AWS user has permission (see 'Permissions you need' in docs/3-deploy-mcp-server-agentcore.md)."
fi

echo
if (( problems == 0 )); then
  ok "${B}Everything is ready. Next: ./scripts/01-deploy-mock-bank.sh${N}"
else
  die "$problems thing(s) to fix above. Fix them and run this script again."
fi
