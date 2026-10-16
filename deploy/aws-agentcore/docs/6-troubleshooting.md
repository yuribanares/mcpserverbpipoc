# 6 · Troubleshooting

Find the message you see (or something close), then follow the fix. In most
cases you fix the problem and **re-run the same script**. Every script is safe
to re-run.

**Tip:** many problems turn out to be the **wrong region**. In the AWS console,
check the region at the top right says **Asia Pacific (Singapore)**.

---

## Tools and login (step 0)

**`The AWS CLI is not installed` / `version 2 is required` / `too old to know about AgentCore`**
Install or update the AWS CLI, as described in
[guide 3, Part A](3-deploy-mcp-server-agentcore.md#install-the-aws-cli-version-2).
Then open a new terminal and run `aws --version`.

**`Not logged in to AWS`**
Run `aws configure` (access keys) or `aws configure sso` (single sign-on). If
you use Codespaces secrets for the keys, restart the Codespace after adding them.

**`Docker is not available or not running`**
<a id="docker"></a>
Codespaces normally has Docker ready. Check with `docker info`. If it fails:
* Rebuild the Codespace (Command Palette → *Codespaces: Rebuild Container*).
* If it still fails, ask the repository owner to add the "Docker in Docker"
  feature to the Codespace configuration (`.devcontainer/devcontainer.json`):
  `"features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} }`.
* Docker is only needed for the **mock bank** (and for `DEPLOY_METHOD=container`).
  The MCP server itself uploads as a zip without Docker.

**`lightsailctl is not installed`**
Run the two install lines that `00-check-tools.sh` prints.

**`Could not call AgentCore in ap-southeast-1`**
Your AWS user lacks permission for Bedrock AgentCore, or you're logged in to the
wrong account. See [Permissions you need](3-deploy-mcp-server-agentcore.md#permissions-you-need).

---

## Mock bank on Lightsail (step 1)

**`The deployment did not become active`**
Open Lightsail → Containers → `bpi-mock-bank` → **Deployments** and **Logs**.
* If the health check failed, the logs show why the program didn't start.
  Re-run the script after fixing.
* If the image is missing, run `docker images` and check that `bpi-mock-bank`
  exists, then re-run.

**`Upload failed`** (push-container-image)
Usually `lightsailctl` is missing (see above), or Docker isn't running.

**The bank answers, but slowly**
That's the deliberate demo slow-down (`MOCK_BANK_LATENCY_MS=280` in
`config/demo.env`). Set it to `0` and re-run step 1 if you want it instant.

---

## Partner logins / Cognito (step 4)

**`Cognito didn't issue a token`**
A brand-new login address (domain) can take a minute to start working. Wait,
then re-run step 4. It reuses everything it already created.

**`InvalidParameterException … domain`** when creating the domain
The address `bpi-mcp-<account>` is taken. Change `NAME_PREFIX` in
`config/deploy-settings.env` (lowercase letters, numbers and hyphens) and re-run.

---

## AgentCore runtime (step 5)

**`Runtime status: CREATE_FAILED` / `UPDATE_FAILED — <reason>`**
Read the reason. The common ones:
* *Access denied to S3 / the code:* re-run step 3 (permissions), then step 5.
* *Role can't be assumed:* wait 30 seconds (IAM takes a moment to spread
  across AWS), then re-run step 5.
* *Entry point / file not found:* re-run step 2 to rebuild the zip, then step 5.

**`An error occurred (ValidationException) … unknown parameter …`**
AgentCore is a young service, and an option may have been renamed. Update the
AWS CLI (Part A of guide 3) and retry. If it still fails, the exact request is
in `.state/payloads/agentcore-runtime.json`. Compare it with the AgentCore
documentation, or share the message with the PoC developers.

**Where are the server's logs?**
CloudWatch → Log groups → `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`.
Each line is JSON with `level` and `text`.

---

## Test and demo UI (steps 6–7)

**`Could not connect to the MCP server … 401` or `403`**
The front door rejected the partner's token.
* The token is from a Cognito app client that's **not in `allowedClients`**.
  Re-run step 5 after step 4.
* The `.env` Cognito values are stale. Re-run step 7.

**`The MCP server uses a different bank than this test`**
The runtime's `BPI_API_URL` doesn't match the bank the customer logs in to.
Re-run step 5. With `BPI_API_URL=auto`, it takes the Lightsail address saved by
step 1.

**`Invalid or expired sessionId` / `Partner not authenticated` in the test**
The server lost its memory between two calls. This is usually the idle timeout:
just run the test again. If it happens on every run, check that nothing in your
network strips the `Mcp-Session-Id` header.

**`partner_token_missing`** (production, `PARTNER_AUTH_MODE=jwt`)
The partner's token didn't reach the server. Set `PARTNER_AUTH_MODE=tool` in
`config/production.env` and re-run step 5. See
[guide 5](5-go-to-production.md#about-partner_auth_modejwt).

**In the demo UI: *"Your AWS session timed out after being idle…"***
This is normal after a long pause. Click **⟲ New chat** and ask again. The app
has already reconnected.

**`npm start` stops with `MCP_MODE=aws but these settings are missing`**
Run `./scripts/07-write-demo-ui-settings.sh`, or set `MCP_MODE=local` to use the
local PoC.

**`npm start` stops with `Can't reach the bank at AWS_BANK_URL=…`**
Check that the Lightsail service is **Running** (guide 2), and that the address
in `.env` matches `MOCK_BANK_URL` in `.state/outputs.env`.

**I deployed to the wrong region**
`AWS_REGION` in `config/deploy-settings.env` is what the scripts use. It
deliberately ignores any `AWS_REGION` already set in your terminal. Run
`99-delete-everything.sh` with the old value, fix it, and redeploy.

---

## Still stuck?

Collect three things and share them with the PoC developers:
1. The full output of the script that failed, starting from its `════` title line.
2. The matching file in `.state/payloads/` (it contains **no secrets**).
3. `aws --version` and the region.

**Never share `.state/outputs.env`.** It contains the partners' Cognito secrets.
