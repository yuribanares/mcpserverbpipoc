// mock-bank.js — runs the PoC's mock BPI Open Banking API on its own.
//
// Demo only. This is what runs on Amazon Lightsail so that, in MCP_MODE=aws,
// both the customer's login screens (demo UI) and the AWS-hosted MCP server
// talk to the SAME bank — just like the real BPI is one public website.
//
// It reuses server/bpi-api.js unchanged: same accounts, same OTP rules, same
// responses. In production you delete this and point BPI_API_URL at the real
// BPI API instead.
//
// Settings (environment variables):
//   PORT                 port to listen on (Lightsail deployment uses 8080)
//   BPI_API_LATENCY_MS   demo slow-down per request (default 280)
//   DEMO_ECHO_LOGS=true  attach this bank's terminal lines to each response so
//                        the demo UI can show them (set by the deploy script)
import { startBpiApi } from '../../../server/bpi-api.js';
import { onLog } from '../../../server/logbus.js';

// Print every bank log line as one JSON line → visible in Lightsail's "Logs" tab.
onLog((rec) => console.log(JSON.stringify({ ts: rec.ts, source: 'bpi-mock-bank', level: rec.level, text: rec.text })));

const port = Number(process.env.PORT || 8080);
await startBpiApi(port);
console.log(JSON.stringify({ ts: new Date().toISOString(), source: 'bpi-mock-bank', level: 'info', text: `Mock bank ready on port ${port} (health check: /health, demo log echo: ${process.env.DEMO_ECHO_LOGS === 'true'})` }));
