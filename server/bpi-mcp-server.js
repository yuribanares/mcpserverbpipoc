// bpi-mcp-server.js — The "BPI MCP Server".
//
// A real Model Context Protocol server (stdio transport) that BPI would expose
// to partners. It translates high-level MCP tool calls from the MCP client into
// authenticated HTTP calls against the BPI Open Banking API. It deliberately
// keeps OAuth access tokens server-side (mapped to an opaque sessionId) so the
// LLM/agent never handles raw bearer tokens.
//
// MCP protocol traffic uses stdout (JSON-RPC). All human-readable activity is
// written to stderr as `{"__mcplog":true,...}` lines, which the orchestrator
// forwards to the "BPI MCP Server Terminal" panel.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';

const BPI_API_URL = process.env.BPI_API_URL || 'http://localhost:4000';
const CLIENT_ID = process.env.BPI_CLIENT_ID || 'a3f7832f-0f15-46e2-9070-29e6e89f2c2e';
const CLIENT_SECRET = process.env.BPI_CLIENT_SECRET || 'rF1yE3tQ4rP2tY2qQ8dQ4sM0vU2fM0oI0fT5bA7vX7bD8dU8cV';

// session map kept inside the MCP server: the LLM only ever sees a sessionId.
const sessions = new Map(); // sessionId -> { access_token, scope }

function slog(level, text, data, ms) {
  process.stderr.write(JSON.stringify({ __mcplog: true, level, text, data: data ?? null, ms: Number.isFinite(ms) ? ms : null }) + '\n');
}

async function bpiFetch(method, path, { headers = {}, json, form, bearer, transactionId } = {}) {
  const url = `${BPI_API_URL}${path}`;
  const h = { ...headers };
  if (bearer) h['Authorization'] = `Bearer ${bearer}`;
  h['X-IBM-Client-Id'] = CLIENT_ID;
  h['X-IBM-Client-Secret'] = CLIENT_SECRET;
  if (transactionId) h['transactionId'] = transactionId;
  let body;
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  slog('http', `→ ${method} ${path}`);
  const started = Date.now();
  const res = await fetch(url, { method, headers: h, body });
  const data = await res.json().catch(() => ({}));
  slog(res.ok ? 'ok' : 'err', `← ${res.status} ${path}`, null, Date.now() - started);
  return { ok: res.ok, status: res.status, data, transactionId: res.headers.get('transactionId') };
}

const TOOLS = [
  {
    name: 'bpi_begin_authorization',
    description: 'Begin BPI 3-Legged OAuth. The BPI MCP server (which owns the client_id and the requested scopes) returns the hosted BPI /authorize URL that the partner app should open in a browser/webview for the customer to log in and consent. The customer\'s credentials are entered directly on the BPI page and are never seen by this server.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Opaque CSRF state value (optional; generated if omitted)' },
        redirectUri: { type: 'string', description: 'Partner redirect URI registered during onboarding (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'bpi_exchange_token',
    description: 'Complete BPI 3-Legged OAuth by exchanging the authorization code for an access token. Returns an opaque sessionId to use in subsequent BPI tool calls. The access token is held securely by the BPI MCP server and never exposed.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Authorization code from the BPI login/consent flow' } },
      required: ['code'],
    },
  },
  {
    name: 'bpi_list_transactional_accounts',
    description: "Retrieve the customer's BPI transactional (CASA) accounts eligible for fund top-up. Returns masked account numbers and opaque accountNumberTokens.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'bpi_fundtopup_initiate',
    description: 'Initiate a Fund Top-Up from a chosen source account. Returns a transactionId and the masked mobile number that will receive the transaction OTP.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        accountNumberToken: { type: 'string' },
        amount: { type: 'number' },
        remarks: { type: 'string' },
        merchantTransactionReference: { type: 'string' },
      },
      required: ['sessionId', 'accountNumberToken', 'amount'],
    },
  },
  {
    name: 'bpi_fundtopup_send_otp',
    description: 'Request BPI to send the transaction OTP via SMS for an initiated Fund Top-Up. Returns the OTP validity window.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' }, mobileNumberToken: { type: 'string' } },
      required: ['sessionId', 'transactionId'],
    },
  },
  {
    name: 'bpi_fundtopup_process',
    description: 'Finalize the Fund Top-Up by submitting the transaction OTP. Returns the confirmation number and timestamp on success.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' }, otp: { type: 'string' } },
      required: ['sessionId', 'transactionId', 'otp'],
    },
  },
  {
    name: 'bpi_fundtopup_status',
    description: 'Check the posting status of a Fund Top-Up transaction (SUCCESSFUL, PROCESSING, INCOMPLETE).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' } },
      required: ['sessionId', 'transactionId'],
    },
  },
];

