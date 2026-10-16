// http-server.js — the BPI MCP Server, served over HTTPS for AgentCore Runtime.
//
// This is the "entry point" AgentCore starts. It does NOT contain any tool
// logic — it reuses createBpiMcpServer() from server/bpi-mcp-server.js, the
// exact same code the local PoC runs. Only the "plug" is different:
//
//   Local PoC : MCP over stdio  (a child process on your machine)
//   AgentCore : MCP over HTTP   (POST /mcp on 0.0.0.0:8000 — AgentCore's contract)
//
// AgentCore rules this file follows:
//   • listen on 0.0.0.0, port 8000, path /mcp
//   • "stateless" MCP — no session ids of our own. AgentCore adds an
//     Mcp-Session-Id header and routes every request of one conversation to
//     the same isolated copy of this server, so in-memory demo sessions work.
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBpiMcpServer } from '../../../server/bpi-mcp-server.js';
import { loadSettings, describeSettings } from './settings.js';
import { createPartnerRegistry, jwtClientToPartner } from './partner-registry.js';
import { createSessionStore } from './session-store.js';
import { createCallerIdentity } from './caller-identity.js';

// One JSON line per event on stdout → collected by Amazon CloudWatch Logs.
// (Values are already masked by the MCP server before they get here.)
const log = (rec) => console.log(JSON.stringify({ ts: new Date().toISOString(), source: 'bpi-mcp-server', ...rec }));

let settings;
try { settings = loadSettings(); }
catch (err) { log({ level: 'err', text: err.message }); process.exit(1); }

const registry = await createPartnerRegistry(settings, log);
const store = await createSessionStore(settings, log);
const identity = createCallerIdentity(settings, log);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Simple health check (handy for local testing; harmless on AgentCore).
app.get('/ping', (_req, res) => res.json({ status: 'Healthy' }));

// Every MCP message (initialize, tools/list, tools/call…) arrives here.
app.post('/mcp', async (req, res) => {
  // In jwt mode, find out which partner this verified token belongs to.
  const jwtPartnerId = await identity.partnerFromRequest(req, jwtClientToPartner(settings, registry.current()));

  // Stateless pattern: a fresh MCP server object + transport per request. The
  // tool logic and the session store are shared, so nothing is lost.
  const server = createBpiMcpServer({
    bpiApiUrl: settings.bpiApiUrl,
    registry: registry.current(),
    store,
    logSink: log,
    echoLogs: settings.echoLogs,
    partnerAuthMode: settings.partnerAuthMode,
    jwtPartnerId,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log({ level: 'err', text: `MCP request failed: ${err.message}` });
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

// Stateless servers don't offer the optional GET (server-push) or DELETE
// (end-session) calls; MCP clients handle this "405" reply gracefully.
const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST')
  .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

const listener = app.listen(settings.port, '0.0.0.0', () => {
  log({ level: 'info', text: `BPI MCP Server listening on http://0.0.0.0:${settings.port}/mcp — ${describeSettings(settings)}` });
});
process.on('SIGTERM', () => listener.close(() => process.exit(0)));
