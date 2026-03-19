import { setupSSL } from "./setup-ssl";
import { verifyProxyEnabled } from "./verify-dns";
import { setupWAFManagedRules, setupCustomWAFRules, WafSetupResult } from "./setup-waf";
import { setupSkipRules } from "./setup-skips";
import { setupRateLimits } from "./setup-rate-limits";
import { setupCache } from "./setup-cache";
import { validateCloudflare, CloudflareValidationReport } from "./validate-cloudflare";

export interface SetupResult {
  ssl: Awaited<ReturnType<typeof setupSSL>>;
  dns: Awaited<ReturnType<typeof verifyProxyEnabled>>;
  managedRules: Awaited<ReturnType<typeof setupWAFManagedRules>>;
  customWaf: number;
  skips: Awaited<ReturnType<typeof setupSkipRules>>;
  rateLimits: Awaited<ReturnType<typeof setupRateLimits>>;
  cache: Awaited<ReturnType<typeof setupCache>>;
  validation: CloudflareValidationReport;
}

export async function setupCloudflare(): Promise<SetupResult> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   PHASE CF-PRO-OPTIMIZATION — Cloudflare Pro Hardening     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Step 1 — SSL & Transport Hardening
  console.log("── STEP 1: SSL & Transport Hardening ──");
  const ssl = await setupSSL();

  // Step 2 — DNS Proxy Verification
  console.log("\n── STEP 2: DNS Proxy Verification ──");
  const dns = await verifyProxyEnabled();

  // Step 3 — Managed WAF Rules (Cloudflare Managed + OWASP)
  console.log("\n── STEP 3: Managed WAF Rules ──");
  const managedRules = await setupWAFManagedRules();

  // Step 4 — Custom WAF Rules (auth/ai/geo — path-specific, not in managed rules)
  console.log("\n── STEP 4: Custom WAF Rules ──");
  const customWaf = await setupCustomWAFRules();

  // Step 5 — Skip Rules (CSP reports, Stripe webhooks — machine POSTs that cannot complete challenge)
  console.log("\n── STEP 5: Skip Rules (WAF exceptions) ──");
  const skips = await setupSkipRules();

  // Step 6 — Edge Rate Limiting (2 Pro slots: AUTH + AI)
  console.log("\n── STEP 6: Edge Rate Limits ──");
  const rateLimits = await setupRateLimits();

  // Step 7 — Cache Rules
  console.log("\n── STEP 7: Cache Rules ──");
  const cache = await setupCache();

  // Step 8 — Full Validation
  console.log("\n── STEP 8: Validation ──");
  const validation = await validateCloudflare();

  // Critical checks — fail hard if any are missing
  const criticalChecks: Array<[string, boolean]> = [
    ["ssl", validation.ssl],
    ["https", validation.https],
    ["hsts", validation.hsts],
    ["dns", validation.dns],
    ["managedRules.cloudflareManaged", validation.managedRules.cloudflareManaged === "ok"],
    ["managedRules.owaspCore", validation.managedRules.owaspCore === "ok"],
    ["rateLimits.auth", validation.rateLimits.auth === "ok"],
    ["rateLimits.ai", validation.rateLimits.ai === "ok"],
  ];

  const failed = criticalChecks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    const list = failed.map(([name]) => name).join(", ");
    throw new Error(`[CF] Critical checks failed: ${list}`);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Phase CF-Pro-Optimization complete. All critical: PASSED  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  return { ssl, dns, managedRules, customWaf, skips, rateLimits, cache, validation };
}
