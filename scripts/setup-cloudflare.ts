#!/usr/bin/env npx tsx
/**
 * CLI: npx tsx scripts/setup-cloudflare.ts
 *
 * Requires:
 *   CF_API_TOKEN (or CLOUDFLARE_API_TOKEN)
 *   CLOUDFLARE_ZONE_ID
 */
import { setupCloudflare } from "../server/lib/cloudflare/setup-all";

async function main() {
  try {
    const result = await setupCloudflare();

    console.log("\n══════════════════════════════════════════════");
    console.log("  CLOUDFLARE SETUP COMPLETE");
    console.log("══════════════════════════════════════════════");
    console.log(JSON.stringify(result.validation, null, 2));

    if (!result.validation.allPassed) {
      console.error("\n[!] Some non-critical checks did not pass.");
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error("\n[FATAL]", (err as Error).message);
    process.exit(1);
  }
}

main();
