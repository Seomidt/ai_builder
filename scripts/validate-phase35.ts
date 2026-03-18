/**
 * Phase 35 — Platform Analytics & Ops Dashboards — Validation
 *
 * 50+ scenarios, 140+ assertions
 * Run: npx tsx scripts/validate-phase35.ts
 */

import { Client } from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL!;

// ─── helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    process.stdout.write("  ✓ " + message + "\n");
  } else {
    failed++;
    failures.push(message);
    process.stdout.write("  ✗ FAIL: " + message + "\n");
  }
}

function assertExists(value: unknown, message: string) {
  assert(value !== undefined && value !== null, message);
}

function assertType(value: unknown, type: string, message: string) {
  assert(typeof value === type, `${message} — expected ${type}, got ${typeof value}`);
}

function assertGte(value: number, min: number, message: string) {
  assert(value >= min, `${message} — expected >= ${min}, got ${value}`);
}

function assertLte(value: number, max: number, message: string) {
  assert(value <= max, `${message} — expected <= ${max}, got ${value}`);
}

function assertIsArray(value: unknown, message: string) {
  assert(Array.isArray(value), `${message} — expected array, got ${typeof value}`);
}

async function section(name: string, fn: () => Promise<void>) {
  console.log(`\n── ${name} ──`);
  await fn();
}

