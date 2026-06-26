// bpi-api.js — Mock BPI Open Banking "Partner API 2.0" (Fund Top-Up journey).
//
// Implements just enough of API Contract v2.1.6 to drive the proof of concept:
//   3-Legged OAuth : GET /authorize, POST /oauth2/login, POST /oauth2/login/otp, POST /oauth2/token
//   Accounts       : GET /bpi/api/accounts/transactionalAccounts
//   Fund Top-Up    : POST /bpi/api/fundTopUp/{initiate,otp,process}, GET /bpi/api/fundTopUp/status
//
// Every request/response is mirrored to the "BPI Open Banking API Server
// Terminal" via the shared log bus. Sensitive values are tokenized/masked the
// same way the real contract describes.
import express from 'express';
import crypto from 'node:crypto';
import { log, CHANNELS } from './logbus.js';

const C = CHANNELS.BPI_API;

// --- Demo data -------------------------------------------------------------
// Three transactional accounts, mirroring the sample account-selection screen.
const ACCOUNTS = [
  { accountPreferredName: 'Hobbies Account', accountNumber: 'XXXXXX9359', accountType: 'SAVINGS', displayOrder: '001' },
  { accountPreferredName: 'Payroll',         accountNumber: 'XXXXXX0337', accountType: 'SAVINGS', displayOrder: '002' },
  { accountPreferredName: 'Yuna ATM 2016',   accountNumber: 'XXXXXX6899', accountType: 'CHECKING ACCOUNT', displayOrder: '003' },
].map((a) => ({
  ...a,
  institution: 'BPI',
  accountNumberToken: crypto.createHash('sha256').update(a.accountNumber + a.accountPreferredName).digest('hex').slice(0, 64),
}));

const MASKED_MOBILE = '+63917****757';

// --- In-memory state -------------------------------------------------------
const loginSessions = new Map(); // loginTxnId -> { username, scope, state }
const authCodes = new Map();     // code -> { scope, usedAt }
const accessTokens = new Map();  // access_token -> { scope, consentedOn }
const txns = new Map();          // transactionId -> { ...details, status }

const tok = (n = 32) => crypto.randomBytes(n).toString('hex').slice(0, n * 2);
const oauthBlob = () => 'AA' + crypto.randomBytes(90).toString('base64url');

