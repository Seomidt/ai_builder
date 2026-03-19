/**
 * Phase 50 — Analytics Foundation
 * Daily Rollup Runner Script
 *
 * Run manually or via cron/scheduler.
 * Usage: npx tsx scripts/run-analytics-rollups.ts [YYYY-MM-DD]
 */

import { aggregateDailyAnalyticsRollups } from "../server/lib/analytics/rollups";

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  let targetDate: Date;

  if (dateArg) {
    targetDate = new Date(dateArg);
    if (isNaN(targetDate.getTime())) {
      console.error(`[rollup-runner] Invalid date argument: ${dateArg}`);
      process.exit(1);
    }
  } else {
    targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() - 1);
  }

  const dateStr = targetDate.toISOString().slice(0, 10);
  console.log(`[rollup-runner] Running rollup for: ${dateStr}`);

  await aggregateDailyAnalyticsRollups(targetDate);

  console.log(`[rollup-runner] Done.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[rollup-runner] Fatal:", err);
  process.exit(1);
});
