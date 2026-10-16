// test-journey.js — run the full Fund Top-Up journey against an MCP server and
// report each step with ✅ / ❌. No browser needed.
//
// Works against the AWS deployment (scripts/06-test-on-aws.sh runs it) or a
// local copy (scripts/try-locally.sh). Settings come from environment
// variables — the same names the demo UI uses in MCP_MODE=aws:
//   AWS_REGION, AWS_AGENTCORE_RUNTIME_ARN   → the AgentCore server, or
//   AWS_MCP_URL                             → any MCP URL (e.g. http://localhost:8000/mcp)
//   AWS_BANK_URL                            → the bank the "customer" logs in to
//   AWS_COGNITO_TOKEN_URL / _CLIENT_ID / _CLIENT_SECRET / _SCOPE → partner login (optional locally)
//   PARTNER_MCP_CLIENT_ID / PARTNER_MCP_CLIENT_SECRET → demo partner (defaults to DRAGONPAY)
import { agentCoreInvokeUrl, createTokenProvider, connectRemoteMcp } from '../../../server/remote-mcp.js';

const env = process.env;
const mcpUrl = env.AWS_MCP_URL || (env.AWS_AGENTCORE_RUNTIME_ARN ? agentCoreInvokeUrl(env.AWS_REGION || 'ap-southeast-1', env.AWS_AGENTCORE_RUNTIME_ARN) : '');
const bankUrl = (env.AWS_BANK_URL || '').replace(/\/+$/, '');
const partnerId = env.PARTNER_MCP_CLIENT_ID || 'mcp_dragonpay_7f3a91';
const partnerSecret = env.PARTNER_MCP_CLIENT_SECRET || 'mcps_dragonpay_4b9c2e7f10a8d6';

let stepNo = 0;
const ok = (msg) => console.log(`  ✅ ${String(++stepNo).padStart(2)}. ${msg}`);
function fail(msg, hint) {
  console.log(`  ❌ ${String(++stepNo).padStart(2)}. ${msg}`);
  if (hint) console.log(`        → ${hint}`);
  process.exit(1);
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const data = JSON.parse(res.content?.[0]?.text || '{}');
  if (res.isError) throw new Error(`${name}: ${data.error || 'failed'}`);
  return data;
}

async function bank(method, path, body) {
  const res = await fetch(`${bankUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  delete data._demoLogs;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error || ''}`);
  return data;
}

console.log('\nBPI MCP Server — end-to-end journey test');
console.log(`  MCP server : ${mcpUrl || '(not set)'}`);
console.log(`  Bank       : ${bankUrl || '(not set)'}\n`);
if (!mcpUrl) fail('No MCP server address.', 'Set AWS_AGENTCORE_RUNTIME_ARN (AWS) or AWS_MCP_URL (local).');
if (!bankUrl) fail('No bank address.', 'Set AWS_BANK_URL to the Lightsail mock bank URL (or http://localhost:4100 locally).');

try {
  const health = await bank('GET', '/health');
  ok(`Bank is reachable (${health.service || 'ok'})`);
} catch (err) { fail(`Bank not reachable: ${err.message}`, 'Check AWS_BANK_URL and that the Lightsail service is "Running".'); }

const getToken = createTokenProvider({
  tokenUrl: env.AWS_COGNITO_TOKEN_URL, clientId: env.AWS_COGNITO_CLIENT_ID,
  clientSecret: env.AWS_COGNITO_CLIENT_SECRET, scope: env.AWS_COGNITO_SCOPE,
});
try {
  const t = await getToken();
  ok(t ? 'Partner logged in to Cognito (front-door token received)' : 'No Cognito settings — skipping partner login (fine for local tests)');
} catch (err) { fail(err.message, 'Re-run scripts/04-create-partner-logins.sh, then scripts/07-write-demo-ui-settings.sh.'); }

let client;
try {
  client = await connectRemoteMcp({ url: mcpUrl, getToken, clientName: 'journey-test' });
  const { tools } = await client.listTools();
  if (tools.length !== 8) fail(`Expected 8 tools, got ${tools.length}`);
  ok(`Connected over MCP — ${tools.length} tools advertised`);
} catch (err) {
  fail(`Could not connect to the MCP server: ${err.message}`,
    /401|403/.test(err.message) ? 'The front door rejected the token — check allowedClients on the runtime (scripts/05).' : 'Check the runtime status is READY (scripts/05) and the ARN/URL.');
}

try {
  const auth = await call(client, 'bpi_partner_authenticate', { clientId: partnerId, clientSecret: partnerSecret });
  ok(`Partner authenticated — tenant: ${auth.partner}`);

  const authz = await call(client, 'bpi_begin_authorization', { partnerToken: auth.partnerToken });
  const serverBank = new URL(authz.authorizeUrl).origin;
  if (serverBank !== new URL(bankUrl).origin) {
    fail(`The MCP server uses a different bank (${serverBank}) than this test (${new URL(bankUrl).origin}).`,
      'Both must use the same bank. Re-run scripts/05 so BPI_API_URL on the runtime is your Lightsail URL.');
  }
  ok('Customer login URL received — server and customer use the same bank');

  const u = new URL(authz.authorizeUrl);
  await bank('GET', u.pathname + u.search);
  const login = await bank('POST', '/bpi/api/oauth2/login', { username: 'juan.delacruz', password: 'demo', scope: authz.scope, state: authz.state });
  const verified = await bank('POST', '/bpi/api/oauth2/login/otp', { loginTxnId: login.loginTxnId, otp: '123456' });
  ok('Customer logged in at the bank + login OTP accepted');

  const tokenInfo = await call(client, 'bpi_exchange_token', { partnerToken: auth.partnerToken, code: verified.code });
  ok(`Login code exchanged for a session (scope: ${tokenInfo.scope})`);

  const accts = await call(client, 'bpi_list_transactional_accounts', { sessionId: tokenInfo.sessionId });
  const list = accts.transactionalAccounts || [];
  ok(`Accounts: ${list.map((a) => `${a.accountPreferredName} (${a.accountNumber})`).join(', ')}`);

  const payroll = list.find((a) => a.accountPreferredName === 'Payroll') || list[0];
  const init = await call(client, 'bpi_fundtopup_initiate', { sessionId: tokenInfo.sessionId, accountNumberToken: payroll.accountNumberToken, amount: 1, remarks: 'Journey test' });
  await call(client, 'bpi_fundtopup_send_otp', { sessionId: tokenInfo.sessionId, transactionId: init.transactionId, mobileNumberToken: init.mobileNumberToken });
  const done = await call(client, 'bpi_fundtopup_process', { sessionId: tokenInfo.sessionId, transactionId: init.transactionId, otp: '654321' });
  ok(`Top-up of ₱1 from ${payroll.accountPreferredName} confirmed — confirmation no. ${done.confirmationNumber}`);

  const status = await call(client, 'bpi_fundtopup_status', { sessionId: tokenInfo.sessionId, transactionId: init.transactionId });
  if (status.transactionStatus !== 'SUCCESSFUL') fail(`Status is ${status.transactionStatus}, expected SUCCESSFUL`);
  ok('Transaction status: SUCCESSFUL');
} catch (err) {
  fail(err.message, /expired sessionId|not authenticated/.test(err.message)
    ? 'The server lost its memory between calls. If SESSION_STORE=memory, make sure requests share one session (the SDK does this automatically).'
    : 'See docs/6-troubleshooting.md');
}

await client.close().catch(() => {});
console.log('\n  🎉 All steps passed — the BPI MCP Server works end to end.\n');
process.exit(0);
