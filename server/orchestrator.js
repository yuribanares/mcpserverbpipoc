// orchestrator.js — The partner-app host process.
//
// Responsibilities:
//   • Serve the four-panel web UI and a WebSocket for live updates.
//   • Boot the mock BPI Open Banking API (in-process, :4000).
//   • Act as the MCP CLIENT: spawn the BPI MCP Server over stdio and call its tools.
//   • Run the agentic loop (Gemini, or an offline scripted planner) for the
//     A.I Chat Center, including human-in-the-loop BPI screens (login, OTP,
//     account selection, transaction OTP).
//   • Stream every component's activity to the matching terminal panel.
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { log, onLog, CHANNELS } from './logbus.js';
import { startBpiApi } from './bpi-api.js';
import { SYSTEM_PROMPT, TOOL_DECLARATIONS } from './agent-tools.js';
import { createGeminiLLM } from './gemini.js';
import { createMockLLM } from './mock-llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_PORT = Number(process.env.PORT || 3000);
const BPI_PORT = Number(process.env.BPI_API_PORT || 4000);
const BPI_API_URL = `http://localhost:${BPI_PORT}`;
const PARTNER = process.env.PARTNER_NAME || 'DRAGONPAY CORP';
// The partner app's MCP-layer credentials used to authenticate to BPI's MCP
// server (NOT BPI Open Banking credentials — those live in BPI's vault).
const PARTNER_MCP_CLIENT_ID = process.env.PARTNER_MCP_CLIENT_ID || 'mcp_dragonpay_7f3a91';
const PARTNER_MCP_CLIENT_SECRET = process.env.PARTNER_MCP_CLIENT_SECRET || 'mcps_dragonpay_4b9c2e7f10a8d6';

// ── LLM selection ──────────────────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// The offline scripted planner is always available as a fallback so a quota or
// network problem with Gemini never dead-ends a live demo.
const mockLlm = createMockLLM();
const llm = GEMINI_KEY
  ? createGeminiLLM({ apiKey: GEMINI_KEY, model: GEMINI_MODEL, tools: TOOL_DECLARATIONS, system: SYSTEM_PROMPT })
  : mockLlm;

// ── MCP client (talks to the BPI MCP Server child process) ──────────────────
let mcp; // MCP SDK Client

async function startMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'bpi-mcp-server.js')],
    env: { ...process.env, BPI_API_URL },
    stderr: 'pipe',
  });

  // Forward the MCP server's stderr log lines to its terminal panel.
  if (transport.stderr) {
    readline.createInterface({ input: transport.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        if (o.__mcplog) return void log(CHANNELS.MCP_SERVER, { level: o.level, text: o.text, data: o.data, ms: o.ms });
      } catch { /* not JSON */ }
      log(CHANNELS.MCP_SERVER, { level: 'info', text: line });
    });
  }

  mcp = new Client({ name: 'dragonpay-mcp-client', version: '1.0.0' }, { capabilities: {} });
  log(CHANNELS.MCP_CLIENT, { level: 'info', text: `Spawning BPI MCP Server (stdio) → ${process.execPath} bpi-mcp-server.js` });
  await mcp.connect(transport);
  log(CHANNELS.MCP_CLIENT, { level: 'ok', text: 'MCP session initialized (protocol handshake complete)' });
  const { tools } = await mcp.listTools();
  log(CHANNELS.MCP_CLIENT, { level: 'info', dir: '->', text: 'tools/list', data: tools.map((t) => t.name) });
}

