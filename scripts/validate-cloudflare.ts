#!/usr/bin/env npx tsx
/**
 * CLI: npx tsx scripts/validate-cloudflare.ts
 *
 * Validates live Cloudflare configuration via API.
 * Exit 0 = all critical checks pass.
 * Exit 1 = one or more critical checks fail.
 *
 * Critical checks:
 *   ssl=strict, https=on, hsts, dns proxied,
 *   Cloudflare Managed Rules, OWASP Core,
 *   auth rate limit, AI rate limit
 */
import { validateCloudflare } from "../server/lib/cloudflare/validate-cloudflare";

async function main() {
  try {
    const report = await validateCloudflare();

    console.log("══════════════════════════════════════════════════════");
    console.log("  CLOUDFLARE PRO VALIDATION REPORT — blissops.com");
    console.log("══════════════════════════════════════════════════════\n");

    const ok = (v: boolean | string) =>
      (v === true || v === "ok") ? "  ✔" : "  ✗";

    console.log("Transport Security:");
    console.log(`${ok(report.ssl)}  SSL mode = strict`);
    console.log(`${ok(report.https)}  Always HTTPS redirect`);
    console.log(`${ok(report.hsts)}  HSTS (max_age 15.5M s, include_subdomains)`);
    console.log(`${ok(report.dns)}  DNS records proxied (orange-cloud)`);

    console.log("\nManaged WAF Rules:");
    console.log(`${ok(report.managedRules.cloudflareManaged === "ok")}  Cloudflare Managed Ruleset`);
    console.log(`${ok(report.managedRules.owaspCore === "ok")}  OWASP Core Ruleset`);

    console.log("\nCustom WAF Rules:");
    if (report.customWafRules.length === 0) {
      console.log("  (none)");
    } else {
      for (const r of report.customWafRules) {
        console.log(`  ✔  ${r.description} [${r.action}]`);
      }
    }

    console.log("\nEdge Rate Limits:");
    console.log(`${ok(report.rateLimits.auth === "ok")}  AUTH /api/auth — 10 req/60s → block`);
    console.log(`${ok(report.rateLimits.ai === "ok")}  AI   /api/ai  — 20 req/60s → block`);
    console.log(`     Total: ${report.rateLimits.total} rule(s) (Pro plan max: 2)`);

    console.log("\nCache Rules:");
    console.log(`${ok(report.cache)}  Static assets (30d) + /api/* bypass`);

    console.log("\nWAF Skip Rules (exceptions):");
    if (report.skips.length === 0) {
      console.log("  (none)");
    } else {
      for (const s of report.skips) {
        console.log(`  ✔  ${s.description}`);
      }
    }

    console.log("\n══════════════════════════════════════════════════════");

    if (report.criticalPassed) {
      console.log("  CRITICAL CHECKS: ALL PASSED ✔");
    } else {
      console.log("  CRITICAL CHECKS: FAILED ✗");
    }

    if (report.allPassed) {
      console.log("  OVERALL: ALL PASSED ✔");
    } else {
      console.log("  OVERALL: SOME NON-CRITICAL ITEMS PENDING");
    }

    console.log("══════════════════════════════════════════════════════\n");

    // Exit 1 if any critical protection is missing
    process.exit(report.criticalPassed ? 0 : 1);
  } catch (err) {
    console.error("\n[FATAL]", (err as Error).message);
    process.exit(1);
  }
}

main();
