/**
 * Phase 4C Runtime Validation
 * Run with: npx tsx scripts/validate-phase4c.ts
 */
import { checkWalletHardLimit, attemptWalletDebitReturningResult, getTenantCreditBalance, ensureTenantCreditAccount, grantTenantCredits } from "../server/lib/ai/wallet";
import { getBillingHealthSummary } from "../server/lib/ai/billing-observability";
import { startReconciliationRun, completeReconciliationRun, insertReconciliationDelta, getReconciliationRunsForProvider } from "../server/lib/ai/provider-reconciliation";
import { getReconciliationHealthSummary } from "../server/lib/ai/provider-reconciliation-summary";
import { getReconciliationRetentionSql } from "../server/lib/ai/provider-reconciliation-retention";
import { getPendingOrFailedWalletDebits } from "../server/lib/ai/wallet-replay";
import { AiWalletLimitError } from "../server/lib/ai/errors";

async function run() {
  console.log("=== Phase 4C Runtime Validation ===");
  let pass = 0; let fail = 0;

  // T1: Hard limit blocks tenant with no credit account (balance=0, hard_limit=0)
  try {
    await checkWalletHardLimit({
      tenantId: "test-no-account-xyz-" + Date.now(),
      meta: { feature: "test", model: "gpt-4o", latencyMs: 0 },
    });
    console.log("FAIL T1: should have thrown AiWalletLimitError"); fail++;
  } catch (e: any) {
    if (e instanceof AiWalletLimitError) {
      console.log("PASS T1 (hard limit blocks tenant with no credits):", e.constructor.name); pass++;
    } else {
      console.log("FAIL T1 unexpected error:", e.message); fail++;
    }
  }

  // T2: Billing health summary returns valid shape
  const health = await getBillingHealthSummary();
  if (typeof health.totalBillingRows === "number") {
    console.log(`PASS T2 (billing health): total=${health.totalBillingRows} pending=${health.walletPendingCount} failed=${health.walletFailedCount} debited=${health.walletDebitedCount}`); pass++;
  } else {
    console.log("FAIL T2: invalid summary", health); fail++;
  }

  // T3a-c: Reconciliation run lifecycle
  const runId = await startReconciliationRun({ provider: "openai", periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-03-12") });
  if (runId) { console.log("PASS T3a (create recon run):", runId.slice(0, 8)); pass++; }
  else { console.log("FAIL T3a: no runId returned"); fail++; }

  const deltaId = await insertReconciliationDelta({
    runId, provider: "openai", metricType: "provider_cost_delta",
    internalValue: 10.5, externalValue: 11.0, deltaValue: 0.5,
    severity: "warning", notes: "phase4c test delta",
  });
  if (deltaId) { console.log("PASS T3b (insert delta):", deltaId.slice(0, 8)); pass++; }
  else { console.log("FAIL T3b: no deltaId returned"); fail++; }

  await completeReconciliationRun(runId, "test complete");
  const runs = await getReconciliationRunsForProvider("openai", 1);
  if (runs.length > 0 && runs[0].status === "completed") {
    console.log("PASS T3c (run.status=completed)"); pass++;
  } else {
    console.log("FAIL T3c: run not found or wrong status", runs[0]?.status); fail++;
  }

  // T4: Reconciliation health summary
  const reconHealth = await getReconciliationHealthSummary();
  if (typeof reconHealth.totalRuns === "number" && reconHealth.totalRuns > 0) {
    console.log(`PASS T4 (recon health): runs=${reconHealth.totalRuns} completed=${reconHealth.completedRuns} deltas=${reconHealth.totalDeltas}`); pass++;
  } else {
    console.log("FAIL T4:", reconHealth); fail++;
  }

  // T5: Retention SQL generator returns 3 SQL strings with correct window
  const retentionSql = getReconciliationRetentionSql(180);
  const sqlOk = retentionSql.previewSql.includes("180 days") &&
    retentionSql.cleanupDeltaSql.includes("180 days") &&
    retentionSql.cleanupRunSql.includes("180 days");
  console.log(sqlOk ? "PASS T5 (retention SQL: 3 statements, 180-day window)" : "FAIL T5: missing 180 days"); sqlOk ? pass++ : fail++;

  // T6: getPendingOrFailedWalletDebits returns without error
  const pending = await getPendingOrFailedWalletDebits(10);
  console.log(`PASS T6 (getPendingOrFailedWalletDebits): ${pending.length} pending/failed rows`); pass++;

  // T7: Tenant with sufficient balance passes hard-limit check
  const tenantId = "test-hl-pass-" + Date.now();
  const accountId = await ensureTenantCreditAccount(tenantId);
  await grantTenantCredits({ tenantId, accountId, amountUsd: 50.0, grantType: "manual", createdBy: "test" });
  try {
    await checkWalletHardLimit({ tenantId, meta: { feature: "test", model: "gpt-4o", latencyMs: 0 } });
    console.log("PASS T7 (hard limit allows tenant with 50 USD balance)"); pass++;
  } catch (e: any) {
    console.log("FAIL T7:", e.message); fail++;
  }

  console.log(`\n=== RESULTS: ${pass} PASS / ${fail} FAIL / ${pass + fail} TOTAL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e: any) => { console.error("FATAL:", e.message); process.exit(1); });
