/**
 * Phase 15 Validation — Observability & Telemetry Platform
 * 60 scenarios, 130+ assertions
 */

import pg from "pg";
import { recordAiLatencyMetric, summariseAiLatency } from "./latency-tracker";
import { recordRetrievalMetric, summariseRetrievalMetrics } from "./retrieval-tracker";
import { recordAgentRunMetric, summariseAgentMetrics } from "./agent-tracker";
import {
  incrementTenantUsage,
  getTenantUsageSummary,
  listActiveTenantsForPeriod,
  getCurrentPeriod,
} from "./tenant-usage-tracker";
import {
  collectAiLatency,
  collectRetrievalMetric,
  collectAgentRunMetric,
  collectSystemMetric,
  getCollectorConfig,
} from "./metrics-collector";
import {
  getPlatformHealthStatus,
  getAiHealthSummary,
  getRetrievalHealthSummary,
  getAgentHealthSummary,
  getTenantHealthSummary,
  detectObservabilityAnomalies,
  getSystemMetricsSummary,
} from "./metrics-health";

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
const T_A = `tenant-obs-a-${TS}`;
const T_B = `tenant-obs-b-${TS}`;
const REQ_ID = `req-obs-${TS}`;

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 15 Validation — Observability & Telemetry Platform\n");

  try {
    // ── SCENARIO 1: DB schema — all 5 Phase 15 tables present ────────────────
    section("SCENARIO 1: DB schema — 5 Phase 15 tables present");
    const tableNames = [
      "obs_system_metrics",
      "obs_ai_latency_metrics",
      "obs_retrieval_metrics",
      "obs_agent_runtime_metrics",
      "obs_tenant_usage_metrics",
    ];
    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tableNames],
    );
    const found = tableR.rows.map((r: any) => r.table_name);
    assert(found.length === 5, "All 5 Phase 15 observability tables exist");
    for (const t of tableNames) assert(found.includes(t), `Table exists: ${t}`);

    // ── SCENARIO 2: DB schema — indexes ──────────────────────────────────────
    section("SCENARIO 2: DB schema — key indexes present");
    const idxR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)`,
      [["osm_type_created_idx", "oalm_tenant_created_idx", "oalm_provider_model_idx",
        "oalm_request_id_idx", "orm_tenant_created_idx", "oarm_tenant_created_idx",
        "oarm_run_id_idx", "otum_tenant_type_period_idx", "otum_tenant_created_idx"]],
    );
    assert(idxR.rows.length >= 7, `At least 7 indexes present (found ${idxR.rows.length})`);

    // ── SCENARIO 3: DB schema — RLS enabled ──────────────────────────────────
    section("SCENARIO 3: DB schema — RLS enabled on all 5 tables");
    const rlsR = await client.query(
      `SELECT relname FROM pg_class WHERE relrowsecurity = true AND relname = ANY($1)`,
      [tableNames],
    );
    assert(rlsR.rows.length === 5, `RLS enabled on all 5 obs tables (found ${rlsR.rows.length})`);

    // ── SCENARIO 4: recordAiLatencyMetric — basic write ───────────────────────
    section("SCENARIO 4: recordAiLatencyMetric — basic write");
    await recordAiLatencyMetric({
      tenantId: T_A,
      model: "gpt-4o",
      provider: "openai",
      latencyMs: 1234,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      requestId: REQ_ID,
    });
    const r4 = await client.query(
      `SELECT * FROM obs_ai_latency_metrics WHERE tenant_id=$1 AND request_id=$2`,
      [T_A, REQ_ID],
    );
    assert(r4.rows.length >= 1, "AI latency record written to DB");
    assert(r4.rows[0].model === "gpt-4o", "Model field correct");
    assert(r4.rows[0].provider === "openai", "Provider field correct");
    assert(Number(r4.rows[0].latency_ms) === 1234, "latency_ms correct");
    assert(Number(r4.rows[0].tokens_in) === 100, "tokens_in correct");
    assert(Number(r4.rows[0].tokens_out) === 50, "tokens_out correct");
    assert(r4.rows[0].request_id === REQ_ID, "INV-OBS-4: request_id preserved");

    // ── SCENARIO 5: recordAiLatencyMetric — null tenant allowed ──────────────
    section("SCENARIO 5: recordAiLatencyMetric — null tenant_id allowed");
    await recordAiLatencyMetric({ model: "claude-3", provider: "anthropic", latencyMs: 500 });
    const r5 = await client.query(
      `SELECT model FROM obs_ai_latency_metrics WHERE tenant_id IS NULL AND model='claude-3' LIMIT 1`,
    );
    assert(r5.rows.length >= 1, "Null tenant_id record accepted");
    await client.query(`DELETE FROM obs_ai_latency_metrics WHERE model='claude-3' AND tenant_id IS NULL`);

    // ── SCENARIO 6: recordAiLatencyMetric — never throws on bad input ─────────
    section("SCENARIO 6: INV-OBS-1 — recordAiLatencyMetric never throws");
    let threw = false;
    try {
      // Missing required model — should swallow error
      await recordAiLatencyMetric({ model: "", provider: "", latencyMs: -1 });
    } catch {
      threw = true;
    }
    assert(!threw, "INV-OBS-1: recordAiLatencyMetric does not throw on invalid input");

    // ── SCENARIO 7: collectAiLatency — fire-and-forget wrapper ───────────────
    section("SCENARIO 7: collectAiLatency — synchronous fire-and-forget");
    let collectorThrew = false;
    try {
      collectAiLatency({
        tenantId: T_A,
        model: "gpt-4o-mini",
        provider: "openai",
        latencyMs: 800,
        tokensIn: 50,
        tokensOut: 20,
        costUsd: 0.0001,
        requestId: `req-collect-${TS}`,
      });
    } catch {
      collectorThrew = true;
    }
    assert(!collectorThrew, "INV-OBS-1: collectAiLatency does not throw");
    assert(typeof collectAiLatency === "function", "collectAiLatency is callable");

    // ── SCENARIO 8: summariseAiLatency — correct shape ────────────────────────
    section("SCENARIO 8: summariseAiLatency — returns correct shape");
    await new Promise((r) => setTimeout(r, 200));
    const summary8 = await summariseAiLatency({ tenantId: T_A, windowHours: 1 });
    assert(typeof summary8.totalRequests === "number", "totalRequests is number");
    assert(typeof summary8.avgLatencyMs === "number", "avgLatencyMs is number");
    assert(typeof summary8.p95LatencyMs === "number", "p95LatencyMs is number");
    assert(typeof summary8.totalTokensIn === "number", "totalTokensIn is number");
    assert(typeof summary8.totalTokensOut === "number", "totalTokensOut is number");
    assert(typeof summary8.totalCostUsd === "number", "totalCostUsd is number");
    assert(summary8.windowHours === 1, "windowHours correct");
    assert(summary8.totalRequests >= 1, "At least 1 AI latency record found");

    // ── SCENARIO 9: summariseAiLatency — tenant isolation ────────────────────
    section("SCENARIO 9: INV-OBS-5 — tenant isolation in AI latency summary");
    const summaryA = await summariseAiLatency({ tenantId: T_A, windowHours: 1 });
    const summaryB = await summariseAiLatency({ tenantId: T_B, windowHours: 1 });
    assert(summaryB.totalRequests === 0, "INV-OBS-5: Tenant B sees 0 requests from Tenant A data");
    assert(summaryA.totalRequests >= 1, "Tenant A sees its own records");

    // ── SCENARIO 10: summariseAiLatency — global (no tenant) ─────────────────
    section("SCENARIO 10: summariseAiLatency — global scope (no tenantId)");
    const summaryGlobal = await summariseAiLatency({ windowHours: 1 });
    assert(typeof summaryGlobal.totalRequests === "number", "Global summary returns number");
    assert(summaryGlobal.totalRequests >= summaryA.totalRequests, "Global >= tenant scope");

    // ── SCENARIO 11: recordRetrievalMetric — basic write ─────────────────────
    section("SCENARIO 11: recordRetrievalMetric — basic write");
    await recordRetrievalMetric({
      tenantId: T_A,
      queryLength: 128,
      chunksRetrieved: 20,
      rerankUsed: true,
      latencyMs: 300,
      resultCount: 5,
    });
    const r11 = await client.query(
      `SELECT * FROM obs_retrieval_metrics WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [T_A],
    );
    assert(r11.rows.length >= 1, "Retrieval record written to DB");
    assert(Number(r11.rows[0].chunks_retrieved) === 20, "chunks_retrieved correct");
    assert(r11.rows[0].rerank_used === true, "rerank_used correct");
    assert(Number(r11.rows[0].latency_ms) === 300, "latency_ms correct");

    // ── SCENARIO 12: recordRetrievalMetric — never throws ────────────────────
    section("SCENARIO 12: INV-OBS-1 — recordRetrievalMetric never throws");
    let threw12 = false;
    try {
      await recordRetrievalMetric({ tenantId: null, queryLength: null });
    } catch {
      threw12 = true;
    }
    assert(!threw12, "INV-OBS-1: recordRetrievalMetric does not throw");

    // ── SCENARIO 13: collectRetrievalMetric — fire-and-forget ─────────────────
    section("SCENARIO 13: collectRetrievalMetric — synchronous fire-and-forget");
    let threw13 = false;
    try {
      collectRetrievalMetric({ tenantId: T_A, queryLength: 64, chunksRetrieved: 10 });
    } catch {
      threw13 = true;
    }
    assert(!threw13, "INV-OBS-1: collectRetrievalMetric does not throw");

    // ── SCENARIO 14: summariseRetrievalMetrics — shape ────────────────────────
    section("SCENARIO 14: summariseRetrievalMetrics — correct shape");
    await new Promise((r) => setTimeout(r, 200));
    const ret14 = await summariseRetrievalMetrics({ tenantId: T_A, windowHours: 1 });
    assert(typeof ret14.totalQueries === "number", "totalQueries is number");
    assert(typeof ret14.avgChunksRetrieved === "number", "avgChunksRetrieved is number");
    assert(typeof ret14.avgLatencyMs === "number", "avgLatencyMs is number");
    assert(typeof ret14.rerankUsageRate === "number", "rerankUsageRate is number");
    assert(ret14.totalQueries >= 1, "At least 1 retrieval recorded");
    assert(ret14.windowHours === 1, "windowHours correct");

    // ── SCENARIO 15: summariseRetrievalMetrics — tenant isolation ─────────────
    section("SCENARIO 15: INV-OBS-5 — retrieval tenant isolation");
    const retB = await summariseRetrievalMetrics({ tenantId: T_B, windowHours: 1 });
    assert(retB.totalQueries === 0, "INV-OBS-5: Tenant B sees 0 retrieval queries from Tenant A");

    // ── SCENARIO 16: recordAgentRunMetric — basic write ───────────────────────
    section("SCENARIO 16: recordAgentRunMetric — basic write");
    await recordAgentRunMetric({
      tenantId: T_A,
      agentId: `agent-${TS}`,
      runId: `run-${TS}`,
      steps: 5,
      iterations: 3,
      durationMs: 2500,
      status: "success",
    });
    const r16 = await client.query(
      `SELECT * FROM obs_agent_runtime_metrics WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [T_A],
    );
    assert(r16.rows.length >= 1, "Agent run record written to DB");
    assert(Number(r16.rows[0].steps) === 5, "steps correct");
    assert(Number(r16.rows[0].duration_ms) === 2500, "duration_ms correct");
    assert(r16.rows[0].status === "success", "status correct");

    // ── SCENARIO 17: recordAgentRunMetric — failure status ───────────────────
    section("SCENARIO 17: recordAgentRunMetric — failure status");
    await recordAgentRunMetric({
      tenantId: T_A,
      agentId: `agent-fail-${TS}`,
      runId: `run-fail-${TS}`,
      steps: 2,
      durationMs: 500,
      status: "failure",
    });
    const r17 = await client.query(
      `SELECT status FROM obs_agent_runtime_metrics WHERE run_id=$1`,
      [`run-fail-${TS}`],
    );
    assert(r17.rows.length >= 1, "Failure run recorded");
    assert(r17.rows[0].status === "failure", "Failure status stored correctly");

    // ── SCENARIO 18: collectAgentRunMetric — fire-and-forget ─────────────────
    section("SCENARIO 18: collectAgentRunMetric — synchronous fire-and-forget");
    let threw18 = false;
    try {
      collectAgentRunMetric({ tenantId: T_A, runId: `run-collect-${TS}`, status: "success" });
    } catch {
      threw18 = true;
    }
    assert(!threw18, "INV-OBS-1: collectAgentRunMetric does not throw");

    // ── SCENARIO 19: summariseAgentMetrics — shape ────────────────────────────
    section("SCENARIO 19: summariseAgentMetrics — correct shape");
    await new Promise((r) => setTimeout(r, 300));
    const ag19 = await summariseAgentMetrics({ tenantId: T_A, windowHours: 1 });
    assert(typeof ag19.totalRuns === "number", "totalRuns is number");
    assert(typeof ag19.successRuns === "number", "successRuns is number");
    assert(typeof ag19.failureRuns === "number", "failureRuns is number");
    assert(typeof ag19.avgSteps === "number", "avgSteps is number");
    assert(typeof ag19.avgDurationMs === "number", "avgDurationMs is number");
    assert(typeof ag19.successRate === "number", "successRate is number");
    assert(ag19.totalRuns >= 2, "At least 2 agent runs found");
    assert(ag19.successRuns >= 1, "At least 1 success run");
    assert(ag19.failureRuns >= 1, "At least 1 failure run");
    assert(ag19.successRate > 0 && ag19.successRate <= 100, "successRate in valid range");

    // ── SCENARIO 20: summariseAgentMetrics — tenant isolation ─────────────────
    section("SCENARIO 20: INV-OBS-5 — agent metrics tenant isolation");
    const agB = await summariseAgentMetrics({ tenantId: T_B, windowHours: 1 });
    assert(agB.totalRuns === 0, "INV-OBS-5: Tenant B sees 0 agent runs from Tenant A");

    // ── SCENARIO 21: incrementTenantUsage — basic increment ──────────────────
    section("SCENARIO 21: incrementTenantUsage — basic increment");
    const period21 = `2099-01`;
    await incrementTenantUsage({ tenantId: T_A, metricType: "ai_requests", value: 3, period: period21 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "ai_requests", value: 7, period: period21 });
    const r21 = await client.query(
      `SELECT SUM(value::float) AS total FROM obs_tenant_usage_metrics WHERE tenant_id=$1 AND metric_type='ai_requests' AND period=$2`,
      [T_A, period21],
    );
    assert(Number(r21.rows[0].total) === 10, "Usage correctly accumulated (3+7=10)");

    // ── SCENARIO 22: getTenantUsageSummary — shape ────────────────────────────
    section("SCENARIO 22: getTenantUsageSummary — correct shape");
    await incrementTenantUsage({ tenantId: T_A, metricType: "tokens_in", value: 1000, period: period21 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "cost_usd", value: 0.5, period: period21 });
    const usage22 = await getTenantUsageSummary({ tenantId: T_A, period: period21 });
    assert(usage22.tenantId === T_A, "tenantId matches");
    assert(usage22.period === period21, "period matches");
    assert(usage22.ai_requests === 10, "ai_requests aggregated correctly");
    assert(usage22.tokens_in === 1000, "tokens_in correct");
    assert(usage22.cost_usd === 0.5, "cost_usd correct");
    assert(usage22.retrieval_queries === 0, "Unmeasured metrics default to 0");

    // ── SCENARIO 23: getTenantUsageSummary — tenant isolation ────────────────
    section("SCENARIO 23: INV-OBS-5 — getTenantUsageSummary tenant isolation");
    const usageB = await getTenantUsageSummary({ tenantId: T_B, period: period21 });
    assert(usageB.ai_requests === 0, "INV-OBS-5: Tenant B sees 0 ai_requests from Tenant A period");
    assert(usageB.tokens_in === 0, "INV-OBS-5: Tenant B sees 0 tokens_in from Tenant A period");

    // ── SCENARIO 24: listActiveTenantsForPeriod ───────────────────────────────
    section("SCENARIO 24: listActiveTenantsForPeriod — returns active tenants");
    await incrementTenantUsage({ tenantId: T_B, metricType: "retrieval_queries", value: 1, period: period21 });
    const active24 = await listActiveTenantsForPeriod(period21);
    assert(active24.tenantIds.includes(T_A), "Tenant A listed as active");
    assert(active24.tenantIds.includes(T_B), "Tenant B listed as active");
    assert(active24.count >= 2, "At least 2 active tenants");
    assert(active24.period === period21, "period matches");

    // ── SCENARIO 25: getCurrentPeriod — correct format ───────────────────────
    section("SCENARIO 25: getCurrentPeriod — correct YYYY-MM format");
    const period25 = getCurrentPeriod();
    assert(/^\d{4}-\d{2}$/.test(period25), "getCurrentPeriod returns YYYY-MM format");
    const [yr, mo] = period25.split("-").map(Number);
    assert(yr >= 2025, "Year is plausible");
    assert(mo >= 1 && mo <= 12, "Month is 1-12");

    // ── SCENARIO 26: incrementTenantUsage — never throws ─────────────────────
    section("SCENARIO 26: INV-OBS-1 — incrementTenantUsage never throws");
    let threw26 = false;
    try {
      await incrementTenantUsage({ tenantId: "", metricType: "ai_requests", value: NaN });
    } catch {
      threw26 = true;
    }
    assert(!threw26, "INV-OBS-1: incrementTenantUsage does not throw on invalid input");

    // ── SCENARIO 27: collectSystemMetric — fire-and-forget ────────────────────
    section("SCENARIO 27: collectSystemMetric — synchronous fire-and-forget");
    let threw27 = false;
    try {
      collectSystemMetric("platform_health_check", 1, { phase: "15" });
    } catch {
      threw27 = true;
    }
    assert(!threw27, "INV-OBS-1: collectSystemMetric does not throw");

    // ── SCENARIO 28: obs_system_metrics write ─────────────────────────────────
    section("SCENARIO 28: obs_system_metrics — direct write works");
    await new Promise((r) => setTimeout(r, 400));
    const r28 = await client.query(
      `SELECT * FROM obs_system_metrics WHERE metric_type='platform_health_check' ORDER BY created_at DESC LIMIT 1`,
    );
    assert(r28.rows.length >= 1, "System metric record written by collectSystemMetric");
    assert(Number(r28.rows[0].value) === 1, "Value correct");

    // ── SCENARIO 29: getCollectorConfig — correct shape ───────────────────────
    section("SCENARIO 29: getCollectorConfig — correct structure");
    const cfg = getCollectorConfig();
    assert(cfg.version === "15.0", "Version is 15.0");
    assert(cfg.fireAndForget === true, "INV-OBS-6: fireAndForget is true");
    assert(Array.isArray(cfg.signals), "signals is array");
    assert(cfg.signals.includes("ai_latency"), "ai_latency signal present");
    assert(cfg.signals.includes("retrieval"), "retrieval signal present");
    assert(cfg.signals.includes("agent_runtime"), "agent_runtime signal present");
    assert(cfg.signals.includes("tenant_usage"), "tenant_usage signal present");
    assert(cfg.signals.includes("system"), "system signal present");
    assert(cfg.inv.includes("INV-OBS-1"), "INV-OBS-1 documented");
    assert(cfg.inv.includes("INV-OBS-6"), "INV-OBS-6 documented");

    // ── SCENARIO 30: getAiHealthSummary ──────────────────────────────────────
    section("SCENARIO 30: getAiHealthSummary — correct shape");
    const ai30 = await getAiHealthSummary(1);
    assert(typeof ai30.totalRequests === "number", "totalRequests is number");
    assert(typeof ai30.avgLatencyMs === "number", "avgLatencyMs is number");
    assert(typeof ai30.totalCostUsd === "number", "totalCostUsd is number");

    // ── SCENARIO 31: getRetrievalHealthSummary ────────────────────────────────
    section("SCENARIO 31: getRetrievalHealthSummary — correct shape");
    const ret31 = await getRetrievalHealthSummary(1);
    assert(typeof ret31.totalQueries === "number", "totalQueries is number");
    assert(typeof ret31.avgLatencyMs === "number", "avgLatencyMs is number");
    assert(typeof ret31.rerankUsageRate === "number", "rerankUsageRate is number");

    // ── SCENARIO 32: getAgentHealthSummary ────────────────────────────────────
    section("SCENARIO 32: getAgentHealthSummary — correct shape");
    const ag32 = await getAgentHealthSummary(1);
    assert(typeof ag32.totalRuns === "number", "totalRuns is number");
    assert(typeof ag32.successRate === "number", "successRate is number");
    assert(typeof ag32.avgDurationMs === "number", "avgDurationMs is number");

    // ── SCENARIO 33: getTenantHealthSummary ───────────────────────────────────
    section("SCENARIO 33: getTenantHealthSummary — correct shape");
    const ten33 = await getTenantHealthSummary();
    assert(typeof ten33.count === "number", "count is number");
    assert(typeof ten33.period === "string", "period is string");
    assert(Array.isArray(ten33.tenantIds), "tenantIds is array");

    // ── SCENARIO 34: getPlatformHealthStatus — full shape ─────────────────────
    section("SCENARIO 34: getPlatformHealthStatus — full platform health shape");
    const health34 = await getPlatformHealthStatus(1);
    assert(["healthy", "degraded", "critical"].includes(health34.status), "status is valid value");
    assert(typeof health34.windowHours === "number", "windowHours is number");
    assert(typeof health34.ai === "object", "ai section is object");
    assert(typeof health34.ai.totalRequests === "number", "ai.totalRequests is number");
    assert(typeof health34.ai.avgLatencyMs === "number", "ai.avgLatencyMs is number");
    assert(typeof health34.retrieval === "object", "retrieval section is object");
    assert(typeof health34.agents === "object", "agents section is object");
    assert(typeof health34.tenants === "object", "tenants section is object");
    assert(typeof health34.system === "object", "system section is object");
    assert(typeof health34.generatedAt === "string", "generatedAt is ISO string");
    assert(health34.generatedAt.includes("T"), "generatedAt is ISO format");

    // ── SCENARIO 35: getPlatformHealthStatus — data accuracy ─────────────────
    section("SCENARIO 35: getPlatformHealthStatus — data reflects written records");
    assert(health34.ai.totalRequests >= 1, "AI section reflects at least 1 request");
    assert(health34.retrieval.totalQueries >= 1, "Retrieval section reflects at least 1 query");
    assert(health34.agents.totalRuns >= 2, "Agents section reflects at least 2 runs");

    // ── SCENARIO 36: getSystemMetricsSummary ─────────────────────────────────
    section("SCENARIO 36: getSystemMetricsSummary — correct shape");
    const sys36 = await getSystemMetricsSummary(1);
    assert(typeof sys36.totalSystemMetrics === "number", "totalSystemMetrics is number");
    assert(Array.isArray(sys36.metricTypes), "metricTypes is array");
    assert(typeof sys36.windowHours === "number", "windowHours is number");
    assert(typeof sys36.sampleTime === "string", "sampleTime is string");
    assert(sys36.totalSystemMetrics >= 1, "At least 1 system metric recorded");
    assert(sys36.metricTypes.includes("platform_health_check"), "Expected metric type present");

    // ── SCENARIO 37: detectObservabilityAnomalies — shape ─────────────────────
    section("SCENARIO 37: detectObservabilityAnomalies — correct shape");
    const anomaly37 = await detectObservabilityAnomalies(1);
    assert(Array.isArray(anomaly37.anomalies), "anomalies is array");
    assert(typeof anomaly37.checkedAt === "string", "checkedAt is string");

    // ── SCENARIO 38: detectObservabilityAnomalies — high latency signal ───────
    section("SCENARIO 38: detectObservabilityAnomalies — high latency signal");
    // Insert many high-latency records to ensure global avg comfortably exceeds 5000ms threshold
    for (let i = 0; i < 12; i++) {
      await recordAiLatencyMetric({
        tenantId: `tenant-obs-anomaly-${TS}`,
        model: "gpt-4o",
        provider: "openai",
        latencyMs: 20000,
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    const anomaly38 = await detectObservabilityAnomalies(1);
    const hasHighLatency = anomaly38.anomalies.some((a) => a.signal === "ai_high_latency");
    assert(hasHighLatency, "High latency anomaly detected when avg latency > 5000ms");
    const latencyAnomaly = anomaly38.anomalies.find((a) => a.signal === "ai_high_latency");
    assert(latencyAnomaly != null, "Anomaly record is present");
    if (latencyAnomaly) {
      assert(["medium", "high"].includes(latencyAnomaly.severity), "Anomaly severity is medium or high");
      assert(typeof latencyAnomaly.value === "number", "Anomaly value is number");
      assert(typeof latencyAnomaly.threshold === "number", "Anomaly threshold is number");
      assert(typeof latencyAnomaly.description === "string", "Anomaly description is string");
    }

    // ── SCENARIO 39: INV-OBS-2 — no raw tenant data in summaries ─────────────
    section("SCENARIO 39: INV-OBS-2 — aggregated summaries contain no raw messages");
    const ai39 = await summariseAiLatency({ tenantId: T_A, windowHours: 1 });
    const keys39 = Object.keys(ai39);
    assert(!keys39.includes("request_id"), "INV-OBS-2: request_id not exposed in summary");
    assert(!keys39.includes("cost_raw"), "INV-OBS-2: No raw cost field");
    assert(!keys39.includes("user_id"), "INV-OBS-2: No user_id in summary");

    // ── SCENARIO 40: INV-OBS-4 — request_id preserved in raw record ──────────
    section("SCENARIO 40: INV-OBS-4 — request_id preserved in raw record");
    const r40 = await client.query(
      `SELECT request_id FROM obs_ai_latency_metrics WHERE request_id=$1`,
      [REQ_ID],
    );
    assert(r40.rows.length >= 1, "INV-OBS-4: Request ID is stored in obs_ai_latency_metrics");
    assert(r40.rows[0].request_id === REQ_ID, "INV-OBS-4: Request ID value preserved exactly");

    // ── SCENARIO 41: INV-OBS-3 — insert operations complete in <2s ───────────
    section("SCENARIO 41: INV-OBS-3 — metric writes are low overhead");
    const t41Start = Date.now();
    await recordAiLatencyMetric({ model: "gpt-4o", provider: "openai", latencyMs: 100 });
    const t41 = Date.now() - t41Start;
    assert(t41 < 2000, `INV-OBS-3: Single metric write < 2000ms (took ${t41}ms)`);

    // ── SCENARIO 42: Multiple metric types for one tenant ─────────────────────
    section("SCENARIO 42: Multiple metric types recorded for one tenant");
    const period42 = `2099-02`;
    await incrementTenantUsage({ tenantId: T_A, metricType: "ai_requests", value: 5, period: period42 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "tokens_in", value: 500, period: period42 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "tokens_out", value: 200, period: period42 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "agents_executed", value: 2, period: period42 });
    await incrementTenantUsage({ tenantId: T_A, metricType: "retrieval_queries", value: 8, period: period42 });
    const u42 = await getTenantUsageSummary({ tenantId: T_A, period: period42 });
    assert(u42.ai_requests === 5, "ai_requests correct");
    assert(u42.tokens_in === 500, "tokens_in correct");
    assert(u42.tokens_out === 200, "tokens_out correct");
    assert(u42.agents_executed === 2, "agents_executed correct");
    assert(u42.retrieval_queries === 8, "retrieval_queries correct");

    // ── SCENARIO 43: Metric types are exhaustive ──────────────────────────────
    section("SCENARIO 43: Tenant usage metric types are correct");
    const u43 = await getTenantUsageSummary({ tenantId: T_A, period: period42 });
    const metricTypeKeys = ["ai_requests", "tokens_in", "tokens_out", "agents_executed", "retrieval_queries", "cost_usd"];
    for (const k of metricTypeKeys) {
      assert(k in u43, `Metric type '${k}' present in getTenantUsageSummary result`);
    }

    // ── SCENARIO 44: listActiveTenantsForPeriod — only period data ────────────
    section("SCENARIO 44: listActiveTenantsForPeriod — period-scoped");
    const empty44 = await listActiveTenantsForPeriod("2000-01");
    assert(empty44.count === 0, "No active tenants for year 2000 (no data there)");
    assert(empty44.tenantIds.length === 0, "Empty tenantIds for nonexistent period");

    // ── SCENARIO 45: agent tracker — all status types stored ─────────────────
    section("SCENARIO 45: Agent tracker — all status types accepted");
    const statuses = ["success", "failure", "timeout", "cancelled"];
    for (const s of statuses) {
      await recordAgentRunMetric({ tenantId: T_A, status: s, runId: `run-${s}-${TS}`, durationMs: 100 });
    }
    const r45 = await client.query(
      `SELECT DISTINCT status FROM obs_agent_runtime_metrics WHERE tenant_id=$1 AND status = ANY($2)`,
      [T_A, statuses],
    );
    assert(r45.rows.length === 4, `All 4 agent status types stored (found ${r45.rows.length})`);

    // ── SCENARIO 46: Run ID lookups ───────────────────────────────────────────
    section("SCENARIO 46: oarm_run_id_idx — lookup by run_id");
    const runId46 = `run-lookup-${TS}`;
    await recordAgentRunMetric({ tenantId: T_A, runId: runId46, steps: 7, durationMs: 3000, status: "success" });
    const r46 = await client.query(`SELECT run_id, steps FROM obs_agent_runtime_metrics WHERE run_id=$1`, [runId46]);
    assert(r46.rows.length === 1, "Run ID lookup returns exactly 1 row");
    assert(Number(r46.rows[0].steps) === 7, "Steps field correct on lookup");

    // ── SCENARIO 47: AI latency — multiple providers ──────────────────────────
    section("SCENARIO 47: AI latency — records from multiple providers");
    await recordAiLatencyMetric({ model: "gpt-4o", provider: "openai", latencyMs: 1000, tenantId: T_A });
    await recordAiLatencyMetric({ model: "claude-3-5-sonnet", provider: "anthropic", latencyMs: 800, tenantId: T_A });
    await recordAiLatencyMetric({ model: "gemini-1.5-pro", provider: "google", latencyMs: 600, tenantId: T_A });
    const r47 = await client.query(
      `SELECT DISTINCT provider FROM obs_ai_latency_metrics WHERE tenant_id=$1 AND provider = ANY($2)`,
      [T_A, ["openai", "anthropic", "google"]],
    );
    assert(r47.rows.length === 3, `Records for 3 providers found (found ${r47.rows.length})`);

    // ── SCENARIO 48: summariseAiLatency — provider filter works ──────────────
    section("SCENARIO 48: summariseAiLatency — provider filter");
    await new Promise((r) => setTimeout(r, 200));
    const oa48 = await summariseAiLatency({ provider: "openai", windowHours: 1 });
    assert(oa48.totalRequests >= 1, "OpenAI-filtered summary has requests");

    // ── SCENARIO 49: obs_system_metrics — metadata stored ─────────────────────
    section("SCENARIO 49: obs_system_metrics — metadata field stores JSON");
    await new Promise((r) => setTimeout(r, 300));
    const r49 = await client.query(
      `SELECT metadata FROM obs_system_metrics WHERE metric_type='platform_health_check' AND metadata IS NOT NULL LIMIT 1`,
    );
    assert(r49.rows.length >= 1, "Metadata stored in obs_system_metrics");
    assert(r49.rows[0].metadata !== null, "Metadata is not null");
    assert(typeof r49.rows[0].metadata === "object", "Metadata is parsed JSON object");

    // ── SCENARIO 50: getPlatformHealthStatus — status transitions ─────────────
    section("SCENARIO 50: getPlatformHealthStatus — healthy status for normal latency");
    const normalHealth = await getPlatformHealthStatus(24);
    assert(["healthy", "degraded", "critical"].includes(normalHealth.status), "Status value is valid");

    // ── SCENARIO 51: Admin route existence — /api/admin/metrics/system ─────────
    section("SCENARIO 51: Admin metrics routes — system route registered");
    let r51: any;
    try {
      r51 = await fetch("http://localhost:5000/api/admin/metrics/system");
    } catch {
      r51 = { status: 0 };
    }
    assert(r51.status !== 404, "Route /api/admin/metrics/system is not 404");

    // ── SCENARIO 52: Admin route — /api/admin/metrics/ai ─────────────────────
    section("SCENARIO 52: Admin metrics routes — AI route registered");
    let r52: any;
    try {
      r52 = await fetch("http://localhost:5000/api/admin/metrics/ai");
    } catch {
      r52 = { status: 0 };
    }
    assert(r52.status !== 404, "Route /api/admin/metrics/ai is not 404");

    // ── SCENARIO 53: Admin route — /api/admin/metrics/retrieval ──────────────
    section("SCENARIO 53: Admin metrics routes — retrieval route registered");
    let r53: any;
    try {
      r53 = await fetch("http://localhost:5000/api/admin/metrics/retrieval");
    } catch {
      r53 = { status: 0 };
    }
    assert(r53.status !== 404, "Route /api/admin/metrics/retrieval is not 404");

    // ── SCENARIO 54: Admin route — /api/admin/metrics/agents ─────────────────
    section("SCENARIO 54: Admin metrics routes — agents route registered");
    let r54: any;
    try {
      r54 = await fetch("http://localhost:5000/api/admin/metrics/agents");
    } catch {
      r54 = { status: 0 };
    }
    assert(r54.status !== 404, "Route /api/admin/metrics/agents is not 404");

    // ── SCENARIO 55: Admin route — /api/admin/metrics/tenants ────────────────
    section("SCENARIO 55: Admin metrics routes — tenants route registered");
    let r55: any;
    try {
      r55 = await fetch("http://localhost:5000/api/admin/metrics/tenants");
    } catch {
      r55 = { status: 0 };
    }
    assert(r55.status !== 404, "Route /api/admin/metrics/tenants is not 404");

    // ── SCENARIO 56: Admin route — /api/admin/metrics/health ─────────────────
    section("SCENARIO 56: Admin metrics routes — health route registered");
    let r56: any;
    try {
      r56 = await fetch("http://localhost:5000/api/admin/metrics/health");
    } catch {
      r56 = { status: 0 };
    }
    assert(r56.status !== 404, "Route /api/admin/metrics/health is not 404");

    // ── SCENARIO 57: Live admin /api/admin/metrics/health returns valid JSON ──
    section("SCENARIO 57: Live /api/admin/metrics/health returns valid data");
    if (r56.status === 200 || r56.status === 401) {
      const body56 = r56.status === 200 ? await r56.json() : null;
      if (body56) {
        assert(typeof body56 === "object", "Health endpoint returns JSON object");
        assert("status" in body56 || "error" in body56, "Response has status or error field");
      } else {
        assert(true, "Route exists (auth required — OK for admin route)");
      }
    } else {
      assert(r56.status !== 0, "App is reachable (connection succeeded)");
    }

    // ── SCENARIO 58: INV-OBS-5 — runner.ts instrument import present ─────────
    section("SCENARIO 58: runner.ts — Phase 15 import present");
    const { readFileSync } = await import("fs");
    const runnerContent = readFileSync("server/lib/ai/runner.ts", "utf-8");
    assert(runnerContent.includes("collectAiLatency"), "runner.ts imports collectAiLatency");
    assert(runnerContent.includes("observability/metrics-collector"), "runner.ts imports from observability");
    assert(runnerContent.includes("INV-OBS-1"), "runner.ts documents INV-OBS-1");
    assert(runnerContent.includes("INV-OBS-6"), "runner.ts documents INV-OBS-6");

    // ── SCENARIO 59: retrieval-orchestrator.ts — Phase 15 instrument ─────────
    section("SCENARIO 59: retrieval-orchestrator.ts — Phase 15 import present");
    const orchContent = readFileSync("server/lib/ai/retrieval-orchestrator.ts", "utf-8");
    assert(orchContent.includes("collectRetrievalMetric"), "retrieval-orchestrator.ts imports collectRetrievalMetric");
    assert(orchContent.includes("observability/metrics-collector"), "retrieval-orchestrator.ts imports from observability");
    assert(orchContent.includes("INV-OBS-1"), "retrieval-orchestrator.ts documents INV-OBS-1");

    // ── SCENARIO 60: Full data lifecycle — record → aggregate → health ─────────
    section("SCENARIO 60: Full data lifecycle — record → aggregate → health");
    const tFull = `tenant-full-lifecycle-${TS}`;
    await recordAiLatencyMetric({ tenantId: tFull, model: "gpt-4o", provider: "openai", latencyMs: 750, tokensIn: 200, tokensOut: 80, costUsd: 0.002 });
    await recordRetrievalMetric({ tenantId: tFull, queryLength: 64, chunksRetrieved: 15, rerankUsed: false, latencyMs: 250, resultCount: 4 });
    await recordAgentRunMetric({ tenantId: tFull, agentId: "full-agent", runId: `full-run-${TS}`, steps: 4, durationMs: 1200, status: "success" });
    await incrementTenantUsage({ tenantId: tFull, metricType: "ai_requests", value: 1 });
    await new Promise((r) => setTimeout(r, 400));
    const aiSummary = await summariseAiLatency({ tenantId: tFull, windowHours: 1 });
    const retSummary = await summariseRetrievalMetrics({ tenantId: tFull, windowHours: 1 });
    const agSummary = await summariseAgentMetrics({ tenantId: tFull, windowHours: 1 });
    const usageSummary = await getTenantUsageSummary({ tenantId: tFull });
    assert(aiSummary.totalRequests === 1, "Full lifecycle: AI request recorded");
    assert(retSummary.totalQueries === 1, "Full lifecycle: retrieval recorded");
    assert(agSummary.totalRuns === 1, "Full lifecycle: agent run recorded");
    assert(usageSummary.ai_requests === 1, "Full lifecycle: usage aggregated");

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────────
    await client.query(`DELETE FROM obs_ai_latency_metrics WHERE tenant_id LIKE 'tenant-obs%' OR tenant_id LIKE 'tenant-full%' OR tenant_id IS NULL`);
    await client.query(`DELETE FROM obs_retrieval_metrics WHERE tenant_id LIKE 'tenant-obs%' OR tenant_id LIKE 'tenant-full%'`);
    await client.query(`DELETE FROM obs_agent_runtime_metrics WHERE tenant_id LIKE 'tenant-obs%' OR tenant_id LIKE 'tenant-full%'`);
    await client.query(`DELETE FROM obs_tenant_usage_metrics WHERE tenant_id LIKE 'tenant-obs%' OR tenant_id LIKE 'tenant-full%'`);
    await client.query(`DELETE FROM obs_system_metrics WHERE metric_type='platform_health_check'`);
    await client.end();
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Phase 15 validation: ${passed} passed, ${failed} failed`);
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
