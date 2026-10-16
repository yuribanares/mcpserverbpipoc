// settings.js — every setting the AWS-hosted BPI MCP Server reads, in one place.
//
// Values come from environment variables. On AWS they are set on the AgentCore
// Runtime by scripts/05-create-agentcore-runtime.sh, copied from
// config/demo.env (demo) or config/production.env (production).
// Anything not set falls back to a safe default shown below.

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

export function loadSettings(env = process.env) {
  const s = {
    // Port + path are fixed by AgentCore's MCP contract (0.0.0.0:8000/mcp).
    // PORT may be changed only for local testing.
    port: Number(env.PORT || 8000),
    region: env.AWS_REGION || 'ap-southeast-1',

    // Where the BPI Open Banking API lives: the Lightsail mock bank (demo) or
    // the real BPI API gateway (production).
    bpiApiUrl: (env.BPI_API_URL || 'http://localhost:4000').replace(/\/+$/, ''),

    // Partner registry (BPI's vault): 'builtin' = the demo partners in
    // server/bpi-mcp-server.js; 'secretsmanager' = load from AWS Secrets Manager.
    registrySource: (env.PARTNER_REGISTRY_SOURCE || 'builtin').toLowerCase(),
    registrySecretId: env.PARTNER_REGISTRY_SECRET_ID || '',

    // How the partner proves who it is *inside* the server:
    //   'tool' = the bpi_partner_authenticate tool with clientId/clientSecret (demo, same as the PoC)
    //   'jwt'  = read the partner from its verified Cognito token (production)
    partnerAuthMode: (env.PARTNER_AUTH_MODE || 'tool').toLowerCase(),
    cognitoUserPoolId: env.COGNITO_USER_POOL_ID || '',
    // JSON map of Cognito app-client id -> partnerId, e.g. {"4abc...":"dragonpay"}
    jwtClientMap: env.PARTNER_JWT_CLIENT_MAP || '',

    // Where login sessions are kept: 'memory' (demo) or 'dynamodb' (production).
    sessionStore: (env.SESSION_STORE || 'memory').toLowerCase(),
    sessionTableName: env.SESSION_TABLE_NAME || '',

    // Demo-only: send the server's terminal lines back with each result so the
    // demo UI can show them. Keep OFF in production (logs go to CloudWatch).
    echoLogs: bool(env.ECHO_LOGS, false),

    // BPI request signing (JWE/JWT) from the API contract. Not built in this PoC.
    messageSigning: (env.BPI_MESSAGE_SIGNING || 'off').toLowerCase(),
  };

  const problems = [];
  if (!['builtin', 'secretsmanager'].includes(s.registrySource)) problems.push('PARTNER_REGISTRY_SOURCE must be "builtin" or "secretsmanager".');
  if (s.registrySource === 'secretsmanager' && !s.registrySecretId) problems.push('PARTNER_REGISTRY_SECRET_ID is required when PARTNER_REGISTRY_SOURCE=secretsmanager.');
  if (!['tool', 'jwt'].includes(s.partnerAuthMode)) problems.push('PARTNER_AUTH_MODE must be "tool" or "jwt".');
  if (s.partnerAuthMode === 'jwt' && !s.cognitoUserPoolId) problems.push('COGNITO_USER_POOL_ID is required when PARTNER_AUTH_MODE=jwt.');
  if (!['memory', 'dynamodb'].includes(s.sessionStore)) problems.push('SESSION_STORE must be "memory" or "dynamodb".');
  if (s.sessionStore === 'dynamodb' && !s.sessionTableName) problems.push('SESSION_TABLE_NAME is required when SESSION_STORE=dynamodb.');
  if (s.messageSigning !== 'off') problems.push('BPI_MESSAGE_SIGNING is a placeholder: request signing is not built yet. Leave it "off" (see docs/5-go-to-production.md).');
  if (s.jwtClientMap) {
    try { s.jwtClientMap = JSON.parse(s.jwtClientMap); } catch { problems.push('PARTNER_JWT_CLIENT_MAP must be valid JSON, e.g. {"<cognito-client-id>":"dragonpay"}.'); }
  } else s.jwtClientMap = {};
  if (problems.length) {
    const err = new Error('Invalid settings:\n  - ' + problems.join('\n  - '));
    err.problems = problems;
    throw err;
  }
  return s;
}

// A one-line, secret-free summary for the startup log.
export function describeSettings(s) {
  return `bank=${s.bpiApiUrl} registry=${s.registrySource} partnerAuth=${s.partnerAuthMode} ` +
    `sessions=${s.sessionStore} echoLogs=${s.echoLogs} region=${s.region}`;
}
