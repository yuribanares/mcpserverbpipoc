#!/usr/bin/env bash
# 02-upload-mcp-server.sh — package the BPI MCP Server and upload it to AWS.
#
# DEPLOY_METHOD=code (default, recommended — no Docker needed):
#   Builds a .zip with the server code + its libraries and uploads it to a
#   private Amazon S3 bucket. AgentCore runs it with its built-in Node.js 22.
# DEPLOY_METHOD=container:
#   Builds an ARM64 container image and pushes it to Amazon ECR.
#
# The zip/image contains server/bpi-mcp-server.js — the SAME file the local
# PoC runs — plus the small HTTP entry point in deploy/aws-agentcore/src/.
source "$(dirname "$0")/lib/common.sh"
title "Step 2 — Package and upload the BPI MCP Server (method: $DEPLOY_METHOD)"
require_output ACCOUNT_ID "Run ./scripts/00-check-tools.sh first."

if [[ "$DEPLOY_METHOD" == "code" ]]; then
  BUILD="$DEPLOY_DIR/.build/bpi-mcp-server"
  ZIP="$DEPLOY_DIR/.build/bpi-mcp-server.zip"

  step "1/3 Collect the code (same layout as the repository)"
  rm -rf "$BUILD" "$ZIP"; mkdir -p "$BUILD/server" "$BUILD/deploy/aws-agentcore/src"
  cp "$DEPLOY_DIR/package.json" "$DEPLOY_DIR/package-lock.json" "$BUILD/"
  cp "$REPO_ROOT/server/bpi-mcp-server.js" "$BUILD/server/"
  for f in http-server.js settings.js partner-registry.js session-store.js caller-identity.js; do
    cp "$DEPLOY_DIR/src/$f" "$BUILD/deploy/aws-agentcore/src/"
  done
  ok "Copied server/bpi-mcp-server.js + the HTTP entry point"

  step "2/3 Install the libraries for AgentCore's Linux ARM64 machines"
  (cd "$BUILD" && npm ci --omit=dev --os=linux --cpu=arm64 --no-audit --no-fund --loglevel=error)
  (cd "$BUILD" && zip -qr "$ZIP" .)
  ok "Created $(basename "$ZIP") ($(du -h "$ZIP" | cut -f1))"

  step "3/3 Upload to a private S3 bucket"
  bucket="${NAME_PREFIX}-code-${ACCOUNT_ID}-${AWS_REGION}"
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    aws s3api put-public-access-block --bucket "$bucket" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
    ok "Created private bucket $bucket"
  else
    ok "Using existing bucket $bucket"
  fi
  key="bpi-mcp-server/bpi-mcp-server-$(date +%Y%m%d-%H%M%S).zip"
  aws s3 cp "$ZIP" "s3://$bucket/$key" --only-show-errors
  save_output CODE_BUCKET "$bucket"
  save_output CODE_KEY "$key"
  ok "Uploaded to s3://$bucket/$key"
  console_hint "https://s3.console.aws.amazon.com/s3/buckets/$bucket"

elif [[ "$DEPLOY_METHOD" == "container" ]]; then
  repo_uri="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
  tag="$(date +%Y%m%d-%H%M%S)"

  step "1/3 Create the ECR repository \"$ECR_REPO\" (if needed)"
  aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "$ECR_REPO" --image-scanning-configuration scanOnPush=true >/dev/null
  ok "Repository ready: $repo_uri"

  step "2/3 Log Docker in to ECR"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" >/dev/null
  ok "Logged in"

  step "3/3 Build the ARM64 image and push it (can take several minutes)"
  docker buildx build --platform linux/arm64 -f "$DEPLOY_DIR/Dockerfile" -t "$repo_uri:$tag" --push "$REPO_ROOT"
  save_output IMAGE_URI "$repo_uri:$tag"
  ok "Pushed $repo_uri:$tag"
  console_hint "https://${AWS_REGION}.console.aws.amazon.com/ecr/repositories → $ECR_REPO"
else
  die "Unknown DEPLOY_METHOD \"$DEPLOY_METHOD\"." "Use code or container in config/deploy-settings.env."
fi

echo; ok "${B}Done. Next: ./scripts/03-create-permissions.sh${N}"
