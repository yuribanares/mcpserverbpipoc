// ═══════════════════════════════════════════════════════════════════════════
// bpi-mcp-server.js — THE "BPI MCP SERVER"
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS IS
//   This file *is* the product. It is an MCP (Model Context Protocol) server
//   that BPI owns and operates and offers to partners. A partner's AI app (its
//   "MCP client") connects here and calls "tools" to move money through BPI
//   Open Banking — without the partner ever handling BPI credentials or raw
//   customer data directly.
//
// WHAT IS MCP, IN ONE LINE
//   A standard way for an AI/LLM app to call functions ("tools") on an external
//   server. The AI decides WHAT to do; this server decides HOW it is done safely.
//
// HOW IT COMMUNICATES
//   • stdout  = the MCP protocol itself (JSON-RPC messages) — for machines.
//   • stderr  = our plain-English activity log — shown in the demo UI's
//               "BPI MCP Server Terminal" panel (see slog() below).
//
// THE 8 TOOLS THIS SERVER OFFERS  (and the BPI Open Banking endpoint each maps to)
//   Onboarding / auth:
//     1. bpi_partner_authenticate        → (no API call) authenticates the PARTNER
//     2. bpi_begin_authorization         → (no API call) builds BPI's /authorize URL
//     3. bpi_exchange_token              → POST /bpi/api/oauth2/token
//   Account data:
//     4. bpi_list_transactional_accounts → GET  /bpi/api/accounts/transactionalAccounts
//   Payment (Fund Top-Up):
//     5. bpi_fundtopup_initiate          → POST /bpi/api/fundTopUp/initiate
//     6. bpi_fundtopup_send_otp          → POST /bpi/api/fundTopUp/otp
//     7. bpi_fundtopup_process           → POST /bpi/api/fundTopUp/process
//     8. bpi_fundtopup_status            → GET  /bpi/api/fundTopUp/status
//
// TWO SECURITY BOUNDARIES THIS FILE ENFORCES
//   1. Partner ↔ this server: the partner authenticates with ITS OWN credential
//      (bpi_partner_authenticate). BPI then looks up that partner's BPI Open
//      Banking secret from its vault — the secret NEVER leaves this server.
//   2. Customer ↔ BPI: the customer's BPI login + OTP happen on BPI's own pages;
//      this server never sees them. It only handles the resulting token,
//      server-side, so the AI never holds a raw access token either.
//
// THE LIFECYCLE OF ONE TOOL CALL
//   client → (JSON-RPC "tools/call") → CallTool handler → dispatch(name, args)
//          → bpiFetch(...) → BPI Open Banking API → result flows back up.
// ═══════════════════════════════════════════════════════════════════════════

// The MCP SDK gives us a ready-made protocol server + the stdio transport.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';

// ─── Configuration ──────────────────────────────────────────────────────────
// Where BPI's Open Banking API lives. In this PoC it is a local mock; in
// production it would be BPI's real API gateway.
const BPI_API_URL = process.env.BPI_API_URL || 'http://localhost:4000';

