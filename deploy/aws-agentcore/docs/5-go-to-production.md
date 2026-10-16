# 5 · Go to production

The demo and production run **the same code**. Going to production means
**changing settings and adding a few AWS pieces**, not rewriting the server.

---

## What changes, and why

| Area | Demo | Production | Why it matters |
|---|---|---|---|
| **Bank** | Mock bank on Lightsail | The **real BPI Open Banking API** | Real accounts and money |
| **Partner registry** (BPI's vault) | Demo values in the code | **AWS Secrets Manager**, encrypted and access-controlled | BPI's banking secrets must never live in code |
| **Partner front door** | Cognito, 2 demo partners | Cognito with your real partners (or your company's identity provider) | Only onboarded partners get in |
| **Partner check inside the server** | `bpi_partner_authenticate` with a second secret | **`jwt`**: the partner is read from its verified Cognito token (one login) | Fewer secrets to manage |
| **Login sessions** | Server memory | **Amazon DynamoDB**, with automatic expiry | Survives restarts, and old sessions are deleted |
| **Network** | Public internet | **Private network (VPC)** | Reach BPI privately and limit exposure |
| **Logs** | Echoed back to the demo UI | **CloudWatch only** (`ECHO_LOGS=false`) | Callers must never see server internals |
| **Idle timeout** | 1 hour | 15 minutes | Shorter exposure for idle sessions |
| **BPI message signing** | Off | **Must be built** (see checklist) | Required by the BPI API contract |

---

## Steps

### 1. Create your production settings file

```bash
cd deploy/aws-agentcore
cp config/production.example.env config/production.env
```

Open `config/production.env` and fill in every value marked `<<< CHANGE ME`:
* `BPI_API_URL`: the real BPI API address, from BPI's API onboarding.
* `VPC_SUBNET_IDS` and `VPC_SECURITY_GROUP_IDS`: from your network team. Use
  private subnets that can reach the BPI API. Or set `NETWORK_MODE=PUBLIC` if
  BPI is reached over the internet.

`config/production.env` is git-ignored, and it holds **no passwords**.

### 2. Switch the profile

In `config/deploy-settings.env`:

```ini
PROFILE=production
```

### 3. Put the partner registry in Secrets Manager

```bash
cp config/partner-registry.example.json config/partner-registry.json
# edit config/partner-registry.json — one entry per partner:
#   bpiClientId / bpiClientSecret : issued by BPI Open Banking for that partner
#   jwtClientIds                  : that partner's Cognito app client id (from step 4,
#                                   see CLIENT_ID_<partner> in .state/outputs.env)
#   mcpClientSecret               : only needed if PARTNER_AUTH_MODE=tool
./scripts/p1-create-partner-secret.sh
rm config/partner-registry.json      # the only copy now lives, encrypted, in AWS
```

The script refuses to upload a file that still contains `REPLACE-…` placeholders.
The server re-reads the secret every 10 minutes, so you can rotate a partner's
secret without redeploying.

### 4. Create the session table

```bash
./scripts/p2-create-session-table.sh
```

This creates a DynamoDB table `bpi-mcp-sessions` (pay-per-request, encrypted,
with automatic expiry). Sessions store only an opaque ID, the customer's access
token, and the **partner ID**. BPI's banking secret is never copied into the
table.

### 5. Re-apply permissions and the runtime

```bash
./scripts/03-create-permissions.sh      # adds: read that one secret, use that one table, VPC networking
./scripts/05-create-agentcore-runtime.sh
./scripts/06-test-on-aws.sh             # against the real bank: use a BPI test environment first!
```

### 6. Remove the demo pieces

The mock bank isn't used in production. Delete the Lightsail service from the
Lightsail console (Containers → `bpi-mock-bank` → Delete), or delete everything
with `99-delete-everything.sh` and redeploy cleanly.

---

## About `PARTNER_AUTH_MODE=jwt`

In `jwt` mode, AgentCore is told to pass the partner's token through to our
server (`requestHeaderAllowlist: ["Authorization"]`). The server then verifies
the token again and reads which partner it belongs to. The partner calls the
same `bpi_partner_authenticate` tool, just **without** a second secret.

AWS's documentation doesn't yet clearly confirm that the token is passed
through for MCP servers. If your test shows **`partner_token_missing`**, set
`PARTNER_AUTH_MODE=tool` in `config/production.env` and re-run step 5 of these
instructions. The partner then also sends its `mcpClientSecret` (from the
registry). This is **still secure**: two independent checks instead of one.

---

## Production readiness checklist

Settings and infrastructure:
- [ ] `BPI_API_URL` points to the real BPI API (test environment first, then live)
- [ ] Partner registry is in **Secrets Manager** and the local JSON file is deleted
- [ ] `SESSION_STORE=dynamodb` and the table exists, with TTL on
- [ ] `ECHO_LOGS=false`
- [ ] `NETWORK_MODE=VPC` with private subnets, or a documented reason for `PUBLIC`
- [ ] The Lightsail mock bank is **deleted**
- [ ] Cognito app clients exist only for **onboarded** partners. Remove `juanpay` if it isn't real.

Security work still to build (not in this PoC):
- [ ] **BPI request signing (JWE/JWT)** from the API contract. `BPI_MESSAGE_SIGNING`
      is a placeholder: the server refuses to start if you switch it on, until
      this is built.
- [ ] Strong partner authentication between servers, e.g. **mutual TLS** or
      **signed JWT client assertions** instead of shared client secrets
- [ ] **Per-partner limits**: rate limits and maximum top-up amounts
- [ ] **Audit trail**: who did what and when, kept per BPI's retention rules
- [ ] Secret **rotation** schedule in Secrets Manager
- [ ] A security review / penetration test

Operations:
- [ ] **CloudWatch alarms** on errors and latency for the runtime
- [ ] A runbook: who is on call and how to roll back (re-run step 5 with the previous zip)
- [ ] Separate AWS accounts (or at least separate runtimes) for **test** and **live**
- [ ] Cost alerts with **AWS Budgets**

---

## Settings reference

Server settings (Part A of the profile file, sent to the runtime):

| Setting | Values | Meaning |
|---|---|---|
| `BPI_API_URL` | URL, or `auto` (demo) | Bank address. `auto` means the Lightsail mock bank |
| `PARTNER_REGISTRY_SOURCE` | `builtin` / `secretsmanager` | Where partners and their BPI secrets come from |
| `PARTNER_REGISTRY_SECRET_ID` | name | Secrets Manager secret name (production) |
| `PARTNER_AUTH_MODE` | `tool` / `jwt` | How the server identifies the partner |
| `SESSION_STORE` | `memory` / `dynamodb` | Where login sessions live |
| `SESSION_TABLE_NAME` | name | DynamoDB table (production) |
| `ECHO_LOGS` | `true` / `false` | Demo only: send activity lines back to the UI |
| `BPI_MESSAGE_SIGNING` | `off` | Placeholder until request signing is built |

Infrastructure settings (Part B, used by the scripts):

| Setting | Values | Meaning |
|---|---|---|
| `NETWORK_MODE` | `PUBLIC` / `VPC` | Public internet, or your private network |
| `VPC_SUBNET_IDS`, `VPC_SECURITY_GROUP_IDS` | comma-separated IDs | Only for `VPC` |
| `IDLE_SESSION_TIMEOUT_SECONDS` | 60–28800 | Idle time before a session's server copy stops |
| `MAX_LIFETIME_SECONDS` | 60–28800 | Longest a server copy may live |
| `MOCK_BANK_LATENCY_MS` | number | Demo slow-down on the mock bank |

The settings the scripts set automatically are `COGNITO_USER_POOL_ID`,
`PARTNER_JWT_CLIENT_MAP` (which Cognito client belongs to which partner) and
`AWS_REGION`.
