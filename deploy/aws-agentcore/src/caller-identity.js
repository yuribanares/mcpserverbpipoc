// caller-identity.js — "which partner is calling?" from its login token.
//
// Only used when PARTNER_AUTH_MODE=jwt (production). AgentCore already checks
// the partner's Cognito token at the front door; if the runtime is configured
// to pass the "Authorization" header through (scripts/05 does this in jwt
// mode), we verify the token again here (defence in depth) and map its
// client_id to a partner in the registry.
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export function createCallerIdentity(settings, log) {
  if (settings.partnerAuthMode !== 'jwt') return { partnerFromRequest: async () => null };

  // clientId: null = accept any app client of this user pool; we check the
  // client against our own partner map below instead.
  const verifier = CognitoJwtVerifier.create({ userPoolId: settings.cognitoUserPoolId, tokenUse: 'access', clientId: null });

  return {
    verifier, // exposed for tests
    // Returns the partnerId, or null if there is no usable token.
    async partnerFromRequest(req, clientToPartner) {
      const header = req.get?.('authorization') || req.headers?.authorization || '';
      const token = header.replace(/^Bearer\s+/i, '');
      if (!token) return null;
      try {
        const claims = await verifier.verify(token);
        const partnerId = clientToPartner[claims.client_id] || null;
        if (!partnerId) log({ level: 'err', text: `Token is valid but its client_id is not mapped to any partner (add it to PARTNER_JWT_CLIENT_MAP).` });
        return partnerId;
      } catch (err) {
        log({ level: 'err', text: `Partner token rejected: ${err.message}` });
        return null;
      }
    },
  };
}
