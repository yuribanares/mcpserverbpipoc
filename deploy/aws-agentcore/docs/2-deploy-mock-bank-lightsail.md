# 2 · Deploy the mock bank to Amazon Lightsail (demo only)

**Goal:** run the proof of concept's mock BPI bank on the internet, at an address
like `https://bpi-mock-bank.xxxxxxxx.ap-southeast-1.cs.amazonlightsail.com`,
so that both the demo UI and the AWS-hosted MCP server can use it.

> **Production doesn't need this step.** There, the server calls the real BPI API.

---

## What gets deployed (the code)

Nothing new is invented here. The mock bank on Lightsail is the **same
`server/bpi-api.js`** the local PoC runs: same three accounts (Hobbies Account,
Payroll, Yuna ATM 2016), same "any 6 digits" OTP rule, same responses. Two
small files package it.

**`src/mock-bank.js`** starts the PoC's mock bank on its own:

```js
import { startBpiApi } from '../../../server/bpi-api.js';
import { onLog } from '../../../server/logbus.js';

// Print every bank log line as one JSON line → visible in Lightsail's "Logs" tab.
onLog((rec) => console.log(JSON.stringify({ ts: rec.ts, source: 'bpi-mock-bank', level: rec.level, text: rec.text })));

const port = Number(process.env.PORT || 8080);
await startBpiApi(port);
```

**`Dockerfile.mock-bank`** packs it into a container image:

```dockerfile
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY deploy/aws-agentcore/package.json deploy/aws-agentcore/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY server/bpi-api.js server/logbus.js ./server/
COPY deploy/aws-agentcore/src/mock-bank.js ./deploy/aws-agentcore/src/
EXPOSE 8080
USER node
CMD ["node", "deploy/aws-agentcore/src/mock-bank.js"]
```

Two small, opt-in additions were made to `server/bpi-api.js`. The local PoC
doesn't use either of them:
- **`GET /health`** answers `{"status":"ok"}`. Lightsail uses it to check the
  bank is alive.
- **`DEMO_ECHO_LOGS=true`** makes each answer carry a copy of the bank's terminal
  lines, so the demo UI's "BPI API" panel still fills when the bank runs
  remotely. The demo UI and the MCP server remove that copy before using the
  answer.

---

## Do it: run the script

```bash
cd deploy/aws-agentcore
./scripts/00-check-tools.sh      # once; fixes are shown for anything missing
./scripts/01-deploy-mock-bank.sh
```

**What you should see** (it takes about 5–10 minutes the first time):

```
▶ 1/4 Build the mock bank container image
  ✅ Image built: bpi-mock-bank:latest
▶ 2/4 Create the Lightsail container service "bpi-mock-bank" (if needed)
  ✅ Service created (power: nano, 1 copy)
  ⏳ Waiting for the service to be ready (usually 2–5 minutes) ....... done
▶ 3/4 Upload the image and start it
  ✅ Image uploaded as :bpi-mock-bank.mockbank.1
  ✅ Deployment started (settings sent: .state/payloads/lightsail-deployment.json)
  ⏳ Waiting for the mock bank to start (usually 3–5 minutes) ...... done
▶ 4/4 Check the mock bank answers on the internet
  ✅ Mock bank is live: https://bpi-mock-bank.xxxxxxxx.ap-southeast-1.cs.amazonlightsail.com
```

The address is saved automatically (as `MOCK_BANK_URL` in `.state/outputs.env`),
and the later steps use it.

**Check it yourself:**
```bash
curl https://<your-address>/health
# → {"status":"ok","service":"bpi-mock-bank"}
```

**Check it in the AWS console:** open https://lightsail.aws.amazon.com →
**Containers** → `bpi-mock-bank`. The status should be **Running**. The
**Deployments** tab shows the active deployment, and the **Logs** tab shows the
bank's activity.

---

## What the script does, step by step (if you'd rather do it by hand)

Each step is a single AWS CLI command. Running them yourself gives the same
result as the script.

1. **Build the image** from the repository root:
   ```bash
   docker build --platform linux/amd64 -f deploy/aws-agentcore/Dockerfile.mock-bank -t bpi-mock-bank:latest .
   ```
2. **Create the container service.** `nano` is the smallest size, with 1 copy:
   ```bash
   aws lightsail create-container-service --region ap-southeast-1 \
     --service-name bpi-mock-bank --power nano --scale 1
   ```
   Wait until `aws lightsail get-container-services --service-name bpi-mock-bank --query 'containerServices[0].state'` says `READY`.
3. **Upload the image.** This needs the `lightsailctl` plug-in:
   ```bash
   aws lightsail push-container-image --region ap-southeast-1 \
     --service-name bpi-mock-bank --label mockbank --image bpi-mock-bank:latest
   ```
   Note the name it prints, e.g. `:bpi-mock-bank.mockbank.1`.
4. **Start it**, with a public HTTPS endpoint and a health check on `/health`:
   ```bash
   aws lightsail create-container-service-deployment --region ap-southeast-1 \
     --cli-input-json file://deployment.json
   ```
   where `deployment.json` is:
   ```json
   {
     "serviceName": "bpi-mock-bank",
     "containers": {
       "mockbank": {
         "image": ":bpi-mock-bank.mockbank.1",
         "environment": { "PORT": "8080", "DEMO_ECHO_LOGS": "true", "BPI_API_LATENCY_MS": "280", "PARTNER_NAME": "DRAGONPAY CORP" },
         "ports": { "8080": "HTTP" }
       }
     },
     "publicEndpoint": {
       "containerName": "mockbank",
       "containerPort": 8080,
       "healthCheck": { "path": "/health", "intervalSeconds": 10, "timeoutSeconds": 5, "healthyThreshold": 2, "unhealthyThreshold": 3, "successCodes": "200" }
     }
   }
   ```
5. **Get the address:**
   ```bash
   aws lightsail get-container-services --service-name bpi-mock-bank --query 'containerServices[0].url' --output text
   ```

---

## Common questions

**I changed the bank's code. How do I update it?** Run
`./scripts/01-deploy-mock-bank.sh` again. It reuses the service and deploys the
new image.

**Is the mock bank secure?** It's **public** and holds only **fake data**. Anyone
with the address could call it, which is fine for a demo. Delete it when you're
done (`./scripts/99-delete-everything.sh`) and never use it for real data.

**Why does it have only 1 copy?** The mock bank keeps logins in memory. With one
copy, every request reaches the same memory. (The real BPI API handles this
properly.)

**What does it cost?** The `nano` size is about **US$7 per month** while it
exists, even when idle, and **even when "disabled"**. Only deleting it stops the
charge. See [7-costs-and-cleanup.md](7-costs-and-cleanup.md).

**Next:** [3 · Deploy the MCP server to AgentCore](3-deploy-mcp-server-agentcore.md)
