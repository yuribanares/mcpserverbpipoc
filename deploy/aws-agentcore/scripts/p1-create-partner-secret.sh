#!/usr/bin/env bash
# p1-create-partner-secret.sh — PRODUCTION: store the partner registry (BPI's
# vault) in AWS Secrets Manager.
#
#   1. cp config/partner-registry.example.json config/partner-registry.json
#   2. Put the REAL values in config/partner-registry.json (git-ignored)
#   3. ./scripts/p1-create-partner-secret.sh
#   4. Delete config/partner-registry.json from your machine afterwards —
#      from now on the only copy lives, encrypted, in Secrets Manager.
#
# Uses PARTNER_REGISTRY_SECRET_ID from config/production.env as the name.
# Re-running updates the secret (the server picks it up within 10 minutes).
source "$(dirname "$0")/lib/common.sh"
title "Production — store the partner registry in AWS Secrets Manager"
file="${1:-$CONFIG_DIR/partner-registry.json}"
name="${PARTNER_REGISTRY_SECRET_ID:-}"
[[ -n "$name" ]] || die "PARTNER_REGISTRY_SECRET_ID is not set." "Set it in config/production.env and PROFILE=production in deploy-settings.env."
[[ -f "$file" ]] || die "No registry file at $file." "cp config/partner-registry.example.json config/partner-registry.json and fill it in."

step "Check the file"
node --input-type=module -e '
  import fs from "node:fs";
  try {
    const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const need = ["partnerId","displayName","bpiClientId","bpiClientSecret","scopes"];
    for (const [id, t] of Object.entries(reg)) {
      const missing = need.filter((k) => !t[k]);
      if (missing.length) throw new Error(`Partner ${id} is missing: ${missing.join(", ")}`);
      if (JSON.stringify(t).includes("REPLACE-")) throw new Error(`Partner ${id} still has REPLACE-… placeholder values`);
    }
    console.log(`  ✅ ${Object.keys(reg).length} partner(s) look complete`);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }
' "$file" || die "The registry file isn't ready." "Fix the problem above and run again."

step "Save it as secret \"$name\""
if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$name" --secret-string "file://$file" >/dev/null
  ok "Secret updated"
else
  aws secretsmanager create-secret --name "$name" --description "BPI MCP Server partner registry" --secret-string "file://$file" >/dev/null
  ok "Secret created"
fi
save_output CREATED_SECRET_ID "$name"
console_hint "https://${AWS_REGION}.console.aws.amazon.com/secretsmanager/secret?name=$name"
warn "Now delete the local copy: rm $file"
info "Then re-run ./scripts/03-create-permissions.sh and ./scripts/05-create-agentcore-runtime.sh"
