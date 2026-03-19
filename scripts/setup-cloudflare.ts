#!/usr/bin/env npx tsx
/**
 * CLI: npx tsx scripts/setup-cloudflare.ts
 *
 * Runs full Cloudflare Pro hardening setup:
 *   1. SSL strict + HSTS + TLS 1.2+
 *   2. DNS proxy verification
 *   3. Cloudflare Managed Rules + OWASP Core
 *   4. Custom WAF rules (auth/ai/geo)
 *   5. Skip rules (CSP reports, Stripe webhooks)
 *   6. Edge rate limits (AUTH + AI — 2 Pro slots)
 *   7. Cache rules (static 30d, /api/* bypass)
 *   8. Validation
 *
 * Requires:
 *   CLOUDFLARE_GLOBAL_API_KEY  — Cloudflare Global API Key (37 chars)
 *   CLOUDFLARE_EMAIL           — Cloudflare account email
 *   CLOUDFLARE_ZONE_ID         — Zone ID from dashboard → Overview
 */
import { setupCloudflare } from "../server/lib/cloudflare/setup-all";

async function main() {
  try {
    const result = await setupCloudflare();

    console.log("\n══════════════════════════════════════════════════════");
    console.log("  CLOUDFLARE PRO SETUP — FINAL REPORT");
    console.log("══════════════════════════════════════════════════════\n");

    const v = result.validation;
    console.log(`  ssl:            ${v.ssl ? "✔" : "✗"}`);
    console.log(`  https:          ${v.https ? "✔" : "✗"}`);
    console.log(`  hsts:           ${v.hsts ? "✔" : "✗"}`);
    console.log(`  dns:            ${v.dns ? "✔" : "✗"}`);
    console.log(`  managedRules:   cf=${v.managedRules.cloudflareManaged} owasp=${v.managedRules.owaspCore}`);
    console.log(`  rateLimits:     auth=${v.rateLimits.auth} ai=${v.rateLimits.ai} (${v.rateLimits.total}/2)`);
    console.log(`  cache:          ${v.cache ? "✔" : "✗"}`);
    console.log(`  customWaf:      ${v.customWafRules.length} rules`);
    console.log(`  skips:          ${v.skips.length} exemptions`);

    console.log("\n══════════════════════════════════════════════════════");
    console.log(v.criticalPassed ? "  CRITICAL: ALL PASSED ✔" : "  CRITICAL: FAILED ✗");
    console.log("══════════════════════════════════════════════════════\n");

    process.exit(v.criticalPassed ? 0 : 1);
  } catch (err) {
    console.error("\n[FATAL]", (err as Error).message);
    process.exit(1);
  }
}

main();
