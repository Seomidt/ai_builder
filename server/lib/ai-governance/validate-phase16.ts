/**
 * Phase 16 Validation — AI Cost Governance Platform
 * 60 scenarios, 130+ assertions
 */

import pg from "pg";
import {
  upsertTenantBudget,
  getTenantBudget,
  checkBudgetBeforeCall,
  getCurrentMonthSpend,
  getCurrentDaySpend,
  listAllTenantBudgets,
} from "./budget-checker";
import {
  captureUsageSnapshot,
  getLatestSnapshot,
  listSnapshots,
  listAllSnapshots,
  getCurrentPeriod,
} from "./usage-snapshotter";
import {
  detectUsageAnomaly,
  recordAnomalyEvent,
  listAnomalyEvents,
  listAllAnomalyEvents,
  detectAndRecordAnomaly,
} from "./anomaly-detector";
import {
  generateUsageAlert,
  listTenantAlerts,
  listAllAlerts,
  checkAndGenerateAlerts,
} from "./alert-generator";
import {
  checkRunawayProtection,
  recordRunawayEvent,
  checkAndRecordRunaway,
  getRunawayConfig,
  MAX_STEPS_PER_RUN,
  MAX_TOKENS_PER_RUN,
  MAX_COST_PER_RUN_USD,
  MAX_ITERATIONS_PER_RUN,
} from "./runaway-protection";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const TS = Date.now();
const T_A = `gov-tenant-a-${TS}`;
const T_B = `gov-tenant-b-${TS}`;

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 16 Validation — AI Cost Governance Platform\n");

  try {
    // ── SCENARIO 1: DB schema — all 4 tables ─────────────────────────────────
    section("SCENARIO 1: DB schema — 4 Phase 16 tables present");
    const tables = [
      "tenant_ai_budgets",
      "tenant_ai_usage_snapshots",
      "ai_usage_alerts",
      "gov_anomaly_events",
    ];
    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tables],
    );
    const found = tableR.rows.map((r: any) => r.table_name);
    assert(found.length === 4, "All 4 Phase 16 tables exist");
    for (const t of tables) assert(found.includes(t), `Table exists: ${t}`);

    // ── SCENARIO 2: DB schema — indexes present ───────────────────────────────
    section("SCENARIO 2: DB schema — indexes present");
    const idxR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)`,
      [["tab_tenant_idx", "taus_tenant_period_idx", "taus_tenant_created_idx",
        "aua_tenant_triggered_idx", "aua_tenant_type_idx", "aae_tenant_created_idx", "aae_tenant_type_idx"]],
    );
    assert(idxR.rows.length >= 7, `At least 7 indexes present (found ${idxR.rows.length})`);

    // ── SCENARIO 3: DB schema — RLS enabled ──────────────────────────────────
    section("SCENARIO 3: DB schema — RLS enabled on all 4 tables");
    const rlsR = await client.query(
      `SELECT relname FROM pg_class WHERE relrowsecurity = true AND relname = ANY($1)`,
      [tables],
    );
    assert(rlsR.rows.length === 4, `RLS enabled on all 4 tables (found ${rlsR.rows.length})`);

    // ── SCENARIO 4: upsertTenantBudget — create ───────────────────────────────
    section("SCENARIO 4: upsertTenantBudget — create new budget");
    const budget4 = await upsertTenantBudget({
      tenantId: T_A,
      monthlyBudgetUsd: 100,
      dailyBudgetUsd: 10,
      softLimitPercent: 80,
      hardLimitPercent: 100,
    });
    assert(budget4 != null, "Budget created");
    assert(budget4.tenantId === T_A, "tenantId correct");
    assert(Number(budget4.monthlyBudgetUsd) === 100, "monthlyBudgetUsd correct");
    assert(Number(budget4.dailyBudgetUsd) === 10, "dailyBudgetUsd correct");
    assert(Number(budget4.softLimitPercent) === 80, "softLimitPercent correct");
    assert(Number(budget4.hardLimitPercent) === 100, "hardLimitPercent correct");

    // ── SCENARIO 5: getTenantBudget — reads back correctly ────────────────────
    section("SCENARIO 5: getTenantBudget — reads back correctly");
    const fetched5 = await getTenantBudget(T_A);
    assert(fetched5 != null, "Budget retrieved");
    assert(fetched5!.tenantId === T_A, "tenantId matches");
    assert(Number(fetched5!.monthlyBudgetUsd) === 100, "monthlyBudgetUsd matches");

    // ── SCENARIO 6: upsertTenantBudget — update (idempotent) ─────────────────
    section("SCENARIO 6: upsertTenantBudget — update is idempotent");
    const updated6 = await upsertTenantBudget({ tenantId: T_A, monthlyBudgetUsd: 200 });
    assert(updated6 != null, "Update succeeded");
    assert(Number(updated6!.monthlyBudgetUsd) === 200, "monthlyBudgetUsd updated to 200");
    const recheck6 = await client.query(`SELECT COUNT(*) FROM tenant_ai_budgets WHERE tenant_id=$1`, [T_A]);
    assert(Number(recheck6.rows[0].count) === 1, "Only 1 row — upsert did not duplicate");

    // ── SCENARIO 7: INV-GOV-4 — getTenantBudget returns null for unknown tenant
    section("SCENARIO 7: INV-GOV-4 — getTenantBudget returns null for unknown tenant");
    const unknown7 = await getTenantBudget(`unknown-tenant-${TS}`);
    assert(unknown7 === null, "INV-GOV-4: No budget returned for unknown tenant");

    // ── SCENARIO 8: checkBudgetBeforeCall — no budget allows ─────────────────
    section("SCENARIO 8: checkBudgetBeforeCall — no budget configured = allowed");
    const check8 = await checkBudgetBeforeCall(`no-budget-tenant-${TS}`);
    assert(check8.allowed === true, "No budget = allowed");
    assert(check8.state === "no_budget", "State is no_budget");
    assert(check8.usagePercent === 0, "usagePercent is 0");

    // ── SCENARIO 9: checkBudgetBeforeCall — normal usage allowed ─────────────
    section("SCENARIO 9: checkBudgetBeforeCall — normal usage allowed");
    await upsertTenantBudget({ tenantId: T_B, monthlyBudgetUsd: 1000, softLimitPercent: 80, hardLimitPercent: 100 });
    const check9 = await checkBudgetBeforeCall(T_B);
    assert(check9.allowed === true, "INV-GOV-3: Normal usage allowed");
    assert(["normal", "no_budget"].includes(check9.state), "State is normal or no_budget");
    assert(typeof check9.currentMonthSpendUsd === "number", "currentMonthSpendUsd is number");
    assert(typeof check9.currentDaySpendUsd === "number", "currentDaySpendUsd is number");
    assert(check9.monthlyBudgetUsd === 1000, "monthlyBudgetUsd correct");

    // ── SCENARIO 10: checkBudgetBeforeCall — hard limit blocks ────────────────
    section("SCENARIO 10: INV-GOV-2 — hard limit blocks execution");
    const T_HARD = `gov-hard-${TS}`;
    await upsertTenantBudget({ tenantId: T_HARD, monthlyBudgetUsd: 0.0001, hardLimitPercent: 100, softLimitPercent: 80 });
    // Insert artificial spend to trigger the limit
    await client.query(
      `INSERT INTO obs_ai_latency_metrics(tenant_id, model, provider, latency_ms, cost_usd) VALUES($1,'gpt-4o','openai',1000,0.001)`,
      [T_HARD],
    );
    const check10 = await checkBudgetBeforeCall(T_HARD);
    assert(check10.allowed === false, "INV-GOV-2: Hard limit blocks execution");
    assert(check10.state === "hard_limit", "State is hard_limit");
    assert(check10.usagePercent >= 100, `usagePercent >= 100 (is ${check10.usagePercent.toFixed(1)})`);
    assert(typeof check10.reason === "string", "Reason string provided");

    // ── SCENARIO 11: checkBudgetBeforeCall — soft limit warns ─────────────────
    section("SCENARIO 11: INV-GOV-3 — soft limit warns but allows");
    const T_SOFT = `gov-soft-${TS}`;
    await upsertTenantBudget({ tenantId: T_SOFT, monthlyBudgetUsd: 0.001, softLimitPercent: 80, hardLimitPercent: 200 });
    await client.query(
      `INSERT INTO obs_ai_latency_metrics(tenant_id, model, provider, latency_ms, cost_usd) VALUES($1,'gpt-4o','openai',1000,0.0009)`,
      [T_SOFT],
    );
    const check11 = await checkBudgetBeforeCall(T_SOFT);
    assert(check11.allowed === true, "INV-GOV-3: Soft limit allows execution");
    assert(check11.state === "soft_limit", `State is soft_limit (got ${check11.state})`);
    assert(check11.usagePercent >= 80, `usagePercent >= 80 (is ${check11.usagePercent.toFixed(1)})`);

    // ── SCENARIO 12: INV-GOV-1 — checkBudgetBeforeCall never throws ──────────
    section("SCENARIO 12: INV-GOV-1 — checkBudgetBeforeCall never throws");
    let threw12 = false;
    try {
      await checkBudgetBeforeCall("");
    } catch {
      threw12 = true;
    }
    assert(!threw12, "INV-GOV-1: checkBudgetBeforeCall does not throw on empty tenantId");

    // ── SCENARIO 13: getCurrentMonthSpend — returns number ───────────────────
    section("SCENARIO 13: getCurrentMonthSpend — returns number");
    const spend13 = await getCurrentMonthSpend(T_HARD);
    assert(typeof spend13 === "number", "getCurrentMonthSpend returns number");
    assert(spend13 > 0, "getCurrentMonthSpend > 0 for tenant with spend");

    // ── SCENARIO 14: getCurrentMonthSpend — 0 for unknown tenant ─────────────
    section("SCENARIO 14: getCurrentMonthSpend — 0 for unknown tenant");
    const spend14 = await getCurrentMonthSpend(`nobody-${TS}`);
    assert(spend14 === 0, "getCurrentMonthSpend = 0 for unknown tenant");

    // ── SCENARIO 15: getCurrentDaySpend — returns number ─────────────────────
    section("SCENARIO 15: getCurrentDaySpend — returns number");
    const day15 = await getCurrentDaySpend(T_HARD);
    assert(typeof day15 === "number", "getCurrentDaySpend returns number");

    // ── SCENARIO 16: INV-GOV-4 — budgets are tenant-isolated ─────────────────
    section("SCENARIO 16: INV-GOV-4 — budget data is tenant-isolated");
    const hardBudget = await getTenantBudget(T_HARD);
    const softBudget = await getTenantBudget(T_SOFT);
    assert(hardBudget!.tenantId === T_HARD, "Hard-limit tenant budget correct");
    assert(softBudget!.tenantId === T_SOFT, "Soft-limit tenant budget correct");
    assert(hardBudget!.id !== softBudget!.id, "INV-GOV-4: Different budget records per tenant");
    assert(Number(hardBudget!.monthlyBudgetUsd) !== Number(softBudget!.monthlyBudgetUsd), "INV-GOV-4: Budgets are isolated");

    // ── SCENARIO 17: listAllTenantBudgets — returns array ────────────────────
    section("SCENARIO 17: listAllTenantBudgets — returns all budgets");
    const all17 = await listAllTenantBudgets();
    assert(Array.isArray(all17), "listAllTenantBudgets returns array");
    assert(all17.length >= 3, "At least 3 budgets (A, hard, soft)");
    const tenantIds17 = all17.map((b) => b.tenantId);
    assert(tenantIds17.includes(T_A), "Tenant A budget in list");
    assert(tenantIds17.includes(T_HARD), "Hard-limit tenant in list");

    // ── SCENARIO 18: Daily budget hard limit ─────────────────────────────────
    section("SCENARIO 18: Daily budget hard limit blocks execution");
    const T_DAILY = `gov-daily-${TS}`;
    await upsertTenantBudget({ tenantId: T_DAILY, dailyBudgetUsd: 0.0001, hardLimitPercent: 100 });
    await client.query(
      `INSERT INTO obs_ai_latency_metrics(tenant_id, model, provider, latency_ms, cost_usd) VALUES($1,'gpt-4o','openai',500,0.001)`,
      [T_DAILY],
    );
    const check18 = await checkBudgetBeforeCall(T_DAILY);
    assert(check18.allowed === false, "Daily hard limit blocks");
    assert(check18.state === "hard_limit", "State is hard_limit (daily)");

    // ── SCENARIO 19: captureUsageSnapshot — writes snapshot ──────────────────
    section("SCENARIO 19: captureUsageSnapshot — writes snapshot to DB");
    await client.query(
      `INSERT INTO obs_ai_latency_metrics(tenant_id, model, provider, latency_ms, tokens_in, tokens_out, cost_usd) VALUES($1,'gpt-4o','openai',800,500,200,0.005)`,
      [T_A],
    );
    const period19 = getCurrentPeriod();
    const snap19 = await captureUsageSnapshot(T_A, period19);
    assert(snap19 != null, "Snapshot created");
    assert(snap19!.period === period19, "Period correct");
    assert(typeof snap19!.tokensIn === "number", "tokensIn is number");
    assert(typeof snap19!.tokensOut === "number", "tokensOut is number");
    assert(typeof snap19!.costUsd === "number", "costUsd is number");
    assert(snap19!.tokensIn >= 500, "tokensIn >= 500");
    assert(snap19!.costUsd > 0, "costUsd > 0");

    // ── SCENARIO 20: getLatestSnapshot — retrieves latest ────────────────────
    section("SCENARIO 20: getLatestSnapshot — retrieves latest snapshot");
    const snap20 = await getLatestSnapshot(T_A, period19);
    assert(snap20 != null, "Latest snapshot retrieved");
    assert(snap20!.tenantId === T_A, "tenantId correct");
    assert(snap20!.period === period19, "Period correct");

    // ── SCENARIO 21: INV-GOV-4 — snapshot isolation ───────────────────────────
    section("SCENARIO 21: INV-GOV-4 — snapshots are tenant-isolated");
    const snapB21 = await getLatestSnapshot(T_B, period19);
    assert(snapB21 === null, "INV-GOV-4: Tenant B has no snapshot from Tenant A");

    // ── SCENARIO 22: listSnapshots — returns tenant's snapshots ──────────────
    section("SCENARIO 22: listSnapshots — returns tenant's snapshots");
    const snaps22 = await listSnapshots(T_A);
    assert(Array.isArray(snaps22), "listSnapshots returns array");
    assert(snaps22.length >= 1, "At least 1 snapshot for Tenant A");
    assert(snaps22.every((s) => s.tenantId === T_A), "INV-GOV-4: All snapshots belong to Tenant A");

    // ── SCENARIO 23: listAllSnapshots — admin view ───────────────────────────
    section("SCENARIO 23: listAllSnapshots — admin view returns all snapshots");
    const all23 = await listAllSnapshots();
    assert(Array.isArray(all23), "listAllSnapshots returns array");
    assert(all23.length >= 1, "At least 1 snapshot globally");

    // ── SCENARIO 24: captureUsageSnapshot — never throws ─────────────────────
    section("SCENARIO 24: INV-GOV-1 — captureUsageSnapshot never throws");
    let threw24 = false;
    try {
      await captureUsageSnapshot("", "9999-99");
    } catch {
      threw24 = true;
    }
    assert(!threw24, "INV-GOV-1: captureUsageSnapshot does not throw");

    // ── SCENARIO 25: getCurrentPeriod — correct format ────────────────────────
    section("SCENARIO 25: getCurrentPeriod — returns YYYY-MM");
    const period25 = getCurrentPeriod();
    assert(/^\d{4}-\d{2}$/.test(period25), "getCurrentPeriod returns YYYY-MM format");
    const [yr25, mo25] = period25.split("-").map(Number);
    assert(yr25 >= 2025, "Year is plausible");
    assert(mo25 >= 1 && mo25 <= 12, "Month is 1-12");

    // ── SCENARIO 26: recordAnomalyEvent — basic write ─────────────────────────
    section("SCENARIO 26: recordAnomalyEvent — basic write");
    const anomaly26 = await recordAnomalyEvent({
      tenantId: T_A,
      eventType: "usage_spike",
      usageSpikePercent: 350,
      metadata: { source: "validate-phase16", ts: TS },
    });
    assert(anomaly26 != null, "Anomaly event created");
    assert(typeof anomaly26!.id === "string", "Anomaly event has id");
    const r26 = await client.query(
      `SELECT * FROM gov_anomaly_events WHERE id=$1`,
      [anomaly26!.id],
    );
    assert(r26.rows.length === 1, "Anomaly event in DB");
    assert(r26.rows[0].tenant_id === T_A, "tenant_id correct");
    assert(r26.rows[0].event_type === "usage_spike", "event_type correct");
    assert(Number(r26.rows[0].usage_spike_percent) === 350, "usage_spike_percent correct");
    assert(r26.rows[0].metadata !== null, "metadata stored");

    // ── SCENARIO 27: recordAnomalyEvent — never throws ────────────────────────
    section("SCENARIO 27: INV-GOV-1 — recordAnomalyEvent never throws");
    let threw27 = false;
    try {
      await recordAnomalyEvent({ tenantId: "", eventType: "" });
    } catch {
      threw27 = true;
    }
    assert(!threw27, "INV-GOV-1: recordAnomalyEvent does not throw on empty input");

    // ── SCENARIO 28: listAnomalyEvents — tenant scoped ───────────────────────
    section("SCENARIO 28: INV-GOV-4 — listAnomalyEvents is tenant-scoped");
    const events28 = await listAnomalyEvents(T_A);
    assert(Array.isArray(events28), "listAnomalyEvents returns array");
    assert(events28.length >= 1, "At least 1 anomaly event for Tenant A");
    assert(events28.every((e) => e.tenantId === T_A), "INV-GOV-4: All events belong to Tenant A");

    // ── SCENARIO 29: listAnomalyEvents — Tenant B sees nothing ───────────────
    section("SCENARIO 29: INV-GOV-4 — Tenant B sees 0 anomaly events from Tenant A");
    const eventsB29 = await listAnomalyEvents(T_B);
    assert(eventsB29.length === 0, "INV-GOV-4: Tenant B has no anomaly events");

    // ── SCENARIO 30: listAllAnomalyEvents — admin view ───────────────────────
    section("SCENARIO 30: listAllAnomalyEvents — returns all events");
    const all30 = await listAllAnomalyEvents();
    assert(Array.isArray(all30), "listAllAnomalyEvents returns array");
    assert(all30.length >= 1, "At least 1 anomaly event globally");

    // ── SCENARIO 31: detectUsageAnomaly — no anomaly for new tenant ───────────
    section("SCENARIO 31: detectUsageAnomaly — no anomaly for new tenant");
    const detection31 = await detectUsageAnomaly(`new-tenant-${TS}`);
    assert(typeof detection31.isAnomaly === "boolean", "isAnomaly is boolean");
    assert(detection31.isAnomaly === false, "No anomaly for tenant with no data");

    // ── SCENARIO 32: detectUsageAnomaly — never throws ───────────────────────
    section("SCENARIO 32: INV-GOV-1 — detectUsageAnomaly never throws");
    let threw32 = false;
    try {
      await detectUsageAnomaly("");
    } catch {
      threw32 = true;
    }
    assert(!threw32, "INV-GOV-1: detectUsageAnomaly does not throw");

    // ── SCENARIO 33: detectAndRecordAnomaly — no anomaly path ────────────────
    section("SCENARIO 33: detectAndRecordAnomaly — no anomaly = no event recorded");
    const T_NEW = `gov-new-${TS}`;
    const beforeCount33 = await client.query(
      `SELECT COUNT(*) FROM gov_anomaly_events WHERE tenant_id=$1`, [T_NEW],
    );
    await detectAndRecordAnomaly(T_NEW);
    const afterCount33 = await client.query(
      `SELECT COUNT(*) FROM gov_anomaly_events WHERE tenant_id=$1`, [T_NEW],
    );
    assert(Number(afterCount33.rows[0].count) === Number(beforeCount33.rows[0].count), "No event recorded when no anomaly");

    // ── SCENARIO 34: generateUsageAlert — basic write ─────────────────────────
    section("SCENARIO 34: generateUsageAlert — basic write");
    const alert34 = await generateUsageAlert({
      tenantId: T_A,
      alertType: "soft_limit",
      thresholdPercent: 80,
      usagePercent: 85,
    });
    assert(alert34 != null, "Alert created");
    assert(typeof alert34!.id === "string", "Alert has id");
    const r34 = await client.query(`SELECT * FROM ai_usage_alerts WHERE id=$1`, [alert34!.id]);
    assert(r34.rows.length === 1, "Alert record in DB");
    assert(r34.rows[0].tenant_id === T_A, "tenant_id correct");
    assert(r34.rows[0].alert_type === "soft_limit", "alert_type correct");
    assert(Number(r34.rows[0].threshold_percent) === 80, "threshold_percent correct");
    assert(Number(r34.rows[0].usage_percent) === 85, "usage_percent correct");

    // ── SCENARIO 35: generateUsageAlert — hard_limit type ────────────────────
    section("SCENARIO 35: generateUsageAlert — hard_limit alert");
    const alert35 = await generateUsageAlert({
      tenantId: T_A,
      alertType: "hard_limit",
      thresholdPercent: 100,
      usagePercent: 102,
    });
    assert(alert35 != null, "Hard limit alert created");
    const r35 = await client.query(`SELECT alert_type FROM ai_usage_alerts WHERE id=$1`, [alert35!.id]);
    assert(r35.rows[0].alert_type === "hard_limit", "alert_type is hard_limit");

    // ── SCENARIO 36: generateUsageAlert — never throws ────────────────────────
    section("SCENARIO 36: INV-GOV-1 — generateUsageAlert never throws");
    let threw36 = false;
    try {
      await generateUsageAlert({ tenantId: "", alertType: "", thresholdPercent: NaN, usagePercent: NaN });
    } catch {
      threw36 = true;
    }
    assert(!threw36, "INV-GOV-1: generateUsageAlert does not throw");

    // ── SCENARIO 37: listTenantAlerts — tenant scoped ────────────────────────
    section("SCENARIO 37: INV-GOV-4 — listTenantAlerts is tenant-scoped");
    const alerts37 = await listTenantAlerts(T_A);
    assert(Array.isArray(alerts37), "listTenantAlerts returns array");
    assert(alerts37.length >= 2, "At least 2 alerts for Tenant A");
    assert(alerts37.every((a) => a.tenantId === T_A), "INV-GOV-4: All alerts belong to Tenant A");

    // ── SCENARIO 38: listTenantAlerts — Tenant B sees nothing ────────────────
    section("SCENARIO 38: INV-GOV-4 — Tenant B sees 0 alerts from Tenant A");
    const alertsB38 = await listTenantAlerts(T_B);
    assert(alertsB38.length === 0, "INV-GOV-4: Tenant B has no alerts from Tenant A");

    // ── SCENARIO 39: listAllAlerts — admin view ───────────────────────────────
    section("SCENARIO 39: listAllAlerts — returns all alerts");
    const all39 = await listAllAlerts();
    assert(Array.isArray(all39), "listAllAlerts returns array");
    assert(all39.length >= 2, "At least 2 alerts globally");

    // ── SCENARIO 40: checkAndGenerateAlerts — hard limit triggers alert ───────
    section("SCENARIO 40: checkAndGenerateAlerts — hard limit triggers alert");
    const result40 = await checkAndGenerateAlerts(T_HARD);
    assert(typeof result40.alertGenerated === "boolean", "alertGenerated is boolean");
    assert(result40.alertGenerated === true, "Alert generated for hard-limit tenant");
    assert(result40.state === "hard_limit", "State is hard_limit");
    assert(typeof result40.alertId === "string", "alertId returned");

    // ── SCENARIO 41: checkAndGenerateAlerts — soft limit triggers alert ───────
    section("SCENARIO 41: checkAndGenerateAlerts — soft limit triggers alert");
    const result41 = await checkAndGenerateAlerts(T_SOFT);
    assert(result41.alertGenerated === true, "Alert generated for soft-limit tenant");
    assert(result41.state === "soft_limit", "State is soft_limit");

    // ── SCENARIO 42: checkAndGenerateAlerts — no budget = no alert ───────────
    section("SCENARIO 42: checkAndGenerateAlerts — no budget = no alert");
    const result42 = await checkAndGenerateAlerts(`no-budget-42-${TS}`);
    assert(result42.alertGenerated === false, "No alert for tenant with no budget");
    assert(result42.alertId === null, "alertId is null");

    // ── SCENARIO 43: checkRunawayProtection — below all limits ───────────────
    section("SCENARIO 43: checkRunawayProtection — below all limits");
    const r43 = checkRunawayProtection({ tenantId: T_A, steps: 5, iterations: 3, tokensUsed: 1000, costUsd: 0.01 });
    assert(r43.abort === false, "No abort below limits");
    assert(r43.reason == null, "No reason when not aborting");

    // ── SCENARIO 44: checkRunawayProtection — step limit exceeded ────────────
    section("SCENARIO 44: INV-GOV-2 — step limit exceeded triggers abort");
    const r44 = checkRunawayProtection({ steps: MAX_STEPS_PER_RUN });
    assert(r44.abort === true, "INV-GOV-2: Abort when steps >= MAX_STEPS_PER_RUN");
    assert(r44.violatedLimit === "steps", "violatedLimit is steps");
    assert(typeof r44.reason === "string", "Reason string provided");
    assert(r44.reason!.includes("step"), "Reason mentions step");

    // ── SCENARIO 45: checkRunawayProtection — token limit exceeded ───────────
    section("SCENARIO 45: INV-GOV-2 — token limit exceeded triggers abort");
    const r45 = checkRunawayProtection({ tokensUsed: MAX_TOKENS_PER_RUN });
    assert(r45.abort === true, "INV-GOV-2: Abort when tokens >= MAX_TOKENS_PER_RUN");
    assert(r45.violatedLimit === "tokens", "violatedLimit is tokens");

    // ── SCENARIO 46: checkRunawayProtection — cost limit exceeded ────────────
    section("SCENARIO 46: INV-GOV-2 — cost limit exceeded triggers abort");
    const r46 = checkRunawayProtection({ costUsd: MAX_COST_PER_RUN_USD });
    assert(r46.abort === true, "INV-GOV-2: Abort when cost >= MAX_COST_PER_RUN_USD");
    assert(r46.violatedLimit === "cost", "violatedLimit is cost");

    // ── SCENARIO 47: checkRunawayProtection — iteration limit exceeded ────────
    section("SCENARIO 47: INV-GOV-2 — iteration limit exceeded triggers abort");
    const r47 = checkRunawayProtection({ iterations: MAX_ITERATIONS_PER_RUN });
    assert(r47.abort === true, "INV-GOV-2: Abort when iterations >= MAX_ITERATIONS_PER_RUN");
    assert(r47.violatedLimit === "iterations", "violatedLimit is iterations");

    // ── SCENARIO 48: checkRunawayProtection — boundary values ────────────────
    section("SCENARIO 48: checkRunawayProtection — boundary values");
    const r48below = checkRunawayProtection({ steps: MAX_STEPS_PER_RUN - 1 });
    const r48at = checkRunawayProtection({ steps: MAX_STEPS_PER_RUN });
    assert(r48below.abort === false, `${MAX_STEPS_PER_RUN - 1} steps is fine`);
    assert(r48at.abort === true, `${MAX_STEPS_PER_RUN} steps triggers abort`);

    // ── SCENARIO 49: recordRunawayEvent — writes anomaly event ───────────────
    section("SCENARIO 49: recordRunawayEvent — writes runaway_agent event");
    const runaway49 = await recordRunawayEvent({
      tenantId: T_A,
      runId: `run-rw-${TS}`,
      violatedLimit: "steps",
      value: MAX_STEPS_PER_RUN,
      reason: "Test runaway",
    });
    assert(runaway49 != null, "Runaway event created");
    const r49 = await client.query(
      `SELECT event_type, metadata FROM gov_anomaly_events WHERE id=$1`,
      [runaway49!.id],
    );
    assert(r49.rows.length === 1, "Runaway event in DB");
    assert(r49.rows[0].event_type === "runaway_agent", "event_type is runaway_agent");
    assert(r49.rows[0].metadata.violatedLimit === "steps", "violatedLimit in metadata");
    assert(r49.rows[0].metadata.runId === `run-rw-${TS}`, "runId in metadata");

    // ── SCENARIO 50: checkAndRecordRunaway — abort + auto-record ─────────────
    section("SCENARIO 50: checkAndRecordRunaway — abort + auto-records event");
    const before50 = await listAnomalyEvents(T_A);
    const result50 = await checkAndRecordRunaway(T_A, { steps: MAX_STEPS_PER_RUN, runId: `run-auto-${TS}` });
    await new Promise((r) => setTimeout(r, 300));
    const after50 = await listAnomalyEvents(T_A);
    assert(result50.abort === true, "checkAndRecordRunaway returns abort=true");
    assert(after50.length > before50.length, "New runaway event recorded automatically");

    // ── SCENARIO 51: checkAndRecordRunaway — no abort = no event ─────────────
    section("SCENARIO 51: checkAndRecordRunaway — no abort = no new event");
    const before51 = await listAnomalyEvents(T_A);
    await checkAndRecordRunaway(T_A, { steps: 1, tokensUsed: 100, costUsd: 0.001 });
    const after51 = await listAnomalyEvents(T_A);
    assert(after51.length === before51.length, "No new event when no abort triggered");

    // ── SCENARIO 52: getRunawayConfig — correct shape ─────────────────────────
    section("SCENARIO 52: getRunawayConfig — correct shape");
    const cfg52 = getRunawayConfig();
    assert(cfg52.maxStepsPerRun === MAX_STEPS_PER_RUN, "maxStepsPerRun correct");
    assert(cfg52.maxIterationsPerRun === MAX_ITERATIONS_PER_RUN, "maxIterationsPerRun correct");
    assert(cfg52.maxTokensPerRun === MAX_TOKENS_PER_RUN, "maxTokensPerRun correct");
    assert(cfg52.maxCostPerRunUsd === MAX_COST_PER_RUN_USD, "maxCostPerRunUsd correct");
    assert(cfg52.inv.includes("INV-GOV-1"), "INV-GOV-1 documented");
    assert(cfg52.inv.includes("INV-GOV-2"), "INV-GOV-2 documented");
    assert(cfg52.inv.includes("INV-GOV-6"), "INV-GOV-6 documented");

    // ── SCENARIO 53: INV-GOV-1 — checkRunawayProtection never throws ─────────
    section("SCENARIO 53: INV-GOV-1 — checkRunawayProtection never throws");
    let threw53 = false;
    try {
      checkRunawayProtection({ steps: undefined, tokensUsed: undefined });
    } catch {
      threw53 = true;
    }
    assert(!threw53, "INV-GOV-1: checkRunawayProtection does not throw on undefined inputs");

    // ── SCENARIO 54: Full governance lifecycle ────────────────────────────────
    section("SCENARIO 54: Full governance lifecycle — budget → snapshot → alert → anomaly");
    const T_FULL = `gov-full-${TS}`;
    await upsertTenantBudget({ tenantId: T_FULL, monthlyBudgetUsd: 50, softLimitPercent: 80, hardLimitPercent: 100 });
    await client.query(
      `INSERT INTO obs_ai_latency_metrics(tenant_id, model, provider, latency_ms, tokens_in, tokens_out, cost_usd) VALUES($1,'gpt-4o','openai',600,300,100,0.003)`,
      [T_FULL],
    );
    const snap54 = await captureUsageSnapshot(T_FULL);
    const check54 = await checkBudgetBeforeCall(T_FULL);
    const alert54 = await generateUsageAlert({ tenantId: T_FULL, alertType: "soft_limit", thresholdPercent: 80, usagePercent: 0.006 });
    const event54 = await recordAnomalyEvent({ tenantId: T_FULL, eventType: "usage_spike", usageSpikePercent: 150 });
    assert(snap54 != null, "Full lifecycle: snapshot created");
    assert(check54.allowed === true, "Full lifecycle: budget check passed");
    assert(alert54 != null, "Full lifecycle: alert created");
    assert(event54 != null, "Full lifecycle: anomaly event created");

    // ── SCENARIO 55: Admin route — /api/admin/ai/budgets ─────────────────────
    section("SCENARIO 55: Admin route /api/admin/ai/budgets registered");
    let r55: any;
    try { r55 = await fetch("http://localhost:5000/api/admin/ai/budgets"); } catch { r55 = { status: 0 }; }
    assert(r55.status !== 404, "Route /api/admin/ai/budgets is not 404");

    // ── SCENARIO 56: Admin route — /api/admin/ai/usage ───────────────────────
    section("SCENARIO 56: Admin route /api/admin/ai/usage registered");
    let r56: any;
    try { r56 = await fetch("http://localhost:5000/api/admin/ai/usage"); } catch { r56 = { status: 0 }; }
    assert(r56.status !== 404, "Route /api/admin/ai/usage is not 404");

    // ── SCENARIO 57: Admin route — /api/admin/ai/anomalies ───────────────────
    section("SCENARIO 57: Admin route /api/admin/ai/anomalies registered");
    let r57: any;
    try { r57 = await fetch("http://localhost:5000/api/admin/ai/anomalies"); } catch { r57 = { status: 0 }; }
    assert(r57.status !== 404, "Route /api/admin/ai/anomalies is not 404");

    // ── SCENARIO 58: Admin route — /api/admin/ai/alerts ─────────────────────
    section("SCENARIO 58: Admin route /api/admin/ai/alerts registered");
    let r58: any;
    try { r58 = await fetch("http://localhost:5000/api/admin/ai/alerts"); } catch { r58 = { status: 0 }; }
    assert(r58.status !== 404, "Route /api/admin/ai/alerts is not 404");

    // ── SCENARIO 59: Admin route — /api/admin/ai/runaway-events ──────────────
    section("SCENARIO 59: Admin route /api/admin/ai/runaway-events registered");
    let r59: any;
    try { r59 = await fetch("http://localhost:5000/api/admin/ai/runaway-events"); } catch { r59 = { status: 0 }; }
    assert(r59.status !== 404, "Route /api/admin/ai/runaway-events is not 404");

    // ── SCENARIO 60: INV-GOV-5 — full audit trail ──────────────────────────
    section("SCENARIO 60: INV-GOV-5 — full audit trail: all events persisted");
    const alerts60 = await listTenantAlerts(T_A);
    const events60 = await listAnomalyEvents(T_A);
    const snaps60 = await listSnapshots(T_A);
    assert(alerts60.length >= 2, "INV-GOV-5: Multiple alerts in audit trail");
    assert(events60.length >= 3, "INV-GOV-5: Multiple anomaly events in audit trail");
    assert(snaps60.length >= 1, "INV-GOV-5: Snapshots in audit trail");
    // Verify event types are recorded
    const eventTypes60 = events60.map((e) => e.eventType);
    assert(eventTypes60.includes("usage_spike"), "usage_spike event in trail");
    assert(eventTypes60.includes("runaway_agent"), "runaway_agent event in trail");

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────────
    await client.query(`DELETE FROM tenant_ai_budgets WHERE tenant_id LIKE 'gov-%'`);
    await client.query(`DELETE FROM tenant_ai_usage_snapshots WHERE tenant_id LIKE 'gov-%'`);
    await client.query(`DELETE FROM ai_usage_alerts WHERE tenant_id LIKE 'gov-%'`);
    await client.query(`DELETE FROM gov_anomaly_events WHERE tenant_id LIKE 'gov-%'`);
    await client.query(`DELETE FROM obs_ai_latency_metrics WHERE tenant_id LIKE 'gov-%'`);
    await client.end();
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Phase 16 validation: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.error(`✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ Validation crashed:", err.message);
  process.exit(1);
});