function nowGmt8(addMinutes = 0) {
  // Render "Fri Jun 26 2026 14:25:43 GMT+0800 (DST)" style timestamps.
  const d = new Date(Date.now() + addMinutes * 60000 + 8 * 3600000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0800 (DST)`;
}

export function getDemoAccounts() {
  return ACCOUNTS.map(({ accountNumberToken, ...rest }) => ({ ...rest, accountNumberToken }));
}

export function startBpiApi(port = 4000) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Log each request as it arrives and capture the JSON response body.
  // Simulated network/processing latency so the request and its response land
  // a beat apart in the terminal — makes the cascade watchable during a demo.
  const LATENCY = Number(process.env.BPI_API_LATENCY_MS ?? 280);
  app.use(async (req, res, next) => {
    const tag = `${req.method} ${req.path}`;
    log(C, { level: 'req', dir: '<-', text: tag, data: redact({ ...req.query, ...req.body }) });
    const orig = res.json.bind(res);
    res.json = (body) => {
      log(C, { level: res.statusCode >= 400 ? 'err' : 'res', dir: '->', text: `${res.statusCode} ${tag}`, data: redact(body) });
      return orig(body);
    };
    if (LATENCY > 0) await new Promise((r) => setTimeout(r, LATENCY));
    next();
  });

  // === 3-Legged OAuth ======================================================

  // [GET] /bpi/api/oauth2/authorize — yields the BPI login page (front-channel).
  app.get('/bpi/api/oauth2/authorize', (req, res) => {
    const { client_id, response_type, scope, redirect_uri, state } = req.query;
    if (!client_id || response_type !== 'code') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    log(C, { level: 'info', text: `Serving BPI login page for client_id=${shorten(client_id)} scope="${scope}"` });
    res.json({ page: 'login', client_id, scope, redirect_uri, state });
  });

  // [POST] /bpi/api/oauth2/login — user submits BPI Online Banking credentials.
  app.post('/bpi/api/oauth2/login', (req, res) => {
    const { username, password, scope = '', state } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'invalid_credentials' });
    const loginTxnId = crypto.randomUUID();
    loginSessions.set(loginTxnId, { username, scope, state });
    log(C, { level: 'info', text: `Credentials accepted for "${username}". Dispatching OTP to ${MASKED_MOBILE}.` });
    res.json({ page: 'otp', loginTxnId, mobileNumber: MASKED_MOBILE });
  });

  // [POST] /bpi/api/oauth2/login/otp — user submits the login OTP; issues code.
  app.post('/bpi/api/oauth2/login/otp', (req, res) => {
    const { loginTxnId, otp } = req.body;
    const session = loginSessions.get(loginTxnId);
    if (!session) return res.status(400).json({ error: 'invalid_request' });
    if (!/^\d{6}$/.test(String(otp || ''))) return res.status(400).json({ error: 'invalid_otp' });
    const code = oauthBlob();
    authCodes.set(code, { scope: session.scope, usedAt: null });
    loginSessions.delete(loginTxnId);
    log(C, { level: 'ok', text: `Login OTP verified. Redirecting to partner with authorization code.` });
    res.json({ redirect: `${'https://partner.example/callback'}?code=${code}&state=${session.state || ''}`, code });
  });

  // [POST] /bpi/api/oauth2/token — back-channel code→token exchange (via MCP).
  app.post('/bpi/api/oauth2/token', (req, res) => {
    const { grant_type, code, client_id, client_secret } = req.body;
    if (!client_id || !client_secret) return res.status(401).json({ error: 'invalid_client' });
    if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unknown' });
    const entry = authCodes.get(code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant' });
    if (entry.usedAt) return res.status(400).json({ error: 'invalid_grant' }); // re-use
    entry.usedAt = Date.now();
    const access_token = oauthBlob();
    accessTokens.set(access_token, { scope: entry.scope, consentedOn: Math.floor(Date.now() / 1000) });
    res.json({
      token_type: 'bearer',
      access_token,
      expires_in: 1800,
      scope: entry.scope || 'transactionalAccountsForBillsPay fundTopUp',
      refresh_token: oauthBlob(),
      refresh_token_expires_in: 2592000,
      consented_on: Math.floor(Date.now() / 1000),
    });
  });

  // === Accounts ============================================================
  app.get('/bpi/api/accounts/transactionalAccounts', (req, res) => {
    if (!requireBearer(req, res)) return;
    res.json({
      status: 'success',
      code: '0',
      description: 'Success',
      body: { transactionalAccounts: ACCOUNTS },
    });
  });

  // === Standard Fund Top-Up ================================================
  app.post('/bpi/api/fundTopUp/initiate', (req, res) => {
    if (!requireBearer(req, res)) return;
    const { merchantTransactionReference, accountNumberToken, amount, remarks } = req.body;
    if (!accountNumberToken || !amount) {
      return res.status(400).json({ status: 'error', code: 'FTUBE001', description: 'Invalid request parameters' });
    }
    const transactionId = crypto.randomUUID();
    const mobileNumberToken = tok(16);
    txns.set(transactionId, {
      merchantTransactionReference, accountNumberToken, amount, remarks,
      mobileNumberToken, otpSent: false, status: 'INCOMPLETE',
    });
    res.set('transactionId', transactionId);
    res.json({
      transactionId,
      status: 'success',
      code: '0',
      description: 'Success',
      body: { mobileNumber: MASKED_MOBILE, mobileNumberToken },
    });
  });

  app.post('/bpi/api/fundTopUp/otp', (req, res) => {
    if (!requireBearer(req, res)) return;
    const transactionId = req.get('transactionId') || req.body.transactionId;
    const t = txns.get(transactionId);
    if (!t) return res.status(400).json({ status: 'error', code: 'FTUBE001', description: 'Unknown transaction' });
    t.otpSent = true;
    res.json({
      status: 'success', code: '0', description: 'Success',
      body: { otpValidUntil: nowGmt8(5) },
    });
  });

  app.post('/bpi/api/fundTopUp/process', (req, res) => {
    if (!requireBearer(req, res)) return;
    const transactionId = req.get('transactionId') || req.body.transactionId;
    const t = txns.get(transactionId);
    if (!t) return res.status(400).json({ status: 'error', code: 'FTUBE001', description: 'Unknown transaction' });
    if (!/^\d{6}$/.test(String(req.body.otp || ''))) {
      return res.status(400).json({ status: 'error', code: 'FTUBE002', description: 'Invalid OTP' });
    }
    t.status = 'SUCCESSFUL';
    t.confirmationNumber = String(Date.now());
    t.confirmationTimestamp = nowGmt8(0);
    res.json({
      status: 'success', code: '0', description: 'Success',
      body: { confirmationNumber: t.confirmationNumber, confirmationTimestamp: t.confirmationTimestamp },
    });
  });

  app.get('/bpi/api/fundTopUp/status', (req, res) => {
    if (!requireBearer(req, res)) return;
    const transactionId = req.get('transactionId') || req.query.transactionId;
    const t = txns.get(transactionId);
    if (!t) return res.status(400).json({ status: 'error', code: 'FTUBE001', description: 'Unknown transaction' });
    res.json({
      status: 'success', code: '0', description: 'Success',
      body: {
        confirmationNumber: t.confirmationNumber || null,
        confirmationTimestamp: t.confirmationTimestamp || null,
        merchantTransactionReference: t.merchantTransactionReference,
        transactionStatus: t.status,
      },
    });
  });

  function requireBearer(req, res) {
    const auth = req.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || !accessTokens.has(token)) {
      res.status(401).json({ httpCode: '401', httpMessage: 'Unauthorized', moreInformation: 'This server could not verify that you are authorized to access the URL' });
      return false;
    }
    return true;
  }

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      log(C, { level: 'info', text: `BPI Open Banking API listening on http://localhost:${port}` });
      resolve(server);
    });
  });
}

// --- helpers ---------------------------------------------------------------
function shorten(v) {
  const s = String(v ?? '');
  return s.length > 12 ? s.slice(0, 8) + '…' : s;
}
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(clone)) {
    if (/secret|password/i.test(k)) clone[k] = '••••••••';
    else if (typeof clone[k] === 'string' && clone[k].length > 48) clone[k] = clone[k].slice(0, 24) + '…(' + clone[k].length + ')';
  }
  return clone;
}
