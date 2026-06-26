// app.js — Front-end for the BPI × MCP proof of concept.
// Renders the A.I Chat Center (with simulated BPI screens) and the three live
// CLI terminals, all driven over a single WebSocket from the orchestrator.

const $ = (sel) => document.querySelector(sel);
const chatEl = $('#chat');
const statusLine = $('#status-line');
const termEls = {
  'mcp-client': $('#term-mcp-client'),
  'mcp-server': $('#term-mcp-server'),
  'bpi-api': $('#term-bpi-api'),
};
let ws, busy = false;

// ── WebSocket ────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function setConn(on) {
  const b = $('#conn-badge');
  b.textContent = on ? 'live' : 'reconnecting…';
  b.classList.toggle('online', on);
}
function sendWs(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      $('#llm-badge').textContent = `LLM: ${msg.llm}`;
      if (!msg.usingGemini) systemBubble('Running with the offline scripted planner — add a GEMINI_API_KEY in .env to use the real Gemini model.');
      break;
    case 'log': renderLog(msg.record); break;
    case 'chat': bubble(msg.role, msg.text); break;
    case 'status': statusLine.textContent = msg.text || ''; break;
    case 'busy': setBusy(msg.value); break;
    case 'ui': renderScreen(msg); break;
    case 'reset-ok': chatEl.innerHTML = ''; greet(); break;
  }
}

// ── Chat rendering ───────────────────────────────────────
function bubble(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const who = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : '';
  const head = who ? `<span class="who">${who}</span>` : '';
  chatEl.appendChild(el);
  // Typewriter reveal for assistant replies; instant for user/system.
  if (role === 'assistant' && text.length <= 600) {
    el.innerHTML = head + '<span class="typed"></span>';
    typewrite(el.querySelector('.typed'), text);
  } else {
    el.innerHTML = head + escapeHtml(text);
    scrollChat();
  }
}
function typewrite(target, text) {
  let i = 0;
  const step = Math.max(1, Math.round(text.length / 90)); // finish in ~90 ticks max
  const tick = () => {
    i = Math.min(text.length, i + step);
    target.textContent = text.slice(0, i);
    scrollChat();
    if (i < text.length) setTimeout(tick, 16);
  };
  tick();
}
const systemBubble = (t) => bubble('system', t);

function setBusy(v) {
  busy = v;
  $('#send-btn').disabled = v;
  $('#chat-text').disabled = v;
  if (!v) statusLine.textContent = '';
}
function scrollChat() { chatEl.scrollTop = chatEl.scrollHeight; }

