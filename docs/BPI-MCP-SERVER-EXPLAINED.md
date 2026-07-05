# BPI MCP Server — Explained

A presenter's walkthrough of **`server/bpi-mcp-server.js`** — the file that *is*
the product. Written for business and architecture stakeholders. Read it top to
bottom, or jump to the section you're presenting.

---

## 1. Elevator pitch (30 seconds)

> The **BPI MCP Server** is a new product: a secure "adapter" that lets any
> partner's AI assistant move money through BPI Open Banking — safely, and
> without the partner ever touching BPI's credentials or the customer's login.
> BPI owns and hosts it; partners just connect their AI app to it and call a
> short menu of **tools** (connect, list accounts, top up). Every sensitive
> secret and access token stays **inside BPI**.

---

## 2. What is an "MCP server"? (plain language)

**MCP (Model Context Protocol)** is an emerging industry standard for letting an
AI assistant call functions on an outside system in a controlled way.

- The **AI decides *what* to do** ("the customer wants to load ₱500").
- The **MCP server decides *how* it's done safely** (which BPI API to call, with
  which credentials, in what order).

Think of the MCP server as a **waiter**: the AI (customer) orders from a fixed
**menu of tools**; the kitchen (BPI Open Banking) does the real work; the waiter
enforces the rules and never hands the customer the keys to the kitchen.

Why this matters for BPI: many partners **already** have AI chat apps that speak
MCP. Shipping a BPI MCP server means those partners can integrate in days, using
a standard they already support — instead of a bespoke API project each time.

---

## 3. Where this file sits (the big picture)

```
   Partner's AI app                BPI-owned                     BPI
  ┌────────────────┐   MCP    ┌──────────────────┐   HTTPS   ┌──────────────┐
  │  LLM + MCP     │ ───────▶ │  BPI MCP SERVER  │ ────────▶ │ Open Banking │
  │  Client        │  tools   │  (THIS FILE)     │  API call │ API          │
  └────────────────┘          └──────────────────┘           └──────────────┘
     partner-owned                 BPI-owned                    BPI core
```

This file is the **middle box**. It receives tool calls from the partner's AI
app and turns them into authenticated BPI Open Banking API calls.

---

## 4. The two security boundaries (the heart of the pitch)

This is the most important slide. The server enforces **two separate
authentication layers**, and **secrets never cross either boundary outward**:

| Layer | Question it answers | How | What the caller gets back |
|---|---|---|---|
| **1. Partner → BPI MCP Server** | "Which partner is this, and are they allowed?" | Partner presents its **own** MCP credential (`bpi_partner_authenticate`) | An opaque **partnerToken** — never the BPI secret |
| **2. Customer → BPI** | "Does the customer approve access to *their* accounts?" | Customer logs in + OTP **on BPI's own pages** | An opaque **sessionId** — never the raw access token |

**Two different secrets, one of them never leaves BPI:**

- The **partner's MCP credential** — issued to the partner; proves who they are.
- The **BPI Open Banking `client_secret`** — the powerful banking credential.
  It lives in BPI's **vault inside this server** and is **never returned** to the
  partner or the AI.

> Talking point: *"Even though the AI orchestrates the whole journey, it never
> holds a single reusable secret. If a partner's AI were ever compromised, the
> attacker still couldn't move money on their own — the credentials live with us."*

---

## 5. The lifecycle of one request

```
Partner AI app                 BPI MCP Server (this file)              BPI Open Banking API
     │  tools/call "…"                 │                                       │
     │ ──────────────────────────────▶│  CallTool handler                     │
     │                                 │    → dispatch(name, args)             │
     │                                 │        → bpiFetch(...)  ────────────▶ │
     │                                 │                                       │  (does the work)
     │                                 │        ◀──────────────────────────────│
     │ ◀───────────────────────────────│  result (opaque token / data)        │
```

Everything the customer or partner sees is an **opaque token or masked data**;
the real tokens and secrets stay in the middle box.

---

## 6. Section-by-section walkthrough

The file is organized top to bottom in the order you'd explain it. Each heading
below matches a `// ───` banner in the code.

1. **File header** — the "read me first" overview: what MCP is, the 8 tools, and
   the two security boundaries. *Great place to start a live walkthrough.*

2. **Configuration** — where BPI's Open Banking API lives (a mock in this PoC).

3. **Partner registry = BPI's vault** — the multi-tenant table. Two demo
   partners (**DRAGONPAY**, **JUANPAY**), each with (a) their MCP credential and
   (b) their vaulted BPI Open Banking `client_id`/`secret`. *This is the concrete
   answer to "how do you know which partner uses which secret?"*