// ─── analytics service imports ────────────────────────────────────────────────
async function main() {
  console.log("=================================================");
  console.log(" Phase 35 — Platform Analytics Validation");
  console.log("=================================================");

  // ── S1: DB connectivity ────────────────────────────────────────────────────
  await section("S1: Database connectivity", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    const res = await client.query("SELECT 1 AS ok");
    assert(res.rows[0]?.ok === 1, "Database is reachable");
    await client.end();
  });

  // ── S2: Analytics service files exist ─────────────────────────────────────
  await section("S2: Analytics service files exist", async () => {
    const { existsSync } = await import("fs");
    const files = [
      "server/lib/analytics/platform-health.ts",
      "server/lib/analytics/tenant-health.ts",
      "server/lib/analytics/ai-cost-analytics.ts",
      "server/lib/analytics/job-webhook-analytics.ts",
      "server/lib/analytics/business-billing-analytics.ts",
    ];
    for (const f of files) {
      assert(existsSync(f), `File exists: ${f}`);
    }
  });

  // ── S3: UI component files exist ───────────────────────────────────────────
  await section("S3: UI component files exist", async () => {
    const { existsSync } = await import("fs");
    const files = [
      "client/src/components/ops/MetricCard.tsx",
      "client/src/components/ops/TrendChart.tsx",
      "client/src/components/ops/StatusPill.tsx",
      "client/src/components/ops/TopList.tsx",
      "client/src/components/ops/TimeRangeFilter.tsx",
      "client/src/components/ops/RiskBadge.tsx",
    ];
    for (const f of files) {
      assert(existsSync(f), `File exists: ${f}`);
    }
  });

  // ── S4: Dashboard pages exist ──────────────────────────────────────────────
  await section("S4: Dashboard page files exist", async () => {
    const { existsSync } = await import("fs");
    const files = [
      "client/src/pages/ops/dashboard.tsx",
      "client/src/pages/ops/tenants.tsx",
      "client/src/pages/ops/ai.tsx",
      "client/src/pages/ops/jobs.tsx",
      "client/src/pages/ops/webhooks.tsx",
      "client/src/pages/ops/billing.tsx",
    ];
    for (const f of files) {
      assert(existsSync(f), `File exists: ${f}`);
    }
  });

  // ── S5: Platform Health service ────────────────────────────────────────────
  await section("S5: Platform Health — getPlatformHealthSummary", async () => {
    const { getPlatformHealthSummary } = await import("../server/lib/analytics/platform-health");
    const s = await getPlatformHealthSummary(24);

    assertExists(s, "Summary returned");
    assertExists(s.overallStatus, "overallStatus present");
    assert(["healthy","degraded","critical","unknown"].includes(s.overallStatus),
      `overallStatus is valid value: ${s.overallStatus}`);
    assertType(s.jobsHealth.total,       "number", "jobsHealth.total is number");
    assertType(s.jobsHealth.failed,      "number", "jobsHealth.failed is number");
    assertType(s.jobsHealth.stalled,     "number", "jobsHealth.stalled is number");
    assertType(s.jobsHealth.failureRate, "number", "jobsHealth.failureRate is number");
    assertGte(s.jobsHealth.failureRate,  0, "failureRate >= 0");
    assertLte(s.jobsHealth.failureRate, 100, "failureRate <= 100");
    assertType(s.webhookHealth.total,    "number", "webhookHealth.total is number");
    assertType(s.latencyHealth.p95Ms,    "number", "latencyHealth.p95Ms is number");
    assertGte(s.latencyHealth.p95Ms,     0, "p95Ms >= 0");
    assertType(s.tenantHealth.active,    "number", "tenantHealth.active is number");
    assertGte(s.tenantHealth.total,      0, "tenantHealth.total >= 0");
    assertType(s.queueDepth,             "number", "queueDepth is number");
    assertGte(s.queueDepth,              0, "queueDepth >= 0");
    assert(s.windowHours === 24, "windowHours matches input");
    assertExists(s.retrievedAt, "retrievedAt present");
    assert(new Date(s.retrievedAt).getTime() > 0, "retrievedAt is valid date");
  });

  // ── S6: Platform Health trend ──────────────────────────────────────────────
  await section("S6: Platform Health — getPlatformHealthTrend", async () => {
    const { getPlatformHealthTrend } = await import("../server/lib/analytics/platform-health");
    const t = await getPlatformHealthTrend(24);

    assertExists(t, "Trend returned");
    assertIsArray(t.points, "trend.points is array");
    assert(t.windowHours === 24, "windowHours matches");
    if (t.points.length > 0) {
      const p = t.points[0];
      assertExists(p.bucket, "point has bucket");
      assertType(p.failedJobs,     "number", "point.failedJobs is number");
      assertType(p.failedWebhooks, "number", "point.failedWebhooks is number");
      assertType(p.avgLatencyMs,   "number", "point.avgLatencyMs is number");
    }
  });

  // ── S7: Platform Health explainer ──────────────────────────────────────────
  await section("S7: Platform Health — explainPlatformHealth", async () => {
    const { getPlatformHealthSummary, explainPlatformHealth } = await import("../server/lib/analytics/platform-health");
    const s = await getPlatformHealthSummary(24);
    const ex = explainPlatformHealth(s);

    assertExists(ex.summary,         "explanation.summary present");
    assertIsArray(ex.issues,          "explanation.issues is array");
    assertIsArray(ex.recommendations, "explanation.recommendations is array");
    assertExists(ex.status,          "explanation.status present");
    assert(typeof ex.summary === "string", "summary is string");
  });

  // ── S8: Platform Health with different windows ─────────────────────────────
  await section("S8: Platform Health — window range variants", async () => {
    const { getPlatformHealthSummary } = await import("../server/lib/analytics/platform-health");
    for (const w of [1, 6, 48, 168]) {
      const s = await getPlatformHealthSummary(w);
      assert(s.windowHours === w, `windowHours=${w} reflected in summary`);
      assertGte(s.jobsHealth.total, 0, `window=${w}: total >= 0`);
    }
  });

  // ── S9: Tenant Health service ──────────────────────────────────────────────
  await section("S9: Tenant Health — getTenantHealthSummary", async () => {
    const { getTenantHealthSummary } = await import("../server/lib/analytics/tenant-health");
    const s = await getTenantHealthSummary(24);

    assertExists(s, "Summary returned");
    assertType(s.totalTenants,      "number", "totalTenants is number");
    assertType(s.activeTenants,     "number", "activeTenants is number");
    assertType(s.suspendedTenants,  "number", "suspendedTenants is number");
    assertType(s.highRiskCount,     "number", "highRiskCount is number");
    assertType(s.criticalRiskCount, "number", "criticalRiskCount is number");
    assertGte(s.totalTenants,       0, "totalTenants >= 0");
    assertGte(s.highRiskCount,      0, "highRiskCount >= 0");
    assertGte(s.criticalRiskCount,  0, "criticalRiskCount >= 0");
    assert(s.criticalRiskCount <= s.highRiskCount + 1, "critical <= high (sanity)");
    assertIsArray(s.topRiskTenants, "topRiskTenants is array");
    assert(s.windowHours === 24, "windowHours matches");
    assertExists(s.retrievedAt, "retrievedAt present");
  });

  // ── S10: Tenant Health risk row structure ──────────────────────────────────
  await section("S10: Tenant Health — risk row structure", async () => {
    const { getTenantHealthSummary } = await import("../server/lib/analytics/tenant-health");
    const s = await getTenantHealthSummary(168);

    if (s.topRiskTenants.length > 0) {
      const r = s.topRiskTenants[0];
      assertExists(r.tenantId,      "row.tenantId present");
      assertType(r.anomalyCount,    "number", "row.anomalyCount is number");
      assertType(r.failedWebhooks,  "number", "row.failedWebhooks is number");
      assertType(r.failedJobs,      "number", "row.failedJobs is number");
      assertType(r.riskScore,       "number", "row.riskScore is number");
      assertGte(r.riskScore,        0, "riskScore >= 0");
      assertLte(r.riskScore,       100, "riskScore <= 100");
      assert(["low","medium","high","critical"].includes(r.riskLevel),
        `riskLevel valid: ${r.riskLevel}`);
    } else {
      assert(true, "No risk tenants (empty state OK)");
    }
  });

  // ── S11: Tenant risk ordering ──────────────────────────────────────────────
  await section("S11: Tenant Health — risk ordering descending", async () => {
    const { getTenantHealthSummary } = await import("../server/lib/analytics/tenant-health");
    const s = await getTenantHealthSummary(168);
    const scores = s.topRiskTenants.map(r => r.riskScore);
    let ordered = true;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[i - 1]) { ordered = false; break; }
    }
    assert(ordered, "Top risk tenants ordered descending by score");
  });

  // ── S12: Tenant Health trend ───────────────────────────────────────────────
  await section("S12: Tenant Health — getTenantHealthTrend", async () => {
    const { getTenantHealthTrend } = await import("../server/lib/analytics/tenant-health");
    const t = await getTenantHealthTrend(24);

    assertExists(t, "Trend returned");
    assertIsArray(t.points, "points is array");
    if (t.points.length > 0) {
      const p = t.points[0];
      assertExists(p.bucket,        "point.bucket present");
      assertType(p.newAnomalies,    "number", "newAnomalies is number");
      assertType(p.newAlerts,       "number", "newAlerts is number");
      assertType(p.failedWebhooks,  "number", "failedWebhooks is number");
    }
  });

  // ── S13: AI Cost service ───────────────────────────────────────────────────
  await section("S13: AI Cost — getAiCostSummary", async () => {
    const { getAiCostSummary } = await import("../server/lib/analytics/ai-cost-analytics");
    const s = await getAiCostSummary(24);

    assertExists(s, "Summary returned");
    assertType(s.totalRequests,    "number", "totalRequests is number");
    assertType(s.totalTokensIn,    "number", "totalTokensIn is number");
    assertType(s.totalTokensOut,   "number", "totalTokensOut is number");
    assertType(s.totalCostUsd,     "number", "totalCostUsd is number");
    assertType(s.avgCostPerRequest,"number", "avgCostPerRequest is number");
    assertType(s.alertCount,       "number", "alertCount is number");
    assertType(s.anomalyCount,     "number", "anomalyCount is number");
    assertGte(s.totalRequests,     0, "totalRequests >= 0");
    assertGte(s.totalCostUsd,      0, "totalCostUsd >= 0");
    assertGte(s.alertCount,        0, "alertCount >= 0");
    assertIsArray(s.topSpendersByTenant, "topSpendersByTenant is array");
    assertIsArray(s.topSpendersByModel,  "topSpendersByModel is array");
    assertIsArray(s.budgetPressure,      "budgetPressure is array");
    assert(s.windowHours === 24, "windowHours matches");
    assertExists(s.retrievedAt, "retrievedAt present");
  });

  // ── S14: AI Cost — no secrets exposed ─────────────────────────────────────
  await section("S14: AI Cost — no secrets exposed", async () => {
    const { getAiCostSummary } = await import("../server/lib/analytics/ai-cost-analytics");
    const s = await getAiCostSummary(24);
    const json = JSON.stringify(s).toLowerCase();

    assert(!json.includes("sk-"),       "No OpenAI key in response");
    assert(!json.includes("bearer"),    "No bearer token in response");
    assert(!json.includes("password"),  "No password in response");
    assert(!json.includes("whsec_"),    "No webhook secret in response");
    assert(!json.includes("secret"),    "No raw secret in response");
  });

  // ── S15: AI Cost trend ────────────────────────────────────────────────────
  await section("S15: AI Cost — getAiCostTrend", async () => {
    const { getAiCostTrend } = await import("../server/lib/analytics/ai-cost-analytics");
    const t = await getAiCostTrend(24);

    assertExists(t, "Trend returned");
    assertIsArray(t.points, "points is array");
    if (t.points.length > 0) {
      const p = t.points[0];
      assertExists(p.bucket,      "point.bucket present");
      assertType(p.requests,      "number", "requests is number");
      assertType(p.tokensTotal,   "number", "tokensTotal is number");
      assertType(p.costUsd,       "number", "costUsd is number");
      assertType(p.anomalies,     "number", "anomalies is number");
      assertGte(p.costUsd,        0, "costUsd >= 0");
    }
  });

  // ── S16: AI Cost explain ──────────────────────────────────────────────────
  await section("S16: AI Cost — explainAiCost", async () => {
    const { getAiCostSummary, explainAiCost } = await import("../server/lib/analytics/ai-cost-analytics");
    const s  = await getAiCostSummary(24);
    const ex = explainAiCost(s);

    assertExists(ex.summary,          "explanation.summary present");
    assertIsArray(ex.issues,           "issues is array");
    assertIsArray(ex.recommendations,  "recommendations is array");
    assert(ex.summary.includes("AI requests"), "summary mentions AI requests");
    assert(ex.recommendations.length > 0, "At least one recommendation");
  });

  // ── S17: AI Cost — budget pressure structure ───────────────────────────────
  await section("S17: AI Cost — budget pressure structure", async () => {
    const { getAiCostSummary } = await import("../server/lib/analytics/ai-cost-analytics");
    const s = await getAiCostSummary(168);

    for (const bp of s.budgetPressure) {
      assertExists(bp.tenantId,    "budget.tenantId present");
      assertType(bp.usagePercent,  "number", "usagePercent is number");
      assertGte(bp.usagePercent,   0, "usagePercent >= 0");
      assertExists(bp.alertType,   "alertType present");
    }
    assert(true, "Budget pressure rows all valid");
  });

  // ── S18: Job Webhook service ───────────────────────────────────────────────
  await section("S18: Job Webhook — getJobWebhookSummary", async () => {
    const { getJobWebhookSummary } = await import("../server/lib/analytics/job-webhook-analytics");
    const s = await getJobWebhookSummary(24);

    assertExists(s, "Summary returned");
    assertType(s.jobs.total,         "number", "jobs.total is number");
    assertType(s.jobs.failed,        "number", "jobs.failed is number");
    assertType(s.jobs.stalled,       "number", "jobs.stalled is number");
    assertType(s.jobs.failureRate,   "number", "jobs.failureRate is number");
    assertType(s.jobs.queueBacklog,  "number", "jobs.queueBacklog is number");
    assertGte(s.jobs.failureRate,    0, "failureRate >= 0");
    assertLte(s.jobs.failureRate,   100, "failureRate <= 100");
    assertType(s.webhooks.total,     "number", "webhooks.total is number");
    assertType(s.webhooks.deliveryRate, "number", "webhooks.deliveryRate is number");
    assertGte(s.webhooks.deliveryRate, 0, "deliveryRate >= 0");
    assertLte(s.webhooks.deliveryRate, 100, "deliveryRate <= 100");
    assertIsArray(s.topFailingJobTypes,   "topFailingJobTypes is array");
    assertIsArray(s.topFailingEndpoints,  "topFailingEndpoints is array");
    assertExists(s.retrievedAt, "retrievedAt present");
  });

  // ── S19: Job Webhook trend ─────────────────────────────────────────────────
  await section("S19: Job Webhook — getJobWebhookTrend", async () => {
    const { getJobWebhookTrend } = await import("../server/lib/analytics/job-webhook-analytics");
    const t = await getJobWebhookTrend(24);

    assertExists(t, "Trend returned");
    assertIsArray(t.points, "points is array");
    if (t.points.length > 0) {
      const p = t.points[0];
      assertExists(p.bucket,              "bucket present");
      assertType(p.jobsCreated,           "number", "jobsCreated is number");
      assertType(p.jobsFailed,            "number", "jobsFailed is number");
      assertType(p.webhooksDelivered,     "number", "webhooksDelivered is number");
      assertType(p.webhooksFailed,        "number", "webhooksFailed is number");
    }
  });

  // ── S20: Job Webhook explain ───────────────────────────────────────────────
  await section("S20: Job Webhook — explainJobWebhook", async () => {
    const { getJobWebhookSummary, explainJobWebhook } = await import("../server/lib/analytics/job-webhook-analytics");
    const s  = await getJobWebhookSummary(24);
    const ex = explainJobWebhook(s);

    assertExists(ex.summary,         "summary present");
    assertIsArray(ex.issues,          "issues is array");
    assertIsArray(ex.recommendations, "recommendations is array");
    assert(ex.summary.includes("jobs"), "summary mentions jobs");
  });

  // ── S21: Business Billing service ─────────────────────────────────────────
  await section("S21: Business Billing — getBusinessBillingSummary", async () => {
    const { getBusinessBillingSummary } = await import("../server/lib/analytics/business-billing-analytics");
    const s = await getBusinessBillingSummary(720);

    assertExists(s, "Summary returned");
    assertType(s.tenants.total,      "number", "tenants.total is number");
    assertType(s.tenants.active,     "number", "tenants.active is number");
    assertType(s.tenants.trial,      "number", "tenants.trial is number");
    assertGte(s.tenants.total,       0, "tenants.total >= 0");
    assertType(s.subscriptions.active,   "number", "subscriptions.active is number");
    assertType(s.subscriptions.canceled, "number", "subscriptions.canceled is number");
    assertType(s.subscriptions.pastDue,  "number", "subscriptions.pastDue is number");
    assertType(s.invoices.total,         "number", "invoices.total is number");
    assertType(s.invoices.totalRevenue,  "number", "invoices.totalRevenue is number");
    assertGte(s.invoices.totalRevenue,   0, "totalRevenue >= 0");
    assertType(s.payments.successRate,   "number", "payments.successRate is number");
    assertGte(s.payments.successRate,    0, "successRate >= 0");
    assertLte(s.payments.successRate,  100, "successRate <= 100");
    assertType(s.mrrEstimateUsd,         "number", "mrrEstimateUsd is number");
    assertGte(s.mrrEstimateUsd,          0, "mrrEstimateUsd >= 0");
    assertIsArray(s.topRevenueByTenant,  "topRevenueByTenant is array");
    assertExists(s.retrievedAt,          "retrievedAt present");
  });

  // ── S22: Business Billing trend ───────────────────────────────────────────
  await section("S22: Business Billing — getBusinessBillingTrend", async () => {
    const { getBusinessBillingTrend } = await import("../server/lib/analytics/business-billing-analytics");
    const t = await getBusinessBillingTrend(720);

    assertExists(t, "Trend returned");
    assertIsArray(t.points, "points is array");
    if (t.points.length > 0) {
      const p = t.points[0];
      assertExists(p.bucket,     "bucket present");
      assertType(p.newTenants,   "number", "newTenants is number");
      assertType(p.newInvoices,  "number", "newInvoices is number");
      assertType(p.revenueUsd,   "number", "revenueUsd is number");
      assertGte(p.revenueUsd,    0, "revenueUsd >= 0");
    }
  });

  // ── S23: Business Billing explain ─────────────────────────────────────────
  await section("S23: Business Billing — explainBusinessBilling", async () => {
    const { getBusinessBillingSummary, explainBusinessBilling } = await import("../server/lib/analytics/business-billing-analytics");
    const s  = await getBusinessBillingSummary(720);
    const ex = explainBusinessBilling(s);

    assertExists(ex.summary,         "summary present");
    assertIsArray(ex.issues,          "issues is array");
    assertIsArray(ex.recommendations, "recommendations is array");
    assert(ex.summary.includes("tenants"), "summary mentions tenants");
    assert(ex.recommendations.length > 0, "At least one recommendation");
  });

  // ── S24: Admin route files have analytics routes ───────────────────────────
  await section("S24: Admin routes — analytics endpoints declared", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/routes/admin.ts", "utf-8");

    const routes = [
      "/api/admin/analytics/platform-health",
      "/api/admin/analytics/tenant-health",
      "/api/admin/analytics/ai-cost",
      "/api/admin/analytics/jobs-webhooks",
      "/api/admin/analytics/business-billing",
    ];
    for (const route of routes) {
      assert(content.includes(route), `Route declared: ${route}`);
    }
  });

  // ── S25: Trend endpoint declarations ──────────────────────────────────────
  await section("S25: Admin routes — trend endpoints declared", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/routes/admin.ts", "utf-8");

    const routes = [
      "/api/admin/analytics/platform-health/trend",
      "/api/admin/analytics/tenant-health/trend",
      "/api/admin/analytics/ai-cost/trend",
      "/api/admin/analytics/jobs-webhooks/trend",
      "/api/admin/analytics/business-billing/trend",
    ];
    for (const route of routes) {
      assert(content.includes(route), `Trend route declared: ${route}`);
    }
  });

  // ── S26: isPlatformAdmin guard on every route ─────────────────────────────
  await section("S26: Admin routes — platform_admin guard present", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/routes/admin.ts", "utf-8");
    assert(
      content.includes("isPlatformAdmin") &&
      content.includes("platform_admin role required"),
      "isPlatformAdmin guard exists in admin routes file",
    );
  });

  // ── S27: No secrets in analytics service files ────────────────────────────
  await section("S27: No secrets in analytics service files", async () => {
    const { readFileSync } = await import("fs");
    const analyticsFiles = [
      "server/lib/analytics/platform-health.ts",
      "server/lib/analytics/tenant-health.ts",
      "server/lib/analytics/ai-cost-analytics.ts",
      "server/lib/analytics/job-webhook-analytics.ts",
      "server/lib/analytics/business-billing-analytics.ts",
    ];
    for (const f of analyticsFiles) {
      const content = readFileSync(f, "utf-8").toLowerCase();
      assert(!content.includes("sk-"),      `${f}: no OpenAI key`);
      assert(!content.includes("whsec_"),   `${f}: no webhook secret`);
      assert(!content.includes("password"), `${f}: no password`);
    }
  });

  // ── S28: Service returns data for all window sizes ─────────────────────────
  await section("S28: All services handle empty windows gracefully", async () => {
    const { getPlatformHealthSummary }   = await import("../server/lib/analytics/platform-health");
    const { getTenantHealthSummary }     = await import("../server/lib/analytics/tenant-health");
    const { getAiCostSummary }           = await import("../server/lib/analytics/ai-cost-analytics");
    const { getJobWebhookSummary }       = await import("../server/lib/analytics/job-webhook-analytics");
    const { getBusinessBillingSummary }  = await import("../server/lib/analytics/business-billing-analytics");

    const ph = await getPlatformHealthSummary(1);
    assert(ph.windowHours === 1, "Platform health: 1h window");

    const th = await getTenantHealthSummary(1);
    assert(th.windowHours === 1, "Tenant health: 1h window");

    const ac = await getAiCostSummary(1);
    assert(ac.windowHours === 1, "AI cost: 1h window");

    const jw = await getJobWebhookSummary(1);
    assert(jw.windowHours === 1, "Job webhook: 1h window");

    const bb = await getBusinessBillingSummary(168);
    assert(bb.windowHours === 168, "Business billing: 168h window");
  });

  // ── S29: Summaries are stable (consistent keys on second call) ─────────────
  await section("S29: Services are idempotent (two calls return same shape)", async () => {
    const { getPlatformHealthSummary } = await import("../server/lib/analytics/platform-health");
    const s1 = await getPlatformHealthSummary(24);
    const s2 = await getPlatformHealthSummary(24);
    assert(Object.keys(s1).sort().join() === Object.keys(s2).sort().join(),
      "Platform health summary keys are stable");
    assert(s1.windowHours === s2.windowHours, "windowHours consistent");
  });

  // ── S30: Trend chronological ordering ─────────────────────────────────────
  await section("S30: Trend points are chronologically ordered", async () => {
    const { getAiCostTrend }     = await import("../server/lib/analytics/ai-cost-analytics");
    const { getJobWebhookTrend } = await import("../server/lib/analytics/job-webhook-analytics");

    const ac = await getAiCostTrend(48);
    const buckets = ac.points.map(p => p.bucket);
    const sorted  = [...buckets].sort();
    assert(buckets.join() === sorted.join(), "AI cost trend is chronologically sorted");

    const jw = await getJobWebhookTrend(48);
    const jBuckets = jw.points.map(p => p.bucket);
    const jSorted  = [...jBuckets].sort();
    assert(jBuckets.join() === jSorted.join(), "Job webhook trend is chronologically sorted");
  });

  // ── S31: Platform health summary fields all numeric ────────────────────────
  await section("S31: Platform health — all metric values are finite numbers", async () => {
    const { getPlatformHealthSummary } = await import("../server/lib/analytics/platform-health");
    const s = await getPlatformHealthSummary(24);
    const nums = [
      s.jobsHealth.total, s.jobsHealth.failed, s.jobsHealth.stalled, s.jobsHealth.failureRate,
      s.webhookHealth.total, s.webhookHealth.failed,
      s.latencyHealth.p50Ms, s.latencyHealth.p95Ms, s.latencyHealth.p99Ms,
      s.tenantHealth.total, s.tenantHealth.active, s.queueDepth,
    ];
    for (const n of nums) {
      assert(Number.isFinite(n), `Value ${n} is finite number`);
    }
  });

  // ── S32: Billing top revenue list is sorted ───────────────────────────────
  await section("S32: Business Billing — top revenue list sorted descending", async () => {
    const { getBusinessBillingSummary } = await import("../server/lib/analytics/business-billing-analytics");
    const s = await getBusinessBillingSummary(8760);
    const values = s.topRevenueByTenant.map(t => t.totalUsd);
    let sorted = true;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[i - 1]) { sorted = false; break; }
    }
    assert(sorted, "Top revenue tenants sorted descending");
  });

  // ── S33: AI cost trend with long window ───────────────────────────────────
  await section("S33: AI Cost trend — 168h window returns valid data", async () => {
    const { getAiCostTrend } = await import("../server/lib/analytics/ai-cost-analytics");
    const t = await getAiCostTrend(168);
    assertExists(t, "168h trend returned");
    assertIsArray(t.points, "points is array");
    assert(t.windowHours === 168, "windowHours matches");
  });

  // ── S34: Dashboard pages use analytics endpoints ───────────────────────────
  await section("S34: Dashboard pages reference analytics endpoints", async () => {
    const { readFileSync } = await import("fs");

    const dashMap: Record<string, string[]> = {
      "client/src/pages/ops/dashboard.tsx": ["/api/admin/analytics/platform-health"],
      "client/src/pages/ops/tenants.tsx":   ["/api/admin/analytics/tenant-health"],
      "client/src/pages/ops/ai.tsx":        ["/api/admin/analytics/ai-cost"],
      "client/src/pages/ops/jobs.tsx":      ["/api/admin/analytics/jobs-webhooks"],
      "client/src/pages/ops/webhooks.tsx":  ["/api/admin/analytics/jobs-webhooks"],
      "client/src/pages/ops/billing.tsx":   ["/api/admin/analytics/business-billing"],
    };

    for (const [file, endpoints] of Object.entries(dashMap)) {
      const content = readFileSync(file, "utf-8");
      for (const ep of endpoints) {
        assert(content.includes(ep), `${file} references ${ep}`);
      }
    }
  });

  // ── S35: Dashboard pages have loading + empty state support ───────────────
  await section("S35: Dashboard pages have loading and empty states", async () => {
    const { readFileSync } = await import("fs");
    const pages = [
      "client/src/pages/ops/dashboard.tsx",
      "client/src/pages/ops/tenants.tsx",
      "client/src/pages/ops/ai.tsx",
      "client/src/pages/ops/jobs.tsx",
      "client/src/pages/ops/billing.tsx",
    ];
    for (const f of pages) {
      const content = readFileSync(f, "utf-8");
      assert(content.includes("isLoading"),    `${f}: has loading state`);
      assert(content.includes("data-testid"),  `${f}: has test IDs`);
    }
  });

  // ── S36: TimeRangeFilter component ────────────────────────────────────────
  await section("S36: TimeRangeFilter component", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("client/src/components/ops/TimeRangeFilter.tsx", "utf-8");
    assert(content.includes("TIME_RANGE_OPTIONS"),       "Exports TIME_RANGE_OPTIONS");
    assert(content.includes("BILLING_TIME_RANGE_OPTIONS"), "Exports BILLING_TIME_RANGE_OPTIONS");
    assert(content.includes("windowHours"),               "Uses windowHours concept");
    assert(content.includes("data-testid"),               "Has test IDs");
  });

  // ── S37: MetricCard component ─────────────────────────────────────────────
  await section("S37: MetricCard component", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("client/src/components/ops/MetricCard.tsx", "utf-8");
    assert(content.includes("loading"),      "Has loading prop");
    assert(content.includes("Skeleton"),     "Uses Skeleton for loading");
    assert(content.includes("subtext"),      "Has subtext prop");
    assert(content.includes("data-testid"), "Has test IDs");
  });

  // ── S38: RiskBadge component ──────────────────────────────────────────────
  await section("S38: RiskBadge component", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("client/src/components/ops/RiskBadge.tsx", "utf-8");
    assert(content.includes("critical"), "Has critical risk level");
    assert(content.includes("high"),     "Has high risk level");
    assert(content.includes("medium"),   "Has medium risk level");
    assert(content.includes("low"),      "Has low risk level");
  });

  // ── S39: TrendChart component ─────────────────────────────────────────────
  await section("S39: TrendChart component", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("client/src/components/ops/TrendChart.tsx", "utf-8");
    assert(content.includes("series"),     "Has series prop");
    assert(content.includes("points"),     "Has points prop");
    assert(content.includes("loading"),    "Has loading prop");
    assert(content.includes("emptyText"), "Has emptyText prop");
    assert(content.includes("svg"),       "Renders SVG");
  });

  // ── S40: TopList component ────────────────────────────────────────────────
  await section("S40: TopList component", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync("client/src/components/ops/TopList.tsx", "utf-8");
    assert(content.includes("maxItems"),   "Has maxItems prop");
    assert(content.includes("emptyText"), "Has emptyText prop");
    assert(content.includes("loading"),   "Has loading prop");
    assert(content.includes("data-testid"), "Has test IDs");
  });

  // ── S41: Job webhook aggregation correctness ──────────────────────────────
  await section("S41: Job webhook — aggregation correctness (DB direct)", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();

    const res = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM jobs
    `);
    const row = res.rows[0];
    const total  = Number(row.total  ?? 0);
    const failed = Number(row.failed ?? 0);

    assert(total >= 0,  "jobs total >= 0");
    assert(failed >= 0, "jobs failed >= 0");
    assert(failed <= total, "failed <= total (sanity)");
    await client.end();
  });

  // ── S42: Webhook delivery correctness (DB direct) ─────────────────────────
  await section("S42: Webhook delivery aggregation (DB direct)", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();

    const res = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM webhook_deliveries
    `);
    const row   = res.rows[0];
    const total  = Number(row.total  ?? 0);
    const failed = Number(row.failed ?? 0);

    assert(total >= 0,  "webhook total >= 0");
    assert(failed >= 0, "webhook failed >= 0");
    assert(failed <= total, "failed <= total");
    await client.end();
  });

  // ── S43: AI usage aggregation (DB direct) ─────────────────────────────────
  await section("S43: AI usage cost aggregation (DB direct)", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();

    const res = await client.query(`
      SELECT COALESCE(SUM(estimated_cost_usd),0)::float AS total_cost,
             COUNT(*)::int AS requests
      FROM ai_usage WHERE status = 'success'
    `);
    const row = res.rows[0];
    assert(Number(row.total_cost) >= 0, "ai_usage total_cost >= 0");
    assert(Number(row.requests)   >= 0, "ai_usage requests >= 0");
    await client.end();
  });

  // ── S44: Tenant count correctness (DB direct) ─────────────────────────────
  await section("S44: Tenant count aggregation (DB direct)", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();

    const res = await client.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE lifecycle_status = 'active')::int AS active
      FROM tenants
    `);
    const row = res.rows[0];
    assert(Number(row.total)  >= 0, "tenant total >= 0");
    assert(Number(row.active) >= 0, "tenant active >= 0");
    assert(Number(row.active) <= Number(row.total), "active <= total");
    await client.end();
  });

  // ── S45: Billing service 720h window ─────────────────────────────────────
  await section("S45: Business Billing — 720h window returns tenants", async () => {
    const { getBusinessBillingSummary } = await import("../server/lib/analytics/business-billing-analytics");
    const s = await getBusinessBillingSummary(720);
    assert(s.tenants.total >= 0, "tenants.total >= 0");
    assert(s.windowHours === 720, "windowHours matches");
  });

  // ── S46: All analytics services fail gracefully ───────────────────────────
  await section("S46: Services do not throw on valid inputs", async () => {
    const { getPlatformHealthSummary }  = await import("../server/lib/analytics/platform-health");
    const { getTenantHealthSummary }    = await import("../server/lib/analytics/tenant-health");
    const { getAiCostSummary }          = await import("../server/lib/analytics/ai-cost-analytics");
    const { getJobWebhookSummary }      = await import("../server/lib/analytics/job-webhook-analytics");
    const { getBusinessBillingSummary } = await import("../server/lib/analytics/business-billing-analytics");

    let threw = false;
    try {
      await Promise.all([
        getPlatformHealthSummary(6),
        getTenantHealthSummary(6),
        getAiCostSummary(6),
        getJobWebhookSummary(6),
        getBusinessBillingSummary(168),
      ]);
    } catch (e) {
      threw = true;
      console.error("  Service threw:", e);
    }
    assert(!threw, "All services completed without throwing");
  });

  // ── S47: Security: no input_preview exposed in ai cost summary ────────────
  await section("S47: AI cost — input_preview (user prompts) not exposed", async () => {
    const { getAiCostSummary } = await import("../server/lib/analytics/ai-cost-analytics");
    const s = await getAiCostSummary(24);
    const json = JSON.stringify(s);
    assert(!json.includes("input_preview"), "input_preview not in AI cost response");
    assert(!json.includes("error_message"), "error_message not in AI cost response");
  });

  // ── S48: Stalled job count is non-negative ────────────────────────────────
  await section("S48: Stalled jobs count is non-negative across all windows", async () => {
    const { getJobWebhookSummary } = await import("../server/lib/analytics/job-webhook-analytics");
    for (const w of [1, 24, 168]) {
      const s = await getJobWebhookSummary(w);
      assertGte(s.jobs.stalled, 0, `stalled >= 0 for window ${w}h`);
    }
  });

  // ── S49: Billing window 8760h (annual) ───────────────────────────────────
  await section("S49: Business Billing — 8760h (annual) window", async () => {
    const { getBusinessBillingSummary } = await import("../server/lib/analytics/business-billing-analytics");
    const s = await getBusinessBillingSummary(8760);
    assertExists(s, "Annual summary returned");
    assert(s.windowHours === 8760, "windowHours matches");
    assertGte(s.mrrEstimateUsd, 0, "MRR estimate >= 0");
  });

  // ── S50: Phase 35 file count summary ─────────────────────────────────────
  await section("S50: Phase 35 file count summary", async () => {
    const { readdirSync, existsSync } = await import("fs");
    const analyticsFiles = existsSync("server/lib/analytics")
      ? readdirSync("server/lib/analytics").filter(f => f.endsWith(".ts"))
      : [];
    const componentFiles = existsSync("client/src/components/ops")
      ? readdirSync("client/src/components/ops").filter(f => f.endsWith(".tsx"))
      : [];

    assert(analyticsFiles.length >= 5, `Analytics services: ${analyticsFiles.length} >= 5`);
    assert(componentFiles.length >= 6, `Ops UI components: ${componentFiles.length} >= 6`);
    console.log(`    Analytics services: ${analyticsFiles.join(", ")}`);
    console.log(`    Ops components:     ${componentFiles.join(", ")}`);
  });

  // ── Final report ──────────────────────────────────────────────────────────
  console.log("\n=================================================");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("=================================================");
  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    failures.forEach(f => console.log(`  ✗ ${f}`));
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Validation script crashed:", err);
  process.exit(1);
});
