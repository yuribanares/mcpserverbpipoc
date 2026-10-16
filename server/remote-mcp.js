// remote-mcp.js — connect to the BPI MCP Server over HTTPS (MCP_MODE=aws).
//
// Used only when the demo UI talks to the AWS-hosted server on Amazon Bedrock
// AgentCore Runtime (and by deploy/aws-agentcore/src/test-journey.js). The
// local PoC (MCP_MODE=local) never loads this file.
//
// Three small jobs:
//   1. Build the AgentCore "invoke" web address from the runtime's ARN.
//   2. Get (and re-use) a Cognito login token for the partner app — the
//      "front-door" check AgentCore performs before any request reaches us.
//   3. Open an MCP connection that attaches that token to every request.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// AgentCore exposes each runtime at a fixed address built from its ARN.
export function agentCoreInvokeUrl(region, runtimeArn) {
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=DEFAULT`;
}

// OAuth2 "client credentials": the partner app swaps its Cognito app-client
// id + secret for a short-lived access token. We cache it and refresh it a
// minute before it expires. Returns a getToken() function (null = no auth,
// e.g. when testing against a local server).
export function createTokenProvider({ tokenUrl, clientId, clientSecret, scope } = {}) {
  if (!tokenUrl || !clientId || !clientSecret) return async () => null;
  let cached = null; // { token, expiresAt }
  return async function getToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) body.set('scope', scope);
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Cognito login failed (${res.status} ${data.error || ''}). Check the AWS_COGNITO_* settings.`);
    }
    cached = { token: data.access_token, expiresAt: Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000 };
    return cached.token;
  };
}

// Open an MCP session over Streamable HTTP. Every request gets a fresh
// "Authorization: Bearer <token>" header. AgentCore adds an Mcp-Session-Id
// header to its replies; the SDK sends it back automatically, which keeps all
// our calls on the same server instance.
export async function connectRemoteMcp({ url, getToken, clientName = 'dragonpay-mcp-client' }) {
  const authFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const token = await getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: authFetch });
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// Tool results from a demo-mode AWS server carry the server's (and the mock
// bank's) terminal lines in result._meta.serverLogs. Returns [] otherwise.
export function serverLogsOf(result) {
  return Array.isArray(result?._meta?.serverLogs) ? result._meta.serverLogs : [];
}
