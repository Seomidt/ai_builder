/**
 * Phase 16 — AI Cost Governance: Validation Script
 *
 * 60 scenarier / 130+ assertions
 *
 * Usage:
 *   npx tsx server/lib/ai-governance/validate-phase16.ts
 */

import pg from "pg";
const { Client } = pg;

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    process.stdout.write(`  ✅ ${label}\n`);
  } else {
    failed++;
    failures.push(label);
    process.stdout.write(`  ❌ FAIL: ${label}\n`);
  }
}

function section(name: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${name}`);
  console.log("─".repeat(60));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deviationPct(baseline: number, observed: number): number {
  if (baseline <= 0) return observed > 0 ? 100 : 0;
  return Math.abs(((observed - baseline) / baseline) * 100);
}

function classifyBudgetStatus(
  currentCents: bigint,
  budgetCents:  bigint,
  warningPct:   number,
  hardPct:      number,
): string {
  if (budgetCents <= 0n) return "no_budget";
  const pct = Number((currentCents * 10000n) / budgetCents) / 100;
  if (pct >= hardPct)    return "exceeded";
  if (pct >= warningPct) return "warning";
  return "under_budget";
}

function classifyAnomalySeverity(dev: number): string {
  if (dev >= 300) return "critical";
  if (dev >= 150) return "high";
  if (dev >= 75)  return "medium";
  return "low";
}

function periodBounds(type: string): { start: Date; end: Date } {
  const now = new Date();
  switch (type) {
    case "daily": {
      const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start: s, end: new Date(s.getTime() + 86_400_000) };
    }
    case "weekly": {
      const dow = now.getUTCDay();
      const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((dow + 6) % 7)));
      return { start: mon, end: new Date(mon.getTime() + 7 * 86_400_000) };
    }
    case "monthly": {
      const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start: s, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
    }
    case "annual": {
      const s = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { start: s, end: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) };
    }
    default: throw new Error(`Unknown period: ${type}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();

  console.log("\nPhase 16 — AI Cost Governance Validation");
  console.log("==========================================");
  const testOrgId = `phase16-test-${Date.now()}`;

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 1: Schema — table existence + column presence
    // ══════════════════════════════════════════════════════════════════════════
    section("S01: Schema — table existence");

    const tables = ["tenant_ai_budgets", "tenant_ai_usage_snapshots", "ai_usage_alerts", "ai_anomaly_events"];
    for (const t of tables) {
      const r = await client.query(`SELECT to_regclass('public.${t}') AS oid`);
      assert(r.rows[0].oid !== null, `Table exists: ${t}`);                    // 4 assertions
    }

    section("S02: Schema — tenant_ai_budgets columns");
    const budgetCols = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenant_ai_budgets'
    `);
    const bc = budgetCols.rows.map((r: { column_name: string }) => r.column_name);
    assert(bc.includes("id"),                   "tab16: id column");            // 5
    assert(bc.includes("organization_id"),      "tab16: organization_id");     // 6
    assert(bc.includes("period_type"),          "tab16: period_type");          // 7
    assert(bc.includes("budget_usd_cents"),     "tab16: budget_usd_cents");     // 8
    assert(bc.includes("warning_threshold_pct"),"tab16: warning_threshold_pct");// 9
    assert(bc.includes("hard_limit_pct"),       "tab16: hard_limit_pct");       // 10
    assert(bc.includes("is_active"),            "tab16: is_active");            // 11
    assert(bc.includes("created_at"),           "tab16: created_at");           // 12
    assert(bc.includes("updated_at"),           "tab16: updated_at");           // 13

    section("S03: Schema — tenant_ai_usage_snapshots columns");
    const snapshotCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tenant_ai_usage_snapshots'
    `);
    const sc = snapshotCols.rows.map((r: { column_name: string }) => r.column_name);
    assert(sc.includes("total_tokens"),          "taus16: total_tokens");        // 14
    assert(sc.includes("prompt_tokens"),         "taus16: prompt_tokens");       // 15
    assert(sc.includes("completion_tokens"),     "taus16: completion_tokens");   // 16
    assert(sc.includes("total_cost_usd_cents"),  "taus16: total_cost_usd_cents");// 17
    assert(sc.includes("failed_request_count"),  "taus16: failed_request_count");// 18
    assert(sc.includes("model_breakdown"),       "taus16: model_breakdown");     // 19
    assert(sc.includes("period_start"),          "taus16: period_start");        // 20
    assert(sc.includes("period_end"),            "taus16: period_end");          // 21

    section("S04: Schema — ai_usage_alerts columns");
    const alertCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ai_usage_alerts'
    `);
    const ac = alertCols.rows.map((r: { column_name: string }) => r.column_name);
    assert(ac.includes("alert_type"),               "aua16: alert_type");        // 22
    assert(ac.includes("severity"),                 "aua16: severity");          // 23
    assert(ac.includes("status"),                   "aua16: status");            // 24
    assert(ac.includes("linked_snapshot_id"),       "aua16: linked_snapshot_id");// 25
    assert(ac.includes("linked_anomaly_id"),        "aua16: linked_anomaly_id"); // 26
    assert(ac.includes("acknowledged_at"),          "aua16: acknowledged_at");   // 27
    assert(ac.includes("resolved_at"),              "aua16: resolved_at");       // 28

    section("S05: Schema — ai_anomaly_events columns");
    const anomalyCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ai_anomaly_events'
    `);
    const aac = anomalyCols.rows.map((r: { column_name: string }) => r.column_name);
    assert(aac.includes("anomaly_type"),   "aae16: anomaly_type");               // 29
    assert(aac.includes("baseline_value"), "aae16: baseline_value");             // 30
    assert(aac.includes("observed_value"), "aae16: observed_value");             // 31
    assert(aac.includes("deviation_pct"),  "aae16: deviation_pct");              // 32
    assert(aac.includes("window_minutes"), "aae16: window_minutes");             // 33
    assert(aac.includes("is_confirmed"),   "aae16: is_confirmed");               // 34

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 2: Indexes
    // ══════════════════════════════════════════════════════════════════════════
    section("S06: Indexes");

    const expectedIndexes = [
      "tab16_org_idx", "tab16_org_period_uq",
      "taus16_org_period_idx", "taus16_type_start_idx", "taus16_org_type_start_idx",
      "aua16_org_created_idx", "aua16_status_severity_idx", "aua16_org_status_idx",
      "aae16_org_detected_idx", "aae16_anomaly_type_idx", "aae16_org_type_idx",
    ];
    const idxResult = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)
    `, [expectedIndexes]);
    const foundIdxs = new Set(idxResult.rows.map((r: { indexname: string }) => r.indexname));
    for (const idx of expectedIndexes) {
      assert(foundIdxs.has(idx), `Index exists: ${idx}`);                       // 11 assertions (35-45)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 3: Constraints
    // ══════════════════════════════════════════════════════════════════════════
    section("S07: Check constraints — tenant_ai_budgets");

    // Valid insert
    await client.query(`
      INSERT INTO tenant_ai_budgets (organization_id, period_type, budget_usd_cents, warning_threshold_pct, hard_limit_pct)
      VALUES ($1, 'monthly', 10000, 80, 100)
    `, [testOrgId]);
    assert(true, "tab16: valid insert succeeds");                               // 46

    // period_type constraint
    let periodFail = false;
    try { await client.query(`INSERT INTO tenant_ai_budgets (organization_id, period_type, budget_usd_cents) VALUES ($1, 'bimonthly', 1000)`, [testOrgId + "-bad"]); }
    catch { periodFail = true; }
    assert(periodFail, "tab16: invalid period_type rejected");                  // 47

    // budget_positive constraint
    let budgetZeroFail = false;
    try { await client.query(`INSERT INTO tenant_ai_budgets (organization_id, period_type, budget_usd_cents) VALUES ($1, 'daily', 0)`, [testOrgId + "-z"]); }
    catch { budgetZeroFail = true; }
    assert(budgetZeroFail, "tab16: zero budget_usd_cents rejected");            // 48

    // threshold_check (warning >= hard)
    let threshFail = false;
    try { await client.query(`INSERT INTO tenant_ai_budgets (organization_id, period_type, budget_usd_cents, warning_threshold_pct, hard_limit_pct) VALUES ($1, 'weekly', 5000, 100, 80)`, [testOrgId + "-t"]); }
    catch { threshFail = true; }
    assert(threshFail, "tab16: warning >= hard_limit rejected");                // 49

    // unique constraint org+period
    let uniqFail = false;
    try { await client.query(`INSERT INTO tenant_ai_budgets (organization_id, period_type, budget_usd_cents) VALUES ($1, 'monthly', 9999)`, [testOrgId]); }
    catch { uniqFail = true; }
    assert(uniqFail, "tab16: duplicate org+period rejected");                   // 50

    section("S08: Check constraints — tenant_ai_usage_snapshots");
    const { start: ps, end: pe } = periodBounds("monthly");
    await client.query(`
      INSERT INTO tenant_ai_usage_snapshots
        (organization_id, period_type, period_start, period_end, total_tokens, total_cost_usd_cents)
      VALUES ($1, 'monthly', $2, $3, 1000, 500)
    `, [testOrgId, ps.toISOString(), pe.toISOString()]);
    assert(true, "taus16: valid snapshot insert");                              // 51

    let snapPeriodFail = false;
    try { await client.query(`INSERT INTO tenant_ai_usage_snapshots (organization_id, period_type, period_start, period_end) VALUES ($1, 'quarterly', $2, $3)`, [testOrgId, ps, pe]); }
    catch { snapPeriodFail = true; }
    assert(snapPeriodFail, "taus16: invalid period_type rejected");             // 52

    let snapEndFail = false;
    try { await client.query(`INSERT INTO tenant_ai_usage_snapshots (organization_id, period_type, period_start, period_end) VALUES ($1, 'daily', $2, $3)`, [testOrgId, pe, ps]); }
    catch { snapEndFail = true; }
    assert(snapEndFail, "taus16: period_end <= period_start rejected");         // 53

    section("S09: Check constraints — ai_usage_alerts");
    const alertInsert = await client.query(`
      INSERT INTO ai_usage_alerts (organization_id, alert_type, severity, title, message)
      VALUES ($1, 'budget_warning', 'medium', 'Test alert', 'Test message')
      RETURNING id
    `, [testOrgId]);
    const testAlertId = alertInsert.rows[0].id as string;
    assert(typeof testAlertId === "string" && testAlertId.length > 0, "aua16: valid alert insert");// 54

    let alertTypeFail = false;
    try { await client.query(`INSERT INTO ai_usage_alerts (organization_id, alert_type, title, message) VALUES ($1, 'invalid_type', 'T', 'M')`, [testOrgId]); }
    catch { alertTypeFail = true; }
    assert(alertTypeFail, "aua16: invalid alert_type rejected");                // 55

    let severityFail = false;
    try { await client.query(`INSERT INTO ai_usage_alerts (organization_id, alert_type, severity, title, message) VALUES ($1, 'anomaly', 'ultra', 'T', 'M')`, [testOrgId]); }
    catch { severityFail = true; }
    assert(severityFail, "aua16: invalid severity rejected");                   // 56

    let statusFail = false;
    try { await client.query(`INSERT INTO ai_usage_alerts (organization_id, alert_type, status, title, message) VALUES ($1, 'runaway', 'pending', 'T', 'M')`, [testOrgId]); }
    catch { statusFail = true; }
    assert(statusFail, "aua16: invalid status rejected");                       // 57

    section("S10: Check constraints — ai_anomaly_events");
    const anomalyInsert = await client.query(`
      INSERT INTO ai_anomaly_events (organization_id, anomaly_type, baseline_value, observed_value, deviation_pct, severity)
      VALUES ($1, 'cost_spike', 100.0, 350.0, 250.0, 'high')
      RETURNING id
    `, [testOrgId]);
    const testAnomalyId = anomalyInsert.rows[0].id as string;
    assert(typeof testAnomalyId === "string", "aae16: valid anomaly insert");   // 58

    let anomalyTypeFail = false;
    try { await client.query(`INSERT INTO ai_anomaly_events (organization_id, anomaly_type, baseline_value, observed_value, deviation_pct) VALUES ($1, 'magic', 1, 2, 100)`, [testOrgId]); }
    catch { anomalyTypeFail = true; }
    assert(anomalyTypeFail, "aae16: invalid anomaly_type rejected");            // 59

    let devFail = false;
    try { await client.query(`INSERT INTO ai_anomaly_events (organization_id, anomaly_type, baseline_value, observed_value, deviation_pct) VALUES ($1, 'cost_spike', 100, 50, -10)`, [testOrgId]); }
    catch { devFail = true; }
    assert(devFail, "aae16: negative deviation_pct rejected");                  // 60

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 4: CRUD operations
    // ══════════════════════════════════════════════════════════════════════════
    section("S11: CRUD — tenant_ai_budgets");

    // Read back inserted budget
    const budgetRead = await client.query(`SELECT * FROM tenant_ai_budgets WHERE organization_id = $1 AND period_type = 'monthly'`, [testOrgId]);
    assert(budgetRead.rows.length === 1,                          "tab16 CRUD: read back");     // 61
    assert(budgetRead.rows[0].budget_usd_cents === "10000",       "tab16 CRUD: budget value");  // 62
    assert(budgetRead.rows[0].warning_threshold_pct === 80,       "tab16 CRUD: warning pct");   // 63
    assert(budgetRead.rows[0].is_active === true,                 "tab16 CRUD: is_active=true");// 64

    // Update budget
    await client.query(`UPDATE tenant_ai_budgets SET budget_usd_cents = 20000, updated_at = NOW() WHERE organization_id = $1 AND period_type = 'monthly'`, [testOrgId]);
    const budgetUpdated = await client.query(`SELECT budget_usd_cents FROM tenant_ai_budgets WHERE organization_id = $1 AND period_type = 'monthly'`, [testOrgId]);
    assert(budgetUpdated.rows[0].budget_usd_cents === "20000",    "tab16 CRUD: update budget value"); // 65

    // Deactivate budget
    await client.query(`UPDATE tenant_ai_budgets SET is_active = false WHERE organization_id = $1 AND period_type = 'monthly'`, [testOrgId]);
    const budgetDeact = await client.query(`SELECT is_active FROM tenant_ai_budgets WHERE organization_id = $1 AND period_type = 'monthly'`, [testOrgId]);
    assert(budgetDeact.rows[0].is_active === false,               "tab16 CRUD: deactivate budget");   // 66

    section("S12: CRUD — tenant_ai_usage_snapshots");

    const snapRead = await client.query(`SELECT * FROM tenant_ai_usage_snapshots WHERE organization_id = $1`, [testOrgId]);
    assert(snapRead.rows.length >= 1,                             "taus16 CRUD: read back");    // 67
    assert(Number(snapRead.rows[0].total_tokens) === 1000,        "taus16 CRUD: tokens value"); // 68
    assert(Number(snapRead.rows[0].total_cost_usd_cents) === 500, "taus16 CRUD: cost value");   // 69
    assert(snapRead.rows[0].period_type === "monthly",            "taus16 CRUD: period_type");  // 70

    // Update snapshot
    await client.query(`UPDATE tenant_ai_usage_snapshots SET total_tokens = 2000, request_count = 42 WHERE organization_id = $1`, [testOrgId]);
    const snapUp = await client.query(`SELECT total_tokens, request_count FROM tenant_ai_usage_snapshots WHERE organization_id = $1`, [testOrgId]);
    assert(Number(snapUp.rows[0].total_tokens) === 2000,          "taus16 CRUD: update tokens");// 71
    assert(Number(snapUp.rows[0].request_count) === 42,           "taus16 CRUD: update requests");// 72

    // Model breakdown JSONB
    await client.query(`UPDATE tenant_ai_usage_snapshots SET model_breakdown = $2 WHERE organization_id = $1`,
      [testOrgId, JSON.stringify({ "gpt-4o": { tokens: 1500, costUsdCents: 300, requests: 30 } })]);
    const snapJson = await client.query(`SELECT model_breakdown->>'gpt-4o' AS m FROM tenant_ai_usage_snapshots WHERE organization_id = $1`, [testOrgId]);
    assert(snapJson.rows[0].m !== null,                           "taus16 CRUD: JSONB model_breakdown readable"); // 73

    section("S13: CRUD — ai_usage_alerts");

    const alertRead = await client.query(`SELECT * FROM ai_usage_alerts WHERE id = $1`, [testAlertId]);
    assert(alertRead.rows[0].status === "open",                   "aua16 CRUD: default status=open");     // 74
    assert(alertRead.rows[0].severity === "medium",               "aua16 CRUD: severity medium");          // 75
    assert(alertRead.rows[0].alert_type === "budget_warning",     "aua16 CRUD: alert_type");               // 76

    // Acknowledge
    await client.query(`UPDATE ai_usage_alerts SET status = 'acknowledged', acknowledged_at = NOW() WHERE id = $1`, [testAlertId]);
    const alertAck = await client.query(`SELECT status, acknowledged_at FROM ai_usage_alerts WHERE id = $1`, [testAlertId]);
    assert(alertAck.rows[0].status === "acknowledged",            "aua16 CRUD: acknowledge status");       // 77
    assert(alertAck.rows[0].acknowledged_at !== null,             "aua16 CRUD: acknowledged_at set");      // 78

    // Resolve
    await client.query(`UPDATE ai_usage_alerts SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [testAlertId]);
    const alertRes = await client.query(`SELECT status, resolved_at FROM ai_usage_alerts WHERE id = $1`, [testAlertId]);
    assert(alertRes.rows[0].status === "resolved",                "aua16 CRUD: resolved status");          // 79
    assert(alertRes.rows[0].resolved_at !== null,                 "aua16 CRUD: resolved_at set");          // 80

    section("S14: CRUD — ai_anomaly_events");

    const anomRead = await client.query(`SELECT * FROM ai_anomaly_events WHERE id = $1`, [testAnomalyId]);
    assert(anomRead.rows[0].anomaly_type === "cost_spike",        "aae16 CRUD: anomaly_type");             // 81
    assert(Number(anomRead.rows[0].deviation_pct) === 250,        "aae16 CRUD: deviation_pct");            // 82
    assert(anomRead.rows[0].is_confirmed === false,               "aae16 CRUD: is_confirmed=false");       // 83
    assert(anomRead.rows[0].severity === "high",                  "aae16 CRUD: severity");                 // 84

    // Confirm anomaly
    await client.query(`UPDATE ai_anomaly_events SET is_confirmed = true, linked_alert_id = $2 WHERE id = $1`, [testAnomalyId, testAlertId]);
    const anomConf = await client.query(`SELECT is_confirmed, linked_alert_id FROM ai_anomaly_events WHERE id = $1`, [testAnomalyId]);
    assert(anomConf.rows[0].is_confirmed === true,                "aae16 CRUD: confirmed");                // 85
    assert(anomConf.rows[0].linked_alert_id === testAlertId,      "aae16 CRUD: linked_alert_id");          // 86

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 5: Business logic — budget classification
    // ══════════════════════════════════════════════════════════════════════════
    section("S15: Budget classification — classifyBudgetStatus");

    assert(classifyBudgetStatus(0n,     10000n, 80, 100) === "under_budget", "classify: 0% → under_budget");   // 87
    assert(classifyBudgetStatus(5000n,  10000n, 80, 100) === "under_budget", "classify: 50% → under_budget");  // 88
    assert(classifyBudgetStatus(7999n,  10000n, 80, 100) === "under_budget", "classify: 79.99% → under_budget");// 89
    assert(classifyBudgetStatus(8000n,  10000n, 80, 100) === "warning",      "classify: 80% → warning");        // 90
    assert(classifyBudgetStatus(9500n,  10000n, 80, 100) === "warning",      "classify: 95% → warning");        // 91
    assert(classifyBudgetStatus(10000n, 10000n, 80, 100) === "exceeded",     "classify: 100% → exceeded");      // 92
    assert(classifyBudgetStatus(12000n, 10000n, 80, 100) === "exceeded",     "classify: 120% → exceeded");      // 93
    assert(classifyBudgetStatus(1000n,  10000n, 70, 90)  === "under_budget", "classify: 10% / 70 threshold → under"); // 94
    assert(classifyBudgetStatus(7000n,  10000n, 70, 90)  === "warning",      "classify: 70% / 70 threshold → warning"); // 95
    assert(classifyBudgetStatus(9000n,  10000n, 70, 90)  === "exceeded",     "classify: 90% / 90 hard → exceeded");    // 96
    assert(classifyBudgetStatus(0n,     0n,     80, 100) === "no_budget",    "classify: 0 budget → no_budget");         // 97

    section("S16: Budget classification — edge cases");
    assert(classifyBudgetStatus(1n, 10000n, 80, 100) === "under_budget",    "classify edge: 0.01% → under_budget"); // 98
    assert(classifyBudgetStatus(9999n, 10000n, 80, 100) === "warning",      "classify edge: 99.99% → warning");     // 99
    assert(classifyBudgetStatus(10001n, 10000n, 80, 100) === "exceeded",    "classify edge: 100.01% → exceeded");   // 100

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 6: Business logic — deviation & anomaly severity
    // ══════════════════════════════════════════════════════════════════════════
    section("S17: Deviation calculation");

    assert(Math.abs(deviationPct(100, 125) - 25) < 0.01,   "deviation: 25% spike");       // 101
    assert(Math.abs(deviationPct(100, 200) - 100) < 0.01,  "deviation: 100% spike");      // 102
    assert(Math.abs(deviationPct(100, 400) - 300) < 0.01,  "deviation: 300% spike");      // 103
    assert(deviationPct(100, 80) === 20,                    "deviation: 20% drop");        // 104
    assert(deviationPct(0, 100) === 100,                    "deviation: 0→100 baseline"); // 105
    assert(deviationPct(0, 0) === 0,                        "deviation: 0→0");            // 106

    section("S18: Anomaly severity classification");

    assert(classifyAnomalySeverity(20)  === "low",      "severity: 20% → low");      // 107
    assert(classifyAnomalySeverity(75)  === "medium",   "severity: 75% → medium");   // 108
    assert(classifyAnomalySeverity(150) === "high",     "severity: 150% → high");    // 109
    assert(classifyAnomalySeverity(300) === "critical", "severity: 300% → critical");// 110
    assert(classifyAnomalySeverity(74)  === "low",      "severity: 74.9% → low");    // 111
    assert(classifyAnomalySeverity(149) === "medium",   "severity: 149% → medium");  // 112
    assert(classifyAnomalySeverity(299) === "high",     "severity: 299% → high");    // 113
    assert(classifyAnomalySeverity(500) === "critical", "severity: 500% → critical");// 114

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 7: Period bounds
    // ══════════════════════════════════════════════════════════════════════════
    section("S19: Period bounds calculation");

    const daily   = periodBounds("daily");
    const weekly  = periodBounds("weekly");
    const monthly = periodBounds("monthly");
    const annual  = periodBounds("annual");

    assert(daily.end.getTime() - daily.start.getTime() === 86_400_000,          "period: daily = 24h");              // 115
    assert(weekly.end.getTime() - weekly.start.getTime() === 7 * 86_400_000,     "period: weekly = 7d");              // 116
    assert(daily.start < daily.end,                                               "period: daily start < end");        // 117
    assert(weekly.start.getUTCDay() === 1,                                        "period: weekly starts on Monday"); // 118 (0=Sun, 1=Mon)
    assert(monthly.start.getUTCDate() === 1,                                      "period: monthly starts on 1st");    // 119
    assert(annual.start.getUTCMonth() === 0 && annual.start.getUTCDate() === 1,   "period: annual starts Jan 1");      // 120
    assert(annual.end.getUTCFullYear() === new Date().getUTCFullYear() + 1,       "period: annual ends next year");    // 121

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 8: RLS
    // ══════════════════════════════════════════════════════════════════════════
    section("S20: RLS enabled on all tables");

    const rlsResult = await client.query(`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1)
    `, [tables]);

    const rlsMap: Record<string, boolean> = {};
    for (const r of rlsResult.rows) {
      rlsMap[(r as { tablename: string; rowsecurity: boolean }).tablename] = (r as { rowsecurity: boolean }).rowsecurity;
    }
    for (const t of tables) {
      assert(rlsMap[t] === true, `RLS enabled: ${t}`);                          // 4 assertions (122-125)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 9: API endpoints (live server)
    // ══════════════════════════════════════════════════════════════════════════
    section("S21: Admin API endpoints");

    const BASE = "http://localhost:5000";
    const INTERNAL_TOKEN = process.env.INTERNAL_API_SECRET ?? "";
    const internalHeaders = { "X-Internal-Token": INTERNAL_TOKEN };

    const govHealth = await fetch(`${BASE}/api/admin/health`, { headers: internalHeaders }).then(r => r.json() as Promise<{ status: string }>);
    assert(govHealth.status === "ok",                             "API: /admin/health → ok");   // 126

    const periodResp = await fetch(`${BASE}/api/admin/governance/period-bounds?periodType=monthly`, { headers: internalHeaders });
    assert(periodResp.status === 200,                             "API: period-bounds 200");    // 127
    const periodData = await periodResp.json() as { data: { periodType: string; periodStart: string; periodEnd: string } };
    assert(periodData.data?.periodType === "monthly",             "API: period-bounds type");   // 128
    assert(typeof periodData.data?.periodStart === "string",      "API: period-bounds start");  // 129

    const classifyResp = await fetch(`${BASE}/api/admin/governance/classify-budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalHeaders },
      body: JSON.stringify({ currentUsageUsdCents: 8500, budgetUsdCents: 10000, warningThresholdPct: 80, hardLimitPct: 100 }),
    });
    assert(classifyResp.status === 200,                           "API: classify-budget 200");  // 130
    const classifyData = await classifyResp.json() as { data: { status: string; utilizationPct: number } };
    assert(classifyData.data?.status === "warning",               "API: classify-budget → warning"); // 131
    assert(typeof classifyData.data?.utilizationPct === "number", "API: classify-budget utilPct");   // 132

    const alertsResp = await fetch(`${BASE}/api/admin/governance/alerts`, { headers: internalHeaders });
    assert(alertsResp.status === 200,                             "API: GET alerts 200");       // 133
    const alertsData = await alertsResp.json() as { data: unknown[] };
    assert(Array.isArray(alertsData.data),                        "API: alerts returns array"); // 134

    const budgetsResp = await fetch(`${BASE}/api/admin/governance/budgets`, { headers: internalHeaders });
    assert(budgetsResp.status === 200,                            "API: GET budgets 200");      // 135
    const budgetsData = await budgetsResp.json() as { data: unknown[]; errors: unknown[] };
    assert(Array.isArray(budgetsData.data),                       "API: budgets returns array");// 136
    assert(Array.isArray(budgetsData.errors),                     "API: budgets errors array"); // 137

    const periodsResp = await fetch(`${BASE}/api/admin/governance/period-bounds?periodType=invalid`, { headers: internalHeaders });
    assert(periodsResp.status === 400,                            "API: invalid periodType → 400"); // 138

    const classifyBadResp = await fetch(`${BASE}/api/admin/governance/classify-budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalHeaders },
      body: JSON.stringify({ budgetUsdCents: 0 }),
    });
    assert(classifyBadResp.status === 400,                        "API: classify invalid body → 400"); // 139

    // Snapshot for a test org (no-op if no billing data)
    const snapResp = await fetch(`${BASE}/api/admin/governance/snapshots/${testOrgId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalHeaders },
      body: JSON.stringify({ periodType: "monthly" }),
    });
    assert(snapResp.status === 200,                               "API: POST snapshot 200");    // 140
    const snapData = await snapResp.json() as { data: { organizationId: string; isNew: boolean } };
    assert(snapData.data?.organizationId === testOrgId,           "API: snapshot orgId");       // 141
    assert(typeof snapData.data?.isNew === "boolean",             "API: snapshot isNew");       // 142

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 10: Cleanup
    // ══════════════════════════════════════════════════════════════════════════
    section("S22: Cleanup test data");

    await client.query(`DELETE FROM ai_anomaly_events WHERE organization_id = $1`, [testOrgId]);
    await client.query(`DELETE FROM ai_usage_alerts WHERE organization_id = $1`, [testOrgId]);
    await client.query(`DELETE FROM tenant_ai_usage_snapshots WHERE organization_id = $1`, [testOrgId]);
    await client.query(`DELETE FROM tenant_ai_budgets WHERE organization_id LIKE $1`, [`${testOrgId}%`]);

    const budgetClean   = await client.query(`SELECT COUNT(*) AS cnt FROM tenant_ai_budgets WHERE organization_id LIKE $1`,        [`${testOrgId}%`]);
    const alertClean    = await client.query(`SELECT COUNT(*) AS cnt FROM ai_usage_alerts WHERE organization_id = $1`,             [testOrgId]);
    const snapshotClean = await client.query(`SELECT COUNT(*) AS cnt FROM tenant_ai_usage_snapshots WHERE organization_id = $1`,   [testOrgId]);
    const anomalyClean  = await client.query(`SELECT COUNT(*) AS cnt FROM ai_anomaly_events WHERE organization_id = $1`,           [testOrgId]);
    assert(Number(budgetClean.rows[0].cnt)   === 0, "cleanup: budgets removed");   // 143
    assert(Number(alertClean.rows[0].cnt)    === 0, "cleanup: alerts removed");    // 144
    assert(Number(snapshotClean.rows[0].cnt) === 0, "cleanup: snapshots removed"); // 145
    assert(Number(anomalyClean.rows[0].cnt)  === 0, "cleanup: anomalies removed"); // 146

  } finally {
    // Emergency cleanup
    try {
      await client.query(`DELETE FROM ai_anomaly_events WHERE organization_id LIKE $1`,         [`phase16-test-%`]);
      await client.query(`DELETE FROM ai_usage_alerts WHERE organization_id LIKE $1`,           [`phase16-test-%`]);
      await client.query(`DELETE FROM tenant_ai_usage_snapshots WHERE organization_id LIKE $1`, [`phase16-test-%`]);
      await client.query(`DELETE FROM tenant_ai_budgets WHERE organization_id LIKE $1`,         [`phase16-test-%`]);
    } catch { /* best effort */ }

    await client.end();
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Phase 16 Validation Complete`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }

  console.log(`\n${"═".repeat(60)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} ASSERTIONS PASSED`);
  } else {
    console.log(`❌ ${failed} ASSERTION(S) FAILED`);
    process.exit(1);
  }
}

run().catch((err: unknown) => {
  console.error("\nValidation script crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
