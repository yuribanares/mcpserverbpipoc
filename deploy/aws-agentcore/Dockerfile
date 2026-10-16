# Dockerfile — the BPI MCP Server as a container, for AgentCore Runtime.
# Only used with DEPLOY_METHOD=container (the default "code" method uploads a
# zip instead and needs no Docker). Built by scripts/02-upload-mcp-server.sh:
#   docker buildx build --platform linux/arm64 -f deploy/aws-agentcore/Dockerfile .
# AgentCore requires ARM64 images and an MCP server on 0.0.0.0:8000/mcp.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8000

COPY deploy/aws-agentcore/package.json deploy/aws-agentcore/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error

# server/bpi-mcp-server.js is the SAME file the local PoC runs.
COPY server/bpi-mcp-server.js ./server/
COPY deploy/aws-agentcore/src/http-server.js deploy/aws-agentcore/src/settings.js \
     deploy/aws-agentcore/src/partner-registry.js deploy/aws-agentcore/src/session-store.js \
     deploy/aws-agentcore/src/caller-identity.js ./deploy/aws-agentcore/src/

EXPOSE 8000
USER node
CMD ["node", "deploy/aws-agentcore/src/http-server.js"]
