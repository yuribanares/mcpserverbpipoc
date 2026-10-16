# 1 · Concepts in plain words

This page explains every AWS term used in these guides. You don't need to
memorize it; come back whenever a word is unfamiliar.

---

## The big picture

```
 PARTNER SIDE (e.g. DRAGONPAY)          BPI SIDE (on AWS)                        BANK
 ┌───────────────────────┐   HTTPS   ┌───────────────────────────────┐  HTTPS  ┌──────────────┐
 │ Demo UI / partner app │ ────────► │  Amazon Bedrock AgentCore      │ ──────► │  BPI API     │
 │ (LLM + MCP client)    │  + token  │  Runtime                       │         │  (mock bank  │
 └───────────────────────┘           │   └─ BPI MCP Server (our code) │         │  on Lightsail│
            │                        └───────────────────────────────┘         │  in the demo)│
            │   1. gets a login token from          ▲                          └──────────────┘
            └──► Amazon Cognito ─────────────────────┘ 2. AgentCore checks that token
```

1. The partner app **logs in to Amazon Cognito** and gets a short-lived token.
2. It calls the BPI MCP Server on **AgentCore**, sending that token.
3. **AgentCore checks the token** at the "front door". No valid token, no entry.
4. Our MCP server does the work by calling the **BPI API**. In the demo, that's
   the mock bank on **Lightsail**.

---

## AWS words, explained

**AWS account**: your organization's space in AWS. Everything you create lives
in it, and its bill goes to it.

**Region**: the physical location of the data center. We use **Asia Pacific
(Singapore), `ap-southeast-1`**, the closest to the Philippines. In the AWS
console, the region is chosen at the top right. If you can't see something you
created, check the region first.

**AWS console**: the AWS website (https://console.aws.amazon.com). The scripts
print "🔎 Check it in the AWS console" links so you can see what they created.

**AWS CLI**: a command-line tool (`aws ...`) that does the same things as the
console, but by typing commands. The scripts use it. You need **version 2**.

**MCP (Model Context Protocol)**: a standard way for an AI app to call "tools" on
a server. Our server offers 8 tools (connect, list accounts, top up…). See
[`docs/BPI-MCP-SERVER-EXPLAINED.md`](../../../docs/BPI-MCP-SERVER-EXPLAINED.md).

**Amazon Bedrock AgentCore Runtime**: an AWS service that **hosts AI agents and
MCP servers** for you. You give it your code, and it runs the code, scales it,
keeps it secure, and gives it an HTTPS address. What makes it different:
- Each **conversation (session)** gets its own private, isolated copy of the
  server (a tiny virtual machine, called a "microVM"). One partner's session can't
  see another's.
- A session's copy **stops after it has been idle** for a while. We set this to
  1 hour for demos and 15 minutes for production. The next request starts a fresh
  copy.
- For MCP servers it expects port **8000**, path **`/mcp`**, and an **ARM64**
  processor. Our code already follows these rules.

**Runtime**: one MCP server registered in AgentCore. Ours is named
`bpi_mcp_server`.

**ARN (Amazon Resource Name)**: AWS's full, unique ID for something, e.g.
`arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/bpi_mcp_server-AbC123`.
The demo UI uses the runtime's ARN to find it.

**Amazon Lightsail**: AWS's simplest way to run a small server at a fixed
monthly price. We use its **container service** to run the demo mock bank with a
public `https://…amazonlightsail.com` address. *Demo only.*

**Container / image / Docker**: a **container image** is your program packed
together with everything it needs, so it runs the same everywhere. **Docker** is
the tool that builds images. We build one for the mock bank.

**Amazon S3**: AWS's file storage. We upload the MCP server's code (a zip file)
to a **private** S3 "bucket" (folder) that AgentCore reads from.

**IAM (Identity and Access Management)**: AWS's permission system.
- An **IAM role** is a set of permissions that an AWS service can "wear". Our
  server runs as the role `BpiMcpAgentCoreRuntimeRole`, which may only write logs
  and read its own code (and in production, its secret and session table).
- An **IAM user** is a person's or tool's login. You use one, with access keys or
  SSO, to run the scripts.

**Amazon Cognito**: AWS's login service. We use it for **machine logins**:
- A **user pool** is a container for logins (ours: `bpi-mcp-partners`).
- An **app client** is one partner's machine login: a **client id** plus a
  **client secret**, like a username and password for software.
- **Client credentials** (OAuth2) is how a program trades its client id + secret
  for a short-lived **access token**.
- **JWT** is the format of that token: a signed piece of text saying "this is
  partner X, valid until 10:30". AgentCore can verify the signature, so it can't
  be faked.

**Front door (inbound authorization)**: AgentCore checks every request's Cognito
token **before** it reaches our code. We list exactly which partner app clients
are allowed (`allowedClients`).

**AWS Secrets Manager** *(production)*: a locked vault for passwords and keys.
In production, the partner registry (BPI's partner list with their BPI Open
Banking secrets) lives here instead of in code.

**Amazon DynamoDB** *(production)*: an AWS database. In production, login
sessions are stored here, so they survive restarts. **TTL (time to live)** makes
DynamoDB delete old sessions automatically.

**Amazon CloudWatch**: where AWS keeps **logs** and metrics. Everything our
server prints ends up in CloudWatch → *Log groups* →
`/aws/bedrock-agentcore/runtimes/…`.

**VPC (Virtual Private Cloud)** *(production)*: your own private network inside
AWS. In production the server can run inside it, to reach BPI privately instead
of over the public internet.

**Environment variables**: settings handed to a program when it starts, like
`BPI_API_URL=https://…`. Our profiles (`config/demo.env`,
`config/production.env`) become environment variables on the runtime.

---

## Two kinds of "login" — don't mix them up

| | Who logs in | Where | What it protects |
|---|---|---|---|
| **Partner login** (Cognito) | The partner's *software* (e.g. DRAGONPAY's app) | Amazon Cognito → AgentCore front door | Access to the BPI MCP Server at all |
| **Customer login** (3-legged OAuth) | The *customer* (a person) | BPI's own login page + OTP | Access to *that customer's* accounts |

The MCP server **never sees the customer's password or OTP**. Those go straight
to the bank. This is the same design as the local PoC.