// Demo pacing: a short beat so each MCP → server → API hop visibly cascades
// across the terminals instead of firing all at once. Set PACE_MS=0 to disable.
const PACE_MS = Number(process.env.PACE_MS ?? 350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = () => (PACE_MS > 0 ? sleep(PACE_MS) : Promise.resolve());

// One MCP tool call, with both sides narrated on the MCP Client terminal and
// mirrored as arrows on the live sequence diagram.
async function mcpCall(ws, name, args, { apiHop = true } = {}) {
  await pace();
  const t0 = Date.now();
  log(CHANNELS.MCP_CLIENT, { level: 'req', dir: '->', text: `tools/call ${name}`, data: redactArgs(args) });
  flow(ws, 'CLIENT', 'SERVER', `tools/call ${name}`);
  const res = await mcp.callTool({ name, arguments: args });
  const payload = JSON.parse(res.content?.[0]?.text || '{}');
  const ms = Date.now() - t0;
  // Most BPI MCP tools map 1:1 to one upstream Open Banking API call; a few
  // (e.g. bpi_begin_authorization) only build/return data and hit no API.
  if (apiHop) {
    flow(ws, 'SERVER', 'API', name);
    flow(ws, 'API', 'SERVER', res.isError ? 'error' : '200 OK');
  }
  if (res.isError) {
    log(CHANNELS.MCP_CLIENT, { level: 'err', dir: '<-', text: `tools/call ${name} error`, data: payload, ms });
    flow(ws, 'SERVER', 'CLIENT', 'error');
    throw new Error(payload.error || `${name} failed`);
  }
  log(CHANNELS.MCP_CLIENT, { level: 'res', dir: '<-', text: `tools/call ${name} result`, data: payload, ms });
  flow(ws, 'SERVER', 'CLIENT', `${name} result`);
  return payload;
}

// ── Express + WebSocket ─────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: llm.name }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Fan every log record out to all connected browsers.
onLog((record) => broadcast({ type: 'log', record }));

const clients = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // Per-connection conversation + BPI flow state.
  ws.state = freshState();
  ws.pending = new Map(); // promptId -> resolve fn for human-in-the-loop screens
  ws.fellBack = false; // switched from Gemini to the offline planner this session?
  send(ws, { type: 'hello', partner: PARTNER, llm: llm.name, usingGemini: !!GEMINI_KEY });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleClientMessage(ws, msg).catch((err) => {
      send(ws, { type: 'chat', role: 'system', text: `⚠️ ${err.message}` });
      send(ws, { type: 'busy', value: false });
    });
  });
  ws.on('close', () => clients.delete(ws));
});

function send(ws, msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

// Live sequence-diagram arrow between two lifelines (You/LLM/CLIENT/SERVER/API).
function flow(ws, from, to, label) { send(ws, { type: 'flow', from, to, label }); }
// Journey stepper update. key: connect|verify|choose|confirm|done ; state: active|done.
function step(ws, key, state) { send(ws, { type: 'step', key, state }); }
function markConnectedSteps(ws) { step(ws, 'connect', 'done'); step(ws, 'verify', 'done'); }

function freshState() {
  return { contents: [], partnerToken: null, sessionId: null, selectedAccount: null, transactionId: null, connected: false };
}

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'chat':
      await onUserChat(ws, String(msg.text || '').trim());
      break;
    case 'ui-response': {
      const resolver = ws.pending.get(msg.promptId);
      if (resolver) { ws.pending.delete(msg.promptId); resolver(msg.data || {}); }
      break;
    }
    case 'reset':
      ws.state = freshState();
      ws.fellBack = false; // give Gemini another try on a fresh conversation
      send(ws, { type: 'reset-ok' });
      break;
  }
}

// Ask the chat UI to show a BPI screen and wait for the customer's input.
function askUI(ws, screen, payload = {}) {
  const promptId = crypto.randomUUID();
  return new Promise((resolve) => {
    ws.pending.set(promptId, resolve);
    send(ws, { type: 'ui', screen, promptId, payload });
  });
}

