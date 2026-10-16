# 4 · Connect the demo UI to AWS (and switch back)

The 4-panel demo UI can talk to either:

| `MCP_MODE` in `.env` | MCP server | Bank |
|---|---|---|
| **`local`** (default) | On your machine, exactly as in the PoC | Local mock bank (`localhost:4000`) |
| **`aws`** | Amazon Bedrock AgentCore Runtime (Singapore) | Mock bank on Amazon Lightsail |

The **AI model (Gemini)** keeps running from the demo UI in both modes. Your
`GEMINI_API_KEY` in `.env` is used as before.

---

## Switch to AWS

After steps 1–6 succeed:

```bash
cd deploy/aws-agentcore
./scripts/07-write-demo-ui-settings.sh
cd ../.. && npm start
```

The script fills these lines in your `.env` for you (a backup of your old `.env`
is kept), so there's nothing to copy by hand:

```ini
MCP_MODE=aws
AWS_REGION=ap-southeast-1
AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:ap-southeast-1:…:runtime/bpi_mcp_server-…
AWS_BANK_URL=https://bpi-mock-bank.….ap-southeast-1.cs.amazonlightsail.com
AWS_COGNITO_TOKEN_URL=https://bpi-mcp-….auth.ap-southeast-1.amazoncognito.com/oauth2/token
AWS_COGNITO_CLIENT_ID=…        # DRAGONPAY's partner login
AWS_COGNITO_CLIENT_SECRET=…
AWS_COGNITO_SCOPE=bpi-mcp/invoke
```

**What you should see:**

* In the terminal, the startup box says **`MCP mode: AWS AgentCore (ap-southeast-1) · Bank: Lightsail mock`**.
* In the browser, an **orange badge** at the top says the same thing.
* The **MCP Client Terminal** shows *"Partner app logged in to Amazon Cognito"* and
  *"MCP session initialized"*.
* Run the usual demo (*"Load ₱500 to my wallet from my BPI account"*). The chat,
  BPI screens, journey stepper, **all four terminal panels** and the **⇄ Flow
  view** behave exactly as in the local PoC.

How do the server and bank panels still fill when those programs run on AWS? In
the demo profile, the AWS server sends its activity lines back with each answer
(`ECHO_LOGS=true`), and the Lightsail bank does the same. The full logs are also
in CloudWatch and in Lightsail's *Logs* tab.

## Switch back to the local PoC

Edit `.env`:

```ini
MCP_MODE=local
```

and restart `npm start`. The `AWS_*` lines are simply ignored in local mode. To
go back to AWS, set `MCP_MODE=aws` again (or re-run step 7).

---

## Good to know before a live demo

* **Warm-up:** the first request after a pause takes a few seconds while AWS
  starts a fresh copy of the server. Send one message a minute before you
  present.
* **Idle timeout:** if the demo sits idle for more than an hour (the demo
  setting), AWS stops that session's copy of the server, and with it the
  logged-in customer. The next action shows:
  > ⚠️ Your AWS session timed out after being idle, so BPI needs you to log in again. Please click "⟲ New chat" and ask again.

  Click **⟲ New chat** and run the demo again. The app has already reconnected
  for you.
* **If the app refuses to start in AWS mode**, it tells you exactly which setting
  is missing or which address isn't reachable, and which guide to read.

## Try the AWS mode without AWS (local test)

```bash
cd deploy/aws-agentcore && ./scripts/try-locally.sh --keep
# in a second terminal, from the repository root:
MCP_MODE=aws AWS_MCP_URL=http://localhost:8000/mcp AWS_BANK_URL=http://localhost:4100 npm start
```

The badge then reads *"Remote test server (localhost:8000) · Bank: localhost:4100"*.

**Next:** [5 · Go to production](5-go-to-production.md)
