import { setupSSL } from "./setup-ssl";
import { verifyProxyEnabled } from "./verify-dns";
import { setupWAF } from "./setup-waf";
import { setupRateLimits } from "./setup-rate-limits";
import { setupCache } from "./setup-cache";
import { validateCloudflare, CloudflareValidationReport } from "./validate-cloudflare";

export interface SetupResult {
  ssl: Awaited<ReturnType<typeof setupSSL>>;
  dns: Awaited<ReturnType<typeof verifyProxyEnabled>>;
  waf: Awaited<ReturnType<typeof setupWAF>>;
  rateLimits: Awaited<ReturnType<typeof setupRateLimits>>;
  cache: Awaited<ReturnType<typeof setupCache>>;
  validation: CloudflareValidationReport;
}

export async function setupCloudflare(): Promise<SetupResult> {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     PHASE CF-ENTERPRISE — Cloudflare Edge Hardening     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Step 1 — SSL & Transport Hardening
  console.log("── STEP 1: SSL & Transport Hardening ──");
  const ssl = await setupSSL();

  // Step 2 — DNS Proxy Verification
  console.log("\n── STEP 2: DNS Proxy Verification ──");
  const dns = await verifyProxyEnabled();

  // Step 3 — WAF (managed + custom rules)
  console.log("\n── STEP 3: WAF Rules ──");
  const waf = await setupWAF();

  // Step 4 — Edge Rate Limiting
  console.log("\n── STEP 4: Rate Limits ──");
  const rateLimits = await setupRateLimits();

  // Step 5 — Cache Rules
  console.log("\n── STEP 5: Cache Rules ──");
  const cache = await setupCache();

  // Step 6 — Full Validation
  console.log("\n── STEP 6: Validation ──");
  const validation = await validateCloudflare();

  // Critical checks: SSL + HTTPS + HSTS are non-negotiable
  const criticalPassed = validation.ssl && validation.https && validation.hsts;
  if (!criticalPassed) {
    throw new Error(
      `[CF] Critical checks failed — ssl:${validation.ssl} https:${validation.https} hsts:${validation.hsts}`
    );
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Phase CF-Enterprise complete. Critical checks: PASSED  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  return { ssl, dns, waf, rateLimits, cache, validation };
}
