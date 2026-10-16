// partner-registry.js — where the partner registry (BPI's vault) comes from.
//
//   builtin        → the demo partners (DRAGONPAY, JUANPAY) defined in
//                    server/bpi-mcp-server.js. Same values as the local PoC.
//   secretsmanager → one AWS Secrets Manager secret holding the same JSON shape
//                    (see config/partner-registry.example.json). The secret is
//                    re-read every 10 minutes, so rotating a partner's secret
//                    does not need a redeploy.
import { DEMO_PARTNER_REGISTRY } from '../../../server/bpi-mcp-server.js';

const REFRESH_MS = 10 * 60 * 1000;
const REQUIRED = ['partnerId', 'displayName', 'bpiClientId', 'bpiClientSecret', 'scopes'];

export async function createPartnerRegistry(settings, log) {
  if (settings.registrySource === 'builtin') {
    log({ level: 'info', text: `Partner registry: built-in demo partners (${names(DEMO_PARTNER_REGISTRY)}).` });
    return { current: () => DEMO_PARTNER_REGISTRY };
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: settings.region });
  const fetchRegistry = async () => {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: settings.registrySecretId }));
    return validate(JSON.parse(out.SecretString || '{}'), settings);
  };

  let registry = await fetchRegistry(); // fail fast at startup if the secret is wrong
  log({ level: 'ok', text: `Partner registry: loaded ${Object.keys(registry).length} partner(s) from Secrets Manager (${names(registry)}).` });
  setInterval(async () => {
    try { registry = await fetchRegistry(); }
    catch (err) { log({ level: 'err', text: `Partner registry refresh failed, keeping the last good copy: ${err.message}` }); }
  }, REFRESH_MS).unref();
  return { current: () => registry };
}

// Check every partner entry has what the server needs, with a clear message.
function validate(reg, settings) {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) throw new Error('Partner registry secret must be a JSON object keyed by mcpClientId.');
  for (const [mcpClientId, t] of Object.entries(reg)) {
    const missing = REQUIRED.filter((k) => !t?.[k]);
    if (settings.partnerAuthMode === 'tool' && !t?.mcpClientSecret) missing.push('mcpClientSecret');
    if (missing.length) throw new Error(`Partner "${mcpClientId}" is missing: ${missing.join(', ')}.`);
  }
  return reg;
}

// Which partner does a verified Cognito app-client id belong to? Built from
// PARTNER_JWT_CLIENT_MAP plus any "jwtClientIds" listed in the registry.
export function jwtClientToPartner(settings, registry) {
  const map = { ...settings.jwtClientMap };
  for (const t of Object.values(registry)) for (const id of t.jwtClientIds || []) map[id] = t.partnerId;
  return map;
}

const names = (reg) => Object.values(reg).map((t) => t.displayName).join(', ');