// ── The agent loop ──────────────────────────────────────────────────────────
async function onUserChat(ws, text) {
  if (!text) return;
  send(ws, { type: 'chat', role: 'user', text });
  log(CHANNELS.CHAT, { level: 'llm', text: `User → LLM: "${text}"` });
  send(ws, { type: 'steps-reset' });
  flow(ws, 'YOU', 'LLM', 'prompt');
  ws.state.contents.push({ role: 'user', parts: [{ text }] });
  send(ws, { type: 'busy', value: true });

  try {
    for (let turn = 0; turn < 10; turn++) {
      send(ws, { type: 'status', text: `${shortLlm()} is thinking…` });

      const engine = ws.fellBack ? mockLlm : llm;
      let reply, calls;
      try {
        ({ text: reply, calls } = await engine.next(ws.state.contents));
      } catch (err) {
        log(CHANNELS.CHAT, { level: 'err', text: `LLM error: ${err.message}` });
        // If the real model failed and a fallback exists, switch to the offline
        // scripted planner and keep going so the demo still completes.
        if (GEMINI_KEY && !ws.fellBack) {
          ws.fellBack = true;
          send(ws, { type: 'chat', role: 'system', text: llmErrorHint(err) });
          send(ws, { type: 'chat', role: 'system', text: '↪︎ Continuing with the offline scripted planner so the demo can proceed. Fix the key/model/quota and start a new chat to use Gemini again.' });
          log(CHANNELS.SYSTEM, { level: 'info', text: 'Gemini unavailable — falling back to offline scripted planner for this conversation.' });
          continue; // retry this step with the fallback engine
        }
        send(ws, { type: 'chat', role: 'system', text: llmErrorHint(err) });
        break;
      }

      if (!calls || calls.length === 0) {
        if (reply) {
          ws.state.contents.push({ role: 'model', parts: [{ text: reply }] });
          flow(ws, 'LLM', 'YOU', 'reply');
          send(ws, { type: 'chat', role: 'assistant', text: reply });
          log(CHANNELS.CHAT, { level: 'llm', text: `LLM → User: "${oneline(reply)}"` });
        }
        break;
      }

      // Record the model's tool-call turn, then execute each call.
      ws.state.contents.push({ role: 'model', parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) });
      if (reply) send(ws, { type: 'chat', role: 'assistant', text: reply });

      const responseParts = [];
      for (const call of calls) {
        log(CHANNELS.CHAT, { level: 'tool', text: `LLM calls tool: ${call.name}(${JSON.stringify(call.args)})` });
        send(ws, { type: 'status', text: `Running ${call.name}…` });
        const response = await executeTool(ws, call.name, call.args);
        responseParts.push({ functionResponse: { name: call.name, response } });
      }
      ws.state.contents.push({ role: 'user', parts: responseParts });
    }
  } finally {
    send(ws, { type: 'busy', value: false });
    send(ws, { type: 'status', text: '' });
  }
}

// ── Tool implementations (LLM-facing journeys) ──────────────────────────────
// Wrap every tool call with a chat tool-chip (running → done/error + duration)
// and LLM⇄MCP-Client arrows on the sequence diagram.
async function executeTool(ws, name, args) {
  const chipId = crypto.randomUUID();
  send(ws, { type: 'toolchip', id: chipId, name, status: 'running' });
  flow(ws, 'LLM', 'CLIENT', name);
  const t0 = Date.now();
  try {
    const res = await runTool(ws, name, args);
    const status = res && res.error ? 'error' : 'done';
    send(ws, { type: 'toolchip', id: chipId, name, status, ms: Date.now() - t0 });
    flow(ws, 'CLIENT', 'LLM', status === 'error' ? 'error' : 'result');
    return res;
  } catch (err) {
    send(ws, { type: 'toolchip', id: chipId, name, status: 'error', ms: Date.now() - t0 });
    flow(ws, 'CLIENT', 'LLM', 'error');
    throw err;
  }
}

function runTool(ws, name, args) {
  switch (name) {
    case 'connect_bpi_account': return connectBpi(ws);
    case 'list_bpi_accounts':   return listAccounts(ws);
    case 'fund_topup':          return fundTopup(ws, args);
    default: return { error: `Unknown tool ${name}` };
  }
}

