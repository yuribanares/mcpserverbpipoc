# 7 · Costs and clean-up

## What costs money while it exists

Prices change and depend on usage. Check the AWS pricing pages before you
start, and set a **budget alert** (AWS Budgets) on the account. As a rough
guide for a demo setup:

| Piece | How it's charged | Demo ballpark |
|---|---|---|
| **Lightsail mock bank** (`nano`) | Fixed monthly price while it exists, even when idle | about **US$7 / month** |
| **AgentCore Runtime** | Pay per use: CPU and memory while sessions are active | small for occasional demos |
| **Amazon Cognito** partner logins | Machine-to-machine logins are charged per app client and per token request | small |
| **S3** (code zip) | Storage | a few cents |
| **CloudWatch Logs** | Data stored and ingested | a few cents for demos |
| **Secrets Manager** *(production)* | Per secret per month (+ per API call) | about US$0.40 / secret / month |
| **DynamoDB** *(production)* | Pay per request + storage | cents at low volume |

The biggest fixed demo cost is the Lightsail mock bank. Delete it when the demo
period is over.

## Delete everything

```bash
cd deploy/aws-agentcore
./scripts/99-delete-everything.sh
```

It asks you to type **DELETE**, then removes, in a safe order:
1. the AgentCore Runtime
2. the Cognito user pool (all partner logins)
3. the IAM role
4. the code bucket (and the ECR repository, if you used containers)
5. the Lightsail mock bank
6. the partner-registry secret and the session table, **only if** the `p1` / `p2`
   scripts created them. Secrets are kept recoverable for 7 days.

Anything already gone is skipped, so it's safe to run twice. Your code, your
`.env` and the local PoC are untouched. Set `MCP_MODE=local` in `.env` to carry
on demoing locally.

## Between demos: stop paying for the mock bank only

> ⚠️ **"Disabling" a Lightsail container service does NOT stop the charges.**
> AWS bills it whether it's enabled or disabled. Only **deleting** it stops
> them.

To keep everything else and remove just the mock bank:

1. Lightsail console → **Containers** → `bpi-mock-bank` → **Delete**.
2. When you need the demo again:
   ```bash
   ./scripts/01-deploy-mock-bank.sh          # recreates it (the address will change)
   ./scripts/05-create-agentcore-runtime.sh  # tells the MCP server the new address
   ./scripts/07-write-demo-ui-settings.sh    # tells the demo UI the new address
   ```

**AgentCore** costs nothing meaningful while no sessions are active, so leaving
the runtime in place between demos is fine.