// ─── Partner registry = BPI's vault (multi-tenant) ──────────────────────────
// This table belongs to BPI, not to any partner. Because BPI operates this
// server as a product, it onboards many partners. Each partner has:
//   (a) an MCP-layer "partner access credential" — how they prove who they are
//       to THIS server (mcpClientId + mcpClientSecret), and
//   (b) their BPI Open Banking client_id/secret — the powerful banking
//       credential, kept here in BPI's vault and NEVER handed back to anyone.
// The partner's app only ever receives an opaque token, never these secrets.
const PARTNER_REGISTRY = {
  // mcpClientId -> tenant record
  'mcp_dragonpay_7f3a91': {
    partnerId: 'dragonpay',
    displayName: 'DRAGONPAY CORP',
    mcpClientSecret: process.env.PARTNER_MCP_CLIENT_SECRET || 'mcps_dragonpay_4b9c2e7f10a8d6',
    // BPI Open Banking credentials held in BPI's vault for this tenant:
    bpiClientId: process.env.BPI_CLIENT_ID || 'a3f7832f-0f15-46e2-9070-29e6e89f2c2e',
    bpiClientSecret: process.env.BPI_CLIENT_SECRET || 'rF1yE3tQ4rP2tY2qQ8dQ4sM0vU2fM0oI0fT5bA7vX7bD8dU8cV',
    scopes: 'transactionalAccountsForBillsPay fundTopUp',
  },
  // A second tenant, to make the "which partner → which secret" mapping concrete.
  'mcp_juanpay_2c5d80': {
    partnerId: 'juanpay',
    displayName: 'JUANPAY INC',
    mcpClientSecret: 'mcps_juanpay_9f1a3c5e7b2d4a',
    bpiClientId: 'b71e9d04-5c2a-41f8-8a3e-7d6c2b1f9e44',
    bpiClientSecret: 'sG2zF4uR5sQ3uZ3rR9eR5tN1wV3gN1pJ1gU6cB8wY8cE9eV9dW',
    scopes: 'transactionalAccountsForBillsPay fundTopUp',
  },
};

// ─── Server-side state (nothing sensitive ever leaves this process) ──────────
// The partner app and the AI only ever see the opaque *keys* of these maps
// (a "partnerToken" / "sessionId"). The secrets and access tokens stay here.
const partnerSessions = new Map(); // partnerToken -> { partnerId, displayName, bpiClientId, bpiClientSecret, scopes }
const sessions = new Map();        // sessionId   -> { access_token, scope, partnerId, bpiClientId, bpiClientSecret }

// ─── Logging ────────────────────────────────────────────────────────────────
// Write a structured line to stderr. The orchestrator reads these and prints
// them in the "BPI MCP Server Terminal" panel. (stdout is reserved for the MCP
// protocol, so all human logging must go to stderr.)
function slog(level, text, data, ms) {
  process.stderr.write(JSON.stringify({ __mcplog: true, level, text, data: data ?? null, ms: Number.isFinite(ms) ? ms : null }) + '\n');
}