async function connectBpi(ws) {
  if (ws.state.connected) { markConnectedSteps(ws); return { status: 'already_connected', scope: ws.state.scope }; }
  const state = crypto.randomBytes(12).toString('hex');
  step(ws, 'connect', 'active');

  // Layer 1 — partner authentication: the partner app authenticates ITSELF to
  // BPI's (BPI-owned) MCP server with its MCP-layer credentials. BPI resolves
  // the tenant and its vaulted Open Banking secret server-side.
  if (!ws.state.partnerToken) {
    log(CHANNELS.MCP_CLIENT, { level: 'info', text: 'Authenticating partner app to BPI MCP server (OAuth2 client-credentials)…' });
    const auth = await mcpCall(ws, 'bpi_partner_authenticate',
      { clientId: PARTNER_MCP_CLIENT_ID, clientSecret: PARTNER_MCP_CLIENT_SECRET }, { apiHop: false });
    ws.state.partnerToken = auth.partnerToken;
    send(ws, { type: 'chat', role: 'system', text: `🔐 Partner authenticated to BPI MCP Server — tenant: ${auth.partner}. BPI selected this tenant's Open Banking credentials server-side.` });
  }

  // Layer 2 — customer 3-legged OAuth. The MCP server (for this tenant) owns the
  // client_id + scopes and initiates it, returning the hosted BPI /authorize URL.
  const authz = await mcpCall(ws, 'bpi_begin_authorization', { partnerToken: ws.state.partnerToken, state }, { apiHop: false });
  const scope = authz.scope;

  // Front-channel: the partner app opens that /authorize URL in a browser. The
  // customer's credentials/OTP are entered on BPI's page — the MCP server never
  // sees them.
  log(CHANNELS.MCP_CLIENT, { level: 'info', text: 'OAuth: opening BPI /authorize URL from MCP server (front-channel browser)…' });
  const u = new URL(authz.authorizeUrl);
  await bpiFront(ws, 'GET', u.pathname + u.search);

  // Screen 1: BPI login.
  const creds = await askUI(ws, 'login', { partner: PARTNER, scope });
  const login = await bpiFront(ws, 'POST', '/bpi/api/oauth2/login', { username: creds.username, password: creds.password, scope, state: authz.state });
  step(ws, 'connect', 'done');

  // Screen 2: login OTP.
  step(ws, 'verify', 'active');
  const otp = await askUI(ws, 'login-otp', { mobile: login.mobileNumber });
  const verified = await bpiFront(ws, 'POST', '/bpi/api/oauth2/login/otp', { loginTxnId: login.loginTxnId, otp: otp.otp });
  log(CHANNELS.MCP_CLIENT, { level: 'ok', text: 'OAuth: authorization code received at redirect_uri' });

  // Back-channel: exchange the code for a token *through the MCP server*, which
  // uses this tenant's vaulted client_secret.
  const tokenInfo = await mcpCall(ws, 'bpi_exchange_token', { partnerToken: ws.state.partnerToken, code: verified.code });
  ws.state.sessionId = tokenInfo.sessionId;
  ws.state.scope = tokenInfo.scope;
  ws.state.connected = true;
  step(ws, 'verify', 'done');
  send(ws, { type: 'ui', screen: 'connected', payload: { scope: tokenInfo.scope } });
  return { status: 'connected', scope: tokenInfo.scope, expires_in: tokenInfo.expires_in };
}

async function listAccounts(ws) {
  if (!ws.state.connected) return { error: 'Not connected. Call connect_bpi_account first.' };
  markConnectedSteps(ws);
  step(ws, 'choose', 'active');
  const body = await mcpCall(ws, 'bpi_list_transactional_accounts', { sessionId: ws.state.sessionId });
  const accounts = body.transactionalAccounts || [];
  // Screen 3: account selection.
  const chosen = await askUI(ws, 'accounts', {
    accounts: accounts.map((a) => ({ accountPreferredName: a.accountPreferredName, accountNumber: a.accountNumber, accountNumberToken: a.accountNumberToken })),
  });
  const sel = accounts.find((a) => a.accountNumberToken === chosen.accountNumberToken) || accounts[0];
  ws.state.selectedAccount = sel;
  step(ws, 'choose', 'done');
  log(CHANNELS.CHAT, { level: 'info', text: `Customer selected source account: ${sel.accountPreferredName} (${sel.accountNumber})` });
  return { selectedAccount: { name: sel.accountPreferredName, accountNumber: sel.accountNumber }, availableAccounts: accounts.length };
}

async function fundTopup(ws, args) {
  if (!ws.state.connected) return { error: 'Not connected. Call connect_bpi_account first.' };
  if (!ws.state.selectedAccount) return { error: 'No source account selected. Call list_bpi_accounts first.' };
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Invalid amount.' };
  const acct = ws.state.selectedAccount;
  markConnectedSteps(ws); step(ws, 'choose', 'done'); step(ws, 'confirm', 'active');

  const init = await mcpCall(ws, 'bpi_fundtopup_initiate', {
    sessionId: ws.state.sessionId,
    accountNumberToken: acct.accountNumberToken,
    amount,
    remarks: args.remarks || 'Load funds to wallet',
    merchantTransactionReference: String(Date.now()),
  });
  ws.state.transactionId = init.transactionId;

  await mcpCall(ws, 'bpi_fundtopup_send_otp', {
    sessionId: ws.state.sessionId,
    transactionId: init.transactionId,
    mobileNumberToken: init.mobileNumberToken,
  });

  // Screen 4: transaction OTP.
  const otp = await askUI(ws, 'txn-otp', { mobile: init.mobileNumber, amount, account: acct.accountPreferredName });

  const result = await mcpCall(ws, 'bpi_fundtopup_process', {
    sessionId: ws.state.sessionId,
    transactionId: init.transactionId,
    otp: otp.otp,
  });

  step(ws, 'confirm', 'done'); step(ws, 'done', 'done');
  send(ws, { type: 'ui', screen: 'receipt', payload: { amount, account: acct.accountPreferredName, accountNumber: acct.accountNumber, ...result } });
  return {
    status: 'SUCCESSFUL',
    amount,
    sourceAccount: `${acct.accountPreferredName} (${acct.accountNumber})`,
    confirmationNumber: result.confirmationNumber,
    confirmationTimestamp: result.confirmationTimestamp,
  };
}