const server = new Server(
  { name: 'bpi-open-banking-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  slog('info', `tools/list → ${TOOLS.length} tools advertised`);
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  slog('tool', `tools/call ${name}`, summarizeArgs(args));
  try {
    const result = await dispatch(name, args);
    slog('ok', `tools/call ${name} ✓`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    slog('err', `tools/call ${name} ✗ ${err.message}`);
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
});

function requireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid or expired sessionId. Call bpi_exchange_token first.');
  return s;
}

async function dispatch(name, args) {
  switch (name) {
    case 'bpi_begin_authorization': {
      // The server constructs the authorize URL from the credentials it owns.
      // No upstream call yet — the customer opens this URL in their browser.
      const scope = 'transactionalAccountsForBillsPay fundTopUp';
      const redirectUri = args.redirectUri || 'https://partner.example/callback';
      const state = args.state || crypto.randomBytes(12).toString('hex');
      const authorizeUrl = `${BPI_API_URL}/bpi/api/oauth2/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&scope=${encodeURIComponent(scope)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      slog('info', `Authorization initiated by MCP server. scope="${scope}" — returning hosted /authorize URL to client.`);
      return { authorizeUrl, scope, state, redirectUri };
    }
    case 'bpi_exchange_token': {
      const r = await bpiFetch('POST', '/bpi/api/oauth2/token', {
        form: { grant_type: 'authorization_code', code: args.code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      });
      if (!r.ok) throw new Error(r.data.error || 'token exchange failed');
      const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
      sessions.set(sessionId, { access_token: r.data.access_token, scope: r.data.scope });
      slog('info', `OAuth session established (${sessionId}) scope="${r.data.scope}" expires_in=${r.data.expires_in}s`);
      return { sessionId, scope: r.data.scope, expires_in: r.data.expires_in, token_type: r.data.token_type };
    }
    case 'bpi_list_transactional_accounts': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('GET', '/bpi/api/accounts/transactionalAccounts', { bearer: s.access_token });
      if (!r.ok) throw new Error(r.data.description || 'account retrieval failed');
      return r.data.body;
    }
    case 'bpi_fundtopup_initiate': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/initiate', {
        bearer: s.access_token,
        json: {
          merchantTransactionReference: args.merchantTransactionReference || String(Date.now()),
          accountNumberToken: args.accountNumberToken,
          amount: args.amount,
          remarks: args.remarks || 'Load funds to wallet',
        },
      });
      if (!r.ok) throw new Error(r.data.description || 'initiate failed');
      return { transactionId: r.data.transactionId, ...r.data.body };
    }
    case 'bpi_fundtopup_send_otp': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/otp', {
        bearer: s.access_token, transactionId: args.transactionId,
        json: { mobileNumberToken: args.mobileNumberToken },
      });
      if (!r.ok) throw new Error(r.data.description || 'otp request failed');
      return r.data.body;
    }
    case 'bpi_fundtopup_process': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/process', {
        bearer: s.access_token, transactionId: args.transactionId,
        json: { otp: args.otp },
      });
      if (!r.ok) throw new Error(r.data.description || 'process failed');
      return r.data.body;
    }
    case 'bpi_fundtopup_status': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('GET', '/bpi/api/fundTopUp/status', { bearer: s.access_token, transactionId: args.transactionId });
      if (!r.ok) throw new Error(r.data.description || 'status failed');
      return r.data.body;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function summarizeArgs(args) {
  const a = { ...args };
  if (a.code) a.code = a.code.slice(0, 10) + '…';
  if (a.accountNumberToken) a.accountNumberToken = a.accountNumberToken.slice(0, 10) + '…';
  return a;
}

const transport = new StdioServerTransport();
await server.connect(transport);
slog('info', `BPI MCP Server connected over stdio. Upstream API: ${BPI_API_URL}`);