// ─── HTTP helper: this server → BPI Open Banking API ────────────────────────
// Every tool that needs live BPI data goes through here. `creds` carries the
// authenticated tenant's BPI client_id/secret, which are attached as the
// X-IBM-* headers BPI's API expects. A `bearer` (the customer's access token)
// is attached when the call acts on a specific customer.
async function bpiFetch(method, path, { headers = {}, json, form, bearer, transactionId, creds } = {}) {
  const url = `${BPI_API_URL}${path}`;
  const h = { ...headers };
  if (bearer) h['Authorization'] = `Bearer ${bearer}`;                 // customer's access token
  h['X-IBM-Client-Id'] = creds?.bpiClientId || PARTNER_REGISTRY['mcp_dragonpay_7f3a91'].bpiClientId;         // which partner (BPI credential)
  h['X-IBM-Client-Secret'] = creds?.bpiClientSecret || PARTNER_REGISTRY['mcp_dragonpay_7f3a91'].bpiClientSecret; // stays server-side
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

// ─── Tool catalog ───────────────────────────────────────────────────────────
// This is the "menu" the server advertises to clients (via tools/list). Each
// entry has: a name, a human-readable description (the AI reads this to decide
// WHEN to use the tool), and an inputSchema (the arguments the tool expects).
// The AI never sees the code below — only this catalog.
const TOOLS = [
  {
    // 1. Authenticates the PARTNER app to this server. No BPI API call — this is
    //    the "who are you?" step for the partner, resolved against the registry.
    name: 'bpi_partner_authenticate',
    description: "Authenticate the partner application to BPI's MCP server using the partner's MCP access credentials (OAuth2 client-credentials). Returns an opaque partnerToken identifying the partner tenant for this session. NOTE: these are the partner's MCP-layer credentials, NOT BPI Open Banking credentials — BPI resolves the tenant's Open Banking secret server-side and never exposes it.",
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: "Partner's MCP access client id issued by BPI at onboarding" },
        clientSecret: { type: 'string', description: "Partner's MCP access client secret" },
      },
      required: ['clientId', 'clientSecret'],
    },
  },
  {
    // 2. Starts the customer's BPI login. No BPI API call yet — it just builds
    //    the hosted /authorize URL the partner app opens in a browser.
    name: 'bpi_begin_authorization',
    description: 'Begin BPI 3-Legged OAuth. The BPI MCP server (which owns the client_id and the requested scopes for the authenticated partner tenant) returns the hosted BPI /authorize URL that the partner app should open in a browser/webview for the customer to log in and consent. The customer\'s credentials are entered directly on the BPI page and are never seen by this server.',
    inputSchema: {
      type: 'object',
      properties: {
        partnerToken: { type: 'string', description: 'Partner session token from bpi_partner_authenticate' },
        state: { type: 'string', description: 'Opaque CSRF state value (optional; generated if omitted)' },
        redirectUri: { type: 'string', description: 'Partner redirect URI registered during onboarding (optional)' },
      },
      required: ['partnerToken'],
    },
  },
  {
    // 3. Turns the login "authorization code" into an access token.
    //    → POST /bpi/api/oauth2/token   (needs client_secret, so server-only)
    name: 'bpi_exchange_token',
    description: 'Complete BPI 3-Legged OAuth by exchanging the authorization code for an access token. Returns an opaque sessionId to use in subsequent BPI tool calls. The access token is held securely by the BPI MCP server and never exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        partnerToken: { type: 'string', description: 'Partner session token from bpi_partner_authenticate' },
        code: { type: 'string', description: 'Authorization code from the BPI login/consent flow' },
      },
      required: ['partnerToken', 'code'],
    },
  },
  {
    // 4. Lists the customer's BPI accounts to fund from.
    //    → GET /bpi/api/accounts/transactionalAccounts
    name: 'bpi_list_transactional_accounts',
    description: "Retrieve the customer's BPI transactional (CASA) accounts eligible for fund top-up. Returns masked account numbers and opaque accountNumberTokens.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    // 5. Starts a top-up from the chosen account.
    //    → POST /bpi/api/fundTopUp/initiate
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
    // 6. Asks BPI to text the transaction OTP to the customer.
    //    → POST /bpi/api/fundTopUp/otp
    name: 'bpi_fundtopup_send_otp',
    description: 'Request BPI to send the transaction OTP via SMS for an initiated Fund Top-Up. Returns the OTP validity window.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' }, mobileNumberToken: { type: 'string' } },
      required: ['sessionId', 'transactionId'],
    },
  },
  {
    // 7. Confirms the top-up with the OTP the customer entered.
    //    → POST /bpi/api/fundTopUp/process
    name: 'bpi_fundtopup_process',
    description: 'Finalize the Fund Top-Up by submitting the transaction OTP. Returns the confirmation number and timestamp on success.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' }, otp: { type: 'string' } },
      required: ['sessionId', 'transactionId', 'otp'],
    },
  },
  {
    // 8. Checks whether a top-up posted (safety net / reconciliation).
    //    → GET /bpi/api/fundTopUp/status
    name: 'bpi_fundtopup_status',
    description: 'Check the posting status of a Fund Top-Up transaction (SUCCESSFUL, PROCESSING, INCOMPLETE).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, transactionId: { type: 'string' } },
      required: ['sessionId', 'transactionId'],
    },
  },
];

// ─── MCP server wiring ──────────────────────────────────────────────────────
// Create the protocol server and declare that we provide "tools".
const server = new Server(
  { name: 'bpi-open-banking-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// A client calls "tools/list" once, up front, to discover what this server can
// do. We simply return the catalog above.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  slog('info', `tools/list → ${TOOLS.length} tools advertised`);
  return { tools: TOOLS };
});