// Direct (front-channel) call to the BPI OAuth endpoints — represents the
// customer's browser talking to BPI's hosted login, not an MCP call.
async function bpiFront(ws, method, pathName, body) {
  const shortPath = pathName.split('?')[0];
  flow(ws, 'CLIENT', 'API', `${method} ${shortPath}`);
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BPI_API_URL}${pathName}`, opts);
  const data = await res.json().catch(() => ({}));
  flow(ws, 'API', 'CLIENT', res.ok ? '200 OK' : `error ${res.status}`);
  if (!res.ok) throw new Error(data.error || `BPI ${pathName} failed (${res.status})`);
  return data;
}

// ── helpers ─────────────────────────────────────────────────────────────────
// Turn a raw Gemini/SDK error into an actionable hint shown in the chat.
function llmErrorHint(err) {
  const m = String(err?.message || err);
  if (/API key|API_KEY_INVALID|401|invalid.*key|PERMISSION_DENIED/i.test(m))
    return `⚠️ Gemini rejected the request — check GEMINI_API_KEY in your .env. (${m})`;
  if (/404|not found|NOT_FOUND|is not found|unsupported/i.test(m))
    return `⚠️ Model "${GEMINI_MODEL}" was not found for your key. Try GEMINI_MODEL=gemini-2.0-flash (or gemini-1.5-flash) in .env. (${m})`;
  if (/429|quota|RESOURCE_EXHAUSTED|rate/i.test(m))
    return `⚠️ Gemini quota/rate limit hit. Wait a moment or check your plan. (${m})`;
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network|ETIMEDOUT/i.test(m))
    return `⚠️ Could not reach the Gemini API (network). (${m})`;
  return `⚠️ LLM error: ${m}`;
}
function shortLlm() { return GEMINI_KEY ? 'Gemini' : 'Assistant'; }
function oneline(s) { return String(s).replace(/\s+/g, ' ').slice(0, 80); }
function redactArgs(args) {
  const a = { ...args };
  if (a.code) a.code = String(a.code).slice(0, 10) + '…';
  if (a.otp) a.otp = '••••••';
  if (a.clientSecret) a.clientSecret = '••••••••';
  if (a.partnerToken) a.partnerToken = String(a.partnerToken).slice(0, 10) + '…';
  if (a.accountNumberToken) a.accountNumberToken = String(a.accountNumberToken).slice(0, 10) + '…';
  return a;
}

// ── boot ────────────────────────────────────────────────────────────────────
async function main() {
  log(CHANNELS.SYSTEM, { level: 'info', text: 'Starting BPI MCP PoC…' });
  await startBpiApi(BPI_PORT);
  await startMcpClient();
  server.listen(WEB_PORT, () => {
    const banner = `\n  ┌────────────────────────────────────────────────────────┐\n` +
      `  │  BPI × MCP proof of concept                            │\n` +
      `  │  UI:        http://localhost:${WEB_PORT}                       │\n` +
      `  │  BPI API:   ${BPI_API_URL}                  │\n` +
      `  │  LLM:       ${(GEMINI_KEY ? `Gemini (${GEMINI_MODEL})` : 'offline scripted planner').padEnd(40)}│\n` +
      `  └────────────────────────────────────────────────────────┘\n`;
    console.log(banner);
    log(CHANNELS.SYSTEM, { level: 'ok', text: `Web UI ready at http://localhost:${WEB_PORT} — LLM: ${llm.name}` });
  });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
