// unit-tests.js — offline checks for the production-only pieces (no AWS needed).
//   node src/unit-tests.js
// Covers: settings validation, the DynamoDB session store (with a fake
// database), and "jwt" partner identification (with locally signed tokens).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadSettings } from './settings.js';
import { createDynamoStore } from './session-store.js';
import { createCallerIdentity } from './caller-identity.js';
import { jwtClientToPartner } from './partner-registry.js';
import { createBpiMcpServer, DEMO_PARTNER_REGISTRY } from '../../../server/bpi-mcp-server.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

console.log('\nUnit tests (offline)\n');

// ── Settings ────────────────────────────────────────────────────────────────
await test('settings: defaults reproduce the demo', () => {
  const s = loadSettings({});
  assert.equal(s.port, 8000); assert.equal(s.region, 'ap-southeast-1');
  assert.equal(s.registrySource, 'builtin'); assert.equal(s.partnerAuthMode, 'tool');
  assert.equal(s.sessionStore, 'memory'); assert.equal(s.echoLogs, false);
});
await test('settings: clear errors for incomplete production settings', () => {
  assert.throws(() => loadSettings({ PARTNER_REGISTRY_SOURCE: 'secretsmanager', SESSION_STORE: 'dynamodb', PARTNER_AUTH_MODE: 'jwt' }), (e) => {
    assert.match(e.message, /PARTNER_REGISTRY_SECRET_ID is required/);
    assert.match(e.message, /SESSION_TABLE_NAME is required/);
    assert.match(e.message, /COGNITO_USER_POOL_ID is required/);
    return true;
  });
  assert.throws(() => loadSettings({ BPI_MESSAGE_SIGNING: 'on' }), /not built yet/);
  assert.throws(() => loadSettings({ PARTNER_JWT_CLIENT_MAP: '{oops' }), /valid JSON/);
});

// ── DynamoDB session store ──────────────────────────────────────────────────
class GetItemCommand { constructor(input) { this.input = input; this.kind = 'get'; } }
class PutItemCommand { constructor(input) { this.input = input; this.kind = 'put'; } }
function fakeDb() {
  const items = new Map(); const calls = [];
  return { items, calls, async send(cmd) {
    calls.push(cmd);
    if (cmd.kind === 'put') { items.set(cmd.input.Item.pk.S, cmd.input.Item); return {}; }
    return { Item: items.get(cmd.input.Key.pk.S) };
  } };
}
await test('dynamodb store: saves and reads back a session with its expiry', async () => {
  const db = fakeDb(); let now = 1_800_000_000_000;
  const store = createDynamoStore({ db, TableName: 't', GetItemCommand, PutItemCommand, now: () => now });
  await store.set('session', 'sess_1', { access_token: 'tok', partnerId: 'dragonpay' }, 1800);
  const item = db.items.get('session#sess_1');
  assert.equal(item.expiresAt.N, String(1_800_000_000 + 1800));
  assert.deepEqual(await store.get('session', 'sess_1'), { access_token: 'tok', partnerId: 'dragonpay' });
  assert.equal(db.calls[1].input.ConsistentRead, true);
  now += 1801 * 1000; // past expiry, but DynamoDB hasn't deleted it yet
  assert.equal(await store.get('session', 'sess_1'), undefined);
  assert.equal(await store.get('session', ''), undefined);
});
await test('dynamodb store: the full MCP journey works on top of it', async () => {
  const db = fakeDb();
  const store = createDynamoStore({ db, TableName: 't', GetItemCommand, PutItemCommand });
  const server = createBpiMcpServer({ store, logSink: () => {} });
  const call = server._requestHandlers.get('tools/call');
  const run = async (name, args) => JSON.parse((await call({ method: 'tools/call', params: { name, arguments: args } }, {})).content[0].text);
  const auth = await run('bpi_partner_authenticate', { clientId: 'mcp_dragonpay_7f3a91', clientSecret: 'mcps_dragonpay_4b9c2e7f10a8d6' });
  assert.equal(auth.partner, 'DRAGONPAY CORP');
  const stored = JSON.parse(db.items.get(`partner#${auth.partnerToken}`).value.S);
  assert.deepEqual(stored, { partnerId: 'dragonpay' }, 'only the partner id is stored — never the BPI secret');
  const authz = await run('bpi_begin_authorization', { partnerToken: auth.partnerToken });
  assert.match(authz.authorizeUrl, /client_id=a3f7832f/);
});

// ── jwt partner identification ──────────────────────────────────────────────
const POOL = 'ap-southeast-1_TestPool1';
const ISS = `https://cognito-idp.ap-southeast-1.amazonaws.com/${POOL}`;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, key = privateKey) {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64({ iss: ISS, token_use: 'access', exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const settingsJwt = loadSettings({ PARTNER_AUTH_MODE: 'jwt', COGNITO_USER_POOL_ID: POOL, PARTNER_JWT_CLIENT_MAP: '{"client-dragon":"dragonpay"}' });
const identity = createCallerIdentity(settingsJwt, () => {});
identity.verifier.cacheJwks({ keys: [jwk] });
const map = jwtClientToPartner(settingsJwt, DEMO_PARTNER_REGISTRY);
const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

await test('jwt: a valid token for a mapped client → that partner', async () => {
  assert.equal(await identity.partnerFromRequest(req(sign({ client_id: 'client-dragon' })), map), 'dragonpay');
});
await test('jwt: unknown client, forged signature, expired or missing token → no partner', async () => {
  assert.equal(await identity.partnerFromRequest(req(sign({ client_id: 'someone-else' })), map), null);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(await identity.partnerFromRequest(req(sign({ client_id: 'client-dragon' }, other)), map), null);
  assert.equal(await identity.partnerFromRequest(req(sign({ client_id: 'client-dragon', exp: 1 })), map), null);
  assert.equal(await identity.partnerFromRequest(req(null), map), null);
});
await test('jwt mode: partner_authenticate uses the verified partner and rejects mismatches', async () => {
  const mk = (jwtPartnerId) => {
    const call = createBpiMcpServer({ partnerAuthMode: 'jwt', jwtPartnerId, logSink: () => {} })._requestHandlers.get('tools/call');
    return async (args) => (await call({ method: 'tools/call', params: { name: 'bpi_partner_authenticate', arguments: args } }, {}));
  };
  const ok = JSON.parse((await mk('dragonpay')({})).content[0].text);
  assert.equal(ok.partner, 'DRAGONPAY CORP');
  const mismatch = await mk('dragonpay')({ clientId: 'mcp_juanpay_2c5d80' });
  assert.equal(mismatch.isError, true);
  const none = await mk(null)({});
  assert.match(none.content[0].text, /partner_token_missing/);
});

console.log(`\n  🎉 ${passed} unit tests passed\n`);