// The heart of the server: every "tools/call" request lands here. We log it,
// route it to dispatch() by tool name, and wrap the result in MCP's response
// envelope. Any thrown error becomes a clean isError result — the server never
// crashes on a bad request.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;   // which tool + its inputs
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

// ─── Auth guards ────────────────────────────────────────────────────────────
// Turn an opaque token back into its server-side record, or reject the call.
// These enforce the ordering: a partner must authenticate before doing OAuth,
// and OAuth must complete before any account/payment call.
function requireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid or expired sessionId. Call bpi_exchange_token first.');
  return s;
}

function requirePartner(partnerToken) {
  const p = partnerSessions.get(partnerToken);
  if (!p) throw new Error('Partner not authenticated. Call bpi_partner_authenticate first.');
  return p;
}

// ─── Dispatch: the actual work behind each tool ─────────────────────────────
async function dispatch(name, args) {
  switch (name) {
    // ── 1. PARTNER AUTH (Layer 1 of 2) ──────────────────────────────────────
    // Prove which partner is calling, then hand back only an opaque token.
    case 'bpi_partner_authenticate': {
      // Look the partner up in BPI's registry and check their MCP secret.
      const tenant = PARTNER_REGISTRY[args.clientId];
      const ok = tenant && timingSafeEqual(tenant.mcpClientSecret, args.clientSecret);
      if (!ok) {
        slog('err', `Partner authentication failed for clientId="${shorten(args.clientId)}".`);
        throw new Error('invalid_partner_client');
      }
      // On success we bind the tenant's BPI vault credentials to a fresh token.
      // The caller receives the token only — never the underlying BPI secret.
      const partnerToken = 'ptkn_' + crypto.randomBytes(12).toString('hex');
      partnerSessions.set(partnerToken, {
        partnerId: tenant.partnerId, displayName: tenant.displayName,
        bpiClientId: tenant.bpiClientId, bpiClientSecret: tenant.bpiClientSecret, scopes: tenant.scopes,
      });
      slog('ok', `Partner authenticated: tenant="${tenant.displayName}" (${tenant.partnerId}). Resolved its BPI Open Banking client_id from vault; client_secret stays server-side.`);
      return { partnerToken, partner: tenant.displayName, partnerId: tenant.partnerId, scopes: tenant.scopes };
    }

    // ── 2. BEGIN CUSTOMER OAUTH (Layer 2 of 2) ──────────────────────────────
    // Build BPI's hosted login URL using THIS tenant's client_id. No API call
    // yet — the customer opens this URL and logs in on BPI's own page.
    case 'bpi_begin_authorization': {
      const p = requirePartner(args.partnerToken);
      const scope = p.scopes;
      const redirectUri = args.redirectUri || 'https://partner.example/callback';
      const state = args.state || crypto.randomBytes(12).toString('hex');
      const authorizeUrl = `${BPI_API_URL}/bpi/api/oauth2/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(p.bpiClientId)}` +
        `&scope=${encodeURIComponent(scope)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      slog('info', `Authorization initiated for tenant "${p.displayName}" with that tenant's BPI client_id. Returning hosted /authorize URL.`);
      return { authorizeUrl, scope, state, redirectUri };
    }

    // ── 3. EXCHANGE CODE → TOKEN ─────────────────────────────────────────────
    // The "back-channel" step. It needs the tenant's client_secret, so it can
    // ONLY run here on the server. The resulting access token is stored against
    // an opaque sessionId; the caller/AI receives the sessionId, never the token.
    case 'bpi_exchange_token': {
      const p = requirePartner(args.partnerToken);
      const r = await bpiFetch('POST', '/bpi/api/oauth2/token', {
        creds: p,
        form: { grant_type: 'authorization_code', code: args.code, client_id: p.bpiClientId, client_secret: p.bpiClientSecret },
      });
      if (!r.ok) throw new Error(r.data.error || 'token exchange failed');
      const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
      sessions.set(sessionId, { access_token: r.data.access_token, scope: r.data.scope, partnerId: p.partnerId, bpiClientId: p.bpiClientId, bpiClientSecret: p.bpiClientSecret });
      slog('info', `OAuth session established (${sessionId}) for tenant "${p.displayName}" scope="${r.data.scope}" expires_in=${r.data.expires_in}s`);
      return { sessionId, scope: r.data.scope, expires_in: r.data.expires_in, token_type: r.data.token_type };
    }

    // ── 4. LIST ACCOUNTS ─────────────────────────────────────────────────────
    // From here on, every call carries the sessionId; requireSession() attaches
    // the right customer token + tenant credentials automatically.
    case 'bpi_list_transactional_accounts': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('GET', '/bpi/api/accounts/transactionalAccounts', { bearer: s.access_token, creds: s });
      if (!r.ok) throw new Error(r.data.description || 'account retrieval failed');
      return r.data.body;
    }

    // ── 5. INITIATE TOP-UP ───────────────────────────────────────────────────
    // Start moving `amount` from the chosen account. Returns a transactionId
    // that ties together the remaining steps, plus the masked mobile number.
    case 'bpi_fundtopup_initiate': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/initiate', {
        bearer: s.access_token, creds: s,
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

    // ── 6. SEND TRANSACTION OTP ─────────────────────────────────────────────
    // Ask BPI to SMS the customer a one-time code to approve this specific move.
    case 'bpi_fundtopup_send_otp': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/otp', {
        bearer: s.access_token, creds: s, transactionId: args.transactionId,
        json: { mobileNumberToken: args.mobileNumberToken },
      });
      if (!r.ok) throw new Error(r.data.description || 'otp request failed');
      return r.data.body;
    }

    // ── 7. PROCESS (CONFIRM) TOP-UP ─────────────────────────────────────────
    // Submit the OTP the customer entered to finalize the transfer. Success
    // returns the confirmation number — the "receipt".
    case 'bpi_fundtopup_process': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('POST', '/bpi/api/fundTopUp/process', {
        bearer: s.access_token, creds: s, transactionId: args.transactionId,
        json: { otp: args.otp },
      });
      if (!r.ok) throw new Error(r.data.description || 'process failed');
      return r.data.body;
    }

    // ── 8. STATUS (RECONCILIATION) ───────────────────────────────────────────
    // Look up whether a transaction posted — useful if a reply was ever missed.
    case 'bpi_fundtopup_status': {
      const s = requireSession(args.sessionId);
      const r = await bpiFetch('GET', '/bpi/api/fundTopUp/status', { bearer: s.access_token, creds: s, transactionId: args.transactionId });
      if (!r.ok) throw new Error(r.data.description || 'status failed');
      return r.data.body;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
// Mask/shorten sensitive values before they are logged to the terminal panel,
// so secrets and OTPs never appear in the demo logs.
function summarizeArgs(args) {
  const a = { ...args };
  if (a.code) a.code = a.code.slice(0, 10) + '…';
  if (a.accountNumberToken) a.accountNumberToken = a.accountNumberToken.slice(0, 10) + '…';
  if (a.clientSecret) a.clientSecret = '••••••••';
  if (a.partnerToken) a.partnerToken = a.partnerToken.slice(0, 10) + '…';
  if (a.otp) a.otp = '••••••';
  return a;
}

function shorten(v) { const s = String(v ?? ''); return s.length > 14 ? s.slice(0, 10) + '…' : s; }

// Compare two secrets in constant time so an attacker cannot learn the correct
// value by measuring how fast a wrong guess is rejected.
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
// Connect the server to the stdio transport and start listening. From this
// point the parent process (the MCP client) can call tools/list and tools/call.
const transport = new StdioServerTransport();
await server.connect(transport);
slog('info', `BPI MCP Server connected over stdio. Upstream API: ${BPI_API_URL}`);