// ── Terminal rendering ───────────────────────────────────
function renderLog(r) {
  const term = termEls[r.channel];
  if (!term) return;
  const empty = term.querySelector('.term-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = `line lvl-${r.level}`;
  const ts = new Date(r.ts).toLocaleTimeString('en-GB', { hour12: false });
  const arrow = r.dir ? `<span class="arrow">${r.dir}</span>` : '';
  let data = '';
  if (r.data != null) {
    const txt = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    data = `<span class="data">${escapeHtml(txt)}</span>`;
  }
  line.innerHTML = `<span class="ts">${ts}</span>${arrow}<span class="body">${escapeHtml(r.text)}${data}</span>`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

// ── BPI simulated screens ────────────────────────────────
function renderScreen(msg) {
  const { screen, promptId, payload = {} } = msg;
  const card = document.createElement('div');
  card.className = 'bpi-card';
  const reply = (data) => { sendWs({ type: 'ui-response', promptId, data }); lockCard(card); };

  if (screen === 'login') buildLogin(card, payload, reply);
  else if (screen === 'login-otp') buildLoginOtp(card, payload, reply);
  else if (screen === 'accounts') buildAccounts(card, payload, reply);
  else if (screen === 'txn-otp') buildTxnOtp(card, payload, reply);
  else if (screen === 'connected') buildConnected(card, payload);
  else if (screen === 'receipt') buildReceipt(card, payload);
  else return;

  chatEl.appendChild(card);
  scrollChat();
  const firstInput = card.querySelector('input');
  if (firstInput) firstInput.focus();
}

function lockCard(card) {
  card.classList.add('done');
  card.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
}

const BPI_MARK = '<div class="bpi-logo"><span class="crown">♛</span> <span class="bpi">BPI</span></div>';
const SSL = '<div class="ssl"><span class="lock">🔒</span> SSL secure · GlobalSign</div>';

function buildLogin(card, p, reply) {
  card.innerHTML = `
    ${BPI_MARK}
    <h3>Login to your account</h3>
    <p class="sub">You need to login to link with <b>${escapeHtml(p.partner || 'PARTNER')}</b></p>
    <div class="field"><label>Username</label><input class="u" placeholder="Username" /></div>
    <div class="field"><label>Password</label><input class="p" type="password" placeholder="Password" /></div>
    <div class="consent">By clicking "Login", you hereby authorize BPI to link your BPI Online Banking account to ${escapeHtml(p.partner || 'PARTNER')}, subject to BPI's <a>Terms and Conditions</a>.</div>
    <button class="bpi-btn">Login</button>
    ${SSL}`;
  card.querySelector('.bpi-btn').onclick = () => {
    const username = card.querySelector('.u').value.trim() || 'demo.user';
    const password = card.querySelector('.p').value || 'demo';
    reply({ username, password });
  };
}

function buildLoginOtp(card, p, reply) {
  card.innerHTML = `
    <div class="otp-phone">📱</div>
    <h3 style="text-align:center">OTP Verification</h3>
    <p class="sub" style="text-align:center">Enter the One-Time PIN sent to your registered mobile number <b>${escapeHtml(p.mobile || '+63917****757')}</b>.</p>
    <div class="otp-row">${'<input maxlength="1" inputmode="numeric" />'.repeat(6)}</div>
    <div class="otp-hint">Demo: type any 6 digits</div>
    <div class="resend">Resend OTP</div>
    <button class="bpi-btn">Submit</button>`;
  wireOtpBoxes(card);
  card.querySelector('.bpi-btn').onclick = () => reply({ otp: readOtpBoxes(card) });
}

function buildAccounts(card, p, reply) {
  const items = (p.accounts || []).map((a) => `
    <div class="acct" data-token="${a.accountNumberToken}">
      <div class="name">${escapeHtml(a.accountPreferredName)}</div>
      <div class="num">${escapeHtml(a.accountNumber)}</div>
    </div>`).join('');
  card.innerHTML = `${BPI_MARK}<div style="margin-bottom:12px;color:#6b7280;font-size:13px;text-align:center">Select the account to use</div>${items}`;
  card.querySelectorAll('.acct').forEach((el) => {
    el.onclick = () => reply({ accountNumberToken: el.dataset.token });
  });
}

function buildTxnOtp(card, p, reply) {
  card.innerHTML = `
    ${BPI_MARK}
    <h3 style="font-size:17px">Enter your One-Time Password</h3>
    <p class="otp-info">To continue, please enter the OTP sent to your mobile device ending in ${escapeHtml(p.mobile || '+63917****757')}.</p>
    <div style="font-size:12px;color:#6b7280;text-align:center;margin-bottom:10px">Loading <b>₱${Number(p.amount || 0).toLocaleString()}</b> from <b>${escapeHtml(p.account || 'BPI account')}</b></div>
    <input class="otp-single" maxlength="6" inputmode="numeric" placeholder="XXXXXX" />
    <div class="otp-valid">OTP Valid until ${escapeHtml(otpValidString())}</div>
    <button class="bpi-btn rounded">Confirm</button>
    <div class="otp-hint">Demo: type any 6 digits</div>`;
  const inp = card.querySelector('.otp-single');
  inp.oninput = () => { inp.value = inp.value.replace(/\D/g, ''); };
  card.querySelector('.bpi-btn').onclick = () => reply({ otp: (inp.value || '123456').padEnd(6, '0').slice(0, 6) });
}

function buildConnected(card, p) {
  card.classList.add('done');
  card.innerHTML = `${BPI_MARK}<div style="text-align:center"><div style="font-size:34px;color:var(--c-api)">✓</div>
    <h3 style="font-size:17px">BPI account linked</h3>
    <p class="sub">3-Legged OAuth complete · scope: <b>${escapeHtml(p.scope || '')}</b></p></div>`;
}

function buildReceipt(card, p) {
  card.classList.add('done', 'receipt');
  card.innerHTML = `
    <div class="check">✓</div>
    <h3>Top-Up Successful</h3>
    <p class="sub" style="text-align:center">Funds loaded from your BPI account</p>
    <div class="kv"><span>Amount</span><span>₱${Number(p.amount || 0).toLocaleString()}</span></div>
    <div class="kv"><span>Source account</span><span>${escapeHtml(p.account || '')} ${escapeHtml(p.accountNumber || '')}</span></div>
    <div class="kv"><span>Confirmation no.</span><span>${escapeHtml(p.confirmationNumber || '')}</span></div>
    <div class="kv"><span>Timestamp</span><span>${escapeHtml(p.confirmationTimestamp || '')}</span></div>`;
}

// OTP box helpers
function wireOtpBoxes(card) {
  const boxes = [...card.querySelectorAll('.otp-row input')];
  boxes.forEach((box, i) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    };
    box.onkeydown = (e) => { if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus(); };
  });
}
function readOtpBoxes(card) {
  const v = [...card.querySelectorAll('.otp-row input')].map((b) => b.value).join('');
  return (v || '123456').padEnd(6, '0').slice(0, 6);
}
function otpValidString() {
  const d = new Date(Date.now() + 5 * 60000 + 8 * 3600000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0800 (DST)`;
}

// ── Greeting & input ─────────────────────────────────────
function greet() {
  bubble('assistant', "Hi! I'm your DRAGONPAY assistant, connected to BPI via MCP. I can load funds into your wallet from your BPI account.");
  const s = document.createElement('div');
  s.className = 'suggestions';
  ['Load ₱500 to my wallet from my BPI account', 'Top up ₱1,000', 'How does this work?'].forEach((t) => {
    const c = document.createElement('div'); c.className = 'chip'; c.textContent = t;
    c.onclick = () => { if (!busy) submit(t); };
    s.appendChild(c);
  });
  chatEl.appendChild(s);
  scrollChat();
}
function submit(text) {
  if (!text.trim() || busy) return;
  document.querySelectorAll('.suggestions').forEach((s) => s.remove());
  sendWs({ type: 'chat', text });
  $('#chat-text').value = '';
}

$('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); submit($('#chat-text').value); });
$('#reset-btn').addEventListener('click', () => sendWs({ type: 'reset' }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Seed empty terminals + greeting
for (const t of Object.values(termEls)) t.innerHTML = '<div class="term-empty">waiting for activity…</div>';
greet();
connect();
