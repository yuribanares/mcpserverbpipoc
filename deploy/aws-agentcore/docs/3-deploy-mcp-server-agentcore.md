# 3 · Deploy the BPI MCP Server to Amazon Bedrock AgentCore Runtime

**Goal:** run `server/bpi-mcp-server.js` (the same file the local PoC uses) on
AgentCore in Singapore, protected by partner logins, and prove it works end to
end.

You'll run steps **0, 2, 3, 4, 5 and 6** (step 1 is the mock bank, covered in
[guide 2](2-deploy-mock-bank-lightsail.md)).

---

## Part A — One-time setup in your Codespace

### Install the AWS CLI (version 2)

Check first: `aws --version` should print `aws-cli/2.something`. If it's
missing or older, run this in the Codespace terminal:

```bash
cd /tmp
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip -q awscliv2.zip && sudo ./aws/install --update
aws --version        # → aws-cli/2.x.x …
```

### Install lightsailctl (only needed for the demo mock bank)

```bash
sudo curl -fsSL https://s3.us-west-2.amazonaws.com/lightsailctl/latest/linux-amd64/lightsailctl -o /usr/local/bin/lightsailctl
sudo chmod +x /usr/local/bin/lightsailctl
```

### Log in to AWS

Pick **one** of these:

* **Your company uses AWS single sign-on (IAM Identity Center):**
  `aws configure sso`, then follow the prompts. Use region `ap-southeast-1`.
* **You were given an access key** (an "Access key ID" and a "Secret access
  key"):
  - **Safest in Codespaces:** store them as **Codespaces secrets** named
    `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, so they're never written to
    a file. To do this, go to GitHub → your profile **Settings** → **Codespaces**
    → **New secret** and tick this repository. Then restart the Codespace.
  - Or run `aws configure` and paste them. Use region `ap-southeast-1` and
    output `json`.

Check: `aws sts get-caller-identity` prints your account number.

### Permissions you need

The person running the scripts needs permission to use: **Lightsail, S3, IAM**
(create a role, and `iam:PassRole` to hand it to AgentCore), **Cognito**,
**Bedrock AgentCore**, and, for production, **Secrets Manager** and
**DynamoDB**. On a sandbox account, *AdministratorAccess* is simplest. In a
company account, ask your AWS administrator for these.

### Check everything

```bash
cd deploy/aws-agentcore
npm install
./scripts/00-check-tools.sh
```

You should see ✅ for each line and **"Everything is ready"**. If something is
❌, the script prints the exact fix.

---

## Part B — Deploy (steps 2 → 6)

### Step 2 · Package and upload the code

```bash
./scripts/02-upload-mcp-server.sh
```

**What happens:** it copies `server/bpi-mcp-server.js` plus the small HTTP entry
point into a folder (with the same layout as the repository), installs the
libraries **for AgentCore's Linux ARM64 machines**, zips it all, and uploads
the zip to a **private** S3 bucket named
`bpi-mcp-code-<your-account>-ap-southeast-1`.

**No Docker is needed** for this. AgentCore runs the zip directly with its
built-in Node.js 22. *(Prefer containers? Set `DEPLOY_METHOD=container` in
`config/deploy-settings.env`, and the script builds an ARM64 image and pushes it
to Amazon ECR instead.)*

**You should see:** `✅ Uploaded to s3://bpi-mcp-code-…/bpi-mcp-server/bpi-mcp-server-<date>.zip`

### Step 3 · Create the IAM role

```bash
./scripts/03-create-permissions.sh
```

**What happens:** it creates the role `BpiMcpAgentCoreRuntimeRole`. Only
AgentCore in your account can use it, and it may only write logs and traces and
read the code zip. The exact permissions are in
`.state/payloads/iam-permissions-policy.json`.

### Step 4 · Create the partner logins (Cognito)

```bash
./scripts/04-create-partner-logins.sh
```

**What happens:** it creates a Cognito **user pool** `bpi-mcp-partners`, a login
address, a permission named `bpi-mcp/invoke`, and **one app client per partner**
(`dragonpay`, `juanpay`). Then it proves a partner can get a token.

**You should see:** `✅ Token received — partner login works`

> 🔐 The partners' client secrets are saved in `.state/outputs.env`, which is
> git-ignored and readable only by you. Treat it like a password file.

### Step 5 · Start the MCP server on AgentCore

```bash
./scripts/05-create-agentcore-runtime.sh
```

**What happens:** it registers the runtime `bpi_mcp_server` with:
* **the code:** the zip from step 2
* **the protocol:** MCP (AgentCore then sends requests to port 8000, path `/mcp`)
* **the role:** from step 3
* **the front door:** only tokens from the `dragonpay` / `juanpay` app clients get in
* **the settings:** from `config/demo.env`. The bank address becomes your
  Lightsail URL, and memory sessions, log echo and other demo values match the
  PoC.
* **idle timeout:** 1 hour for demos, so a paused presenter keeps the session

The full request is saved in `.state/payloads/agentcore-runtime.json`.

**You should see:** `✅ Runtime is READY` and its ARN.

**Check it in the console:** search **"Bedrock AgentCore"** in the AWS console
(region Singapore) → **Runtime** → `bpi_mcp_server`. Its logs are in
**CloudWatch → Log groups → `/aws/bedrock-agentcore/runtimes/bpi_mcp_server-…`**.

### Step 6 · Test it end to end

```bash
./scripts/06-test-on-aws.sh
```

**What happens:** without a browser, it acts as DRAGONPAY. It logs in to Cognito,
connects to AgentCore, authenticates the partner, logs a "customer" in at the
mock bank, lists the accounts, tops up ₱1 from Payroll, and checks the status.

**You should see:**

```
  ✅  1. Bank is reachable (bpi-mock-bank)
  ✅  2. Partner logged in to Cognito (front-door token received)
  ✅  3. Connected over MCP — 8 tools advertised
  ✅  4. Partner authenticated — tenant: DRAGONPAY CORP
  ✅  5. Customer login URL received — server and customer use the same bank
  ✅  6. Customer logged in at the bank + login OTP accepted
  ✅  7. Login code exchanged for a session (scope: transactionalAccountsForBillsPay fundTopUp)
  ✅  8. Accounts: Hobbies Account (XXXXXX9359), Payroll (XXXXXX0337), Yuna ATM 2016 (XXXXXX6899)
  ✅  9. Top-up of ₱1 from Payroll confirmed — confirmation no. …
  ✅ 10. Transaction status: SUCCESSFUL

  🎉 All steps passed — the BPI MCP Server works end to end.
```

The first run after a pause may take a few extra seconds, because AgentCore is
starting a fresh copy.

---

## Updating later

| You changed… | Run |
|---|---|
| The MCP server code (`server/bpi-mcp-server.js` or `src/`) | `02-upload-mcp-server.sh` then `05-create-agentcore-runtime.sh` |
| A setting in `config/demo.env` or `config/production.env` | `05-create-agentcore-runtime.sh` (and `03-…` if you switched profile) |
| The mock bank | `01-deploy-mock-bank.sh` |
| Added a partner to `PARTNERS` | `04-…` then `05-…` |

**Next:** [4 · Connect the demo UI](4-connect-demo-ui.md)
