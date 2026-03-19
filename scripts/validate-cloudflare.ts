#!/usr/bin/env npx tsx
/**
 * CLI: npx tsx scripts/validate-cloudflare.ts
 *
 * Use in CI to verify Cloudflare configuration is correct.
 *
 * Requires:
 *   CF_API_TOKEN (or CLOUDFLARE_API_TOKEN)
 *   CLOUDFLARE_ZONE_ID
 */
import { validateCloudflare } from "../server/lib/cloudflare/validate-cloudflare";

async function main() {
  try {
    const report = await validateCloudflare();

    console.log("\n══════════════════════════════════════════════");
    console.log("  CLOUDFLARE VALIDATION REPORT");
    console.log("══════════════════════════════════════════════");

    const checks: Array<[keyof typeof report, string]> = [
      ["ssl", "SSL mode = strict"],
      ["https", "Always HTTPS enabled"],
      ["hsts", "HSTS enabled"],
      ["dns", "DNS proxied (orange-cloud)"],
      ["waf", "WAF custom rules active"],
      ["rateLimits", "Edge rate limits active"],
      ["cache", "Cache rules configured"],
    ];

    for (const [key, label] of checks) {
      const ok = report[key] as boolean;
      const icon = ok ? "✔" : "✗";
      console.log(`  [${icon}] ${label}`);
    }

    console.log("\n  Details:");
    console.log(JSON.stringify(report.details, null, 4));

    console.log("\n══════════════════════════════════════════════");
    if (report.allPassed) {
      console.log("  RESULT: ALL CHECKS PASSED ✔");
      process.exit(0);
    } else {
      console.log("  RESULT: SOME CHECKS FAILED ✗");
      process.exit(1);
    }
  } catch (err) {
    console.error("\n[FATAL]", (err as Error).message);
    process.exit(1);
  }
}

main();