4. **Server-side state** — two lookup tables. The outside world only ever holds
   the **keys** (`partnerToken`, `sessionId`); the **values** (secrets, tokens)
   never leave.

5. **Logging (`slog`)** — writes the plain-English lines you see in the "BPI MCP
   Server Terminal" panel. (Protocol messages use a separate channel.)

6. **HTTP helper (`bpiFetch`)** — the one place that calls BPI's API, attaching
   the correct tenant credentials and customer token.

7. **Tool catalog (`TOOLS`)** — the **menu** the server advertises. Each tool has
   a name, a plain description (the AI reads this to decide when to use it), and
   its expected inputs. Each is annotated with the BPI endpoint it maps to.

8. **MCP wiring** — two handlers: `tools/list` (discover the menu) and
   `tools/call` (run a tool). The `tools/call` handler is the server's heartbeat.

9. **Auth guards** — `requirePartner` / `requireSession` enforce the correct
   order: authenticate the partner → complete customer OAuth → then transact.

10. **Dispatch** — the actual work behind each tool (see the table in §7 below).

11. **Helpers** — masking secrets before logging; constant-time secret comparison.

12. **Bootstrap** — connect over stdio and start listening.

---

## 7. The 8 tools at a glance

| # | Tool | Plain purpose | BPI endpoint |
|---|---|---|---|
| 1 | `bpi_partner_authenticate` | Prove which **partner** is calling | *(no API call)* |
| 2 | `bpi_begin_authorization` | Build BPI's **login URL** for the customer | *(no API call)* |
| 3 | `bpi_exchange_token` | Turn the login code into an **access token** | `POST /oauth2/token` |
| 4 | `bpi_list_transactional_accounts` | List the customer's **accounts** | `GET /accounts/transactionalAccounts` |
| 5 | `bpi_fundtopup_initiate` | **Start** a top-up | `POST /fundTopUp/initiate` |
| 6 | `bpi_fundtopup_send_otp` | **Text the OTP** to the customer | `POST /fundTopUp/otp` |
| 7 | `bpi_fundtopup_process` | **Confirm** with the OTP (receipt) | `POST /fundTopUp/process` |
| 8 | `bpi_fundtopup_status` | **Check** a transaction posted | `GET /fundTopUp/status` |

Tools 1–2 do no API call — they're setup steps handled entirely inside the
server. Tools 3–8 each map to exactly one BPI Open Banking API endpoint.

---

## 8. Multi-tenant, in one picture

```
   Partner presents its MCP credential
   ("mcp_dragonpay_7f3a91" + secret)
                │
                ▼
   ┌─────────────────────────────────────────┐
   │ BPI's Partner Registry (the vault)        │
   │  dragonpay → { BPI client_id, secret }    │   ◀── the BPI secret
   │  juanpay   → { BPI client_id, secret }    │       is picked here,
   └─────────────────────────────────────────┘       server-side only
                │
                ▼
   Server uses THAT tenant's BPI credentials for the rest of the journey.
   Partner receives only an opaque partnerToken.
```

Onboarding a new partner = **adding one row** to this registry (in production, a
record in a secrets manager / HSM). Nothing about the partner's AI app changes.

---

## 9. What's real vs. simulated in this PoC

- **Real:** the MCP protocol and server (official MCP SDK), the tool catalog and
  discovery, the two-layer auth logic, and the request/response shapes, which
  follow the *BPI Partner API 2.0 contract*.
- **Simulated:** the BPI Open Banking API is a local mock; the partner registry
  is in-code with demo values; any 6-digit OTP is accepted. No real BPI systems
  are contacted.

---

## 10. Questions you may get asked (and short answers)

- **"How do you know which partner is using which secret?"** — The partner
  authenticates with its *own* MCP credential; BPI maps that to the tenant's
  vaulted Open Banking secret (§8). The banking secret never leaves BPI.

- **"Does the AI ever see the customer's password or the access token?"** — No.
  Login + OTP happen on BPI's own pages; the AI only ever gets opaque
  `sessionId`/`partnerToken` handles.

- **"What would harden this for production?"** — Store the registry in a secrets
  manager/HSM; authenticate partners with mTLS or signed JWT client assertions
  instead of a shared secret; add rate-limiting, audit logging, and per-tenant
  scopes/limits. (The current code is structured so these slot in without
  changing the tool surface.)

- **"Why MCP instead of a normal API?"** — Because partners' AI assistants
  already speak MCP. It turns "integrate our bank" into "add a server to your
  agent," dramatically lowering the cost for partners to adopt BPI rails.
