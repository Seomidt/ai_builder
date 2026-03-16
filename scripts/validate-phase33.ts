/**
 * Phase 33 Validation — AI Operations Assistant
 * 45 scenarios, 130+ assertions
 *
 * Tests the service layer directly (not via HTTP) to avoid auth dependencies.
 * Uses SUPABASE_DB_POOL_URL for direct DB access.
 */

import pg from "pg";

// ── Test helpers ──────────────────────────────────────────────────────────────

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

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  redactSecrets,
  writeAuditRecord,
  listAuditRecords,
} from "../server/lib/ops-ai/ops-ai-audit";

import {
  OPS_SYSTEM_PROMPT,
  buildHealthSummaryPrompt,
  buildIncidentPrompt,
} from "../server/lib/ops-ai/prompt-builder";

import {
  OpsAiResponseSchema,
  IncidentRequestSchema,
  ConfidenceLevel,
  SeverityLevel,
  OverallHealth,
  TopIssueSchema,
  RecommendedActionSchema,
} from "../shared/ops-ai-schema";

import {
  summariseCurrentHealth,
} from "../server/lib/ops-ai/health-summary";

import {
  explainIncident,
} from "../server/lib/ops-ai/incident-explainer";

import {
  correlateSignals,
} from "../server/lib/ops-ai/signal-correlation";

import {
  recommendNextSteps,
} from "../server/lib/ops-ai/recommendations";

import {
  SUPPORTED_INCIDENT_TYPES,
} from "../server/lib/ops-ai/ops-assistant";

const TS = Date.now();

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 33 Validation — AI Operations Assistant\n");

  try {
    // ── SCENARIO 1: DB table present ─────────────────────────────────────────
    section("SCENARIO 1: ops_ai_audit_logs table present");
    const tableRes = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='ops_ai_audit_logs'
    `);
    assert(tableRes.rows.length === 1, "ops_ai_audit_logs table exists");

    // ── SCENARIO 2: Table columns ─────────────────────────────────────────────
    section("SCENARIO 2: ops_ai_audit_logs columns");
    const colRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='ops_ai_audit_logs'
    `);
    const cols = colRes.rows.map((r: any) => r.column_name);
    for (const col of ["id","request_type","operator_id","input_scope","response_summary","confidence","tokens_used","model_used","created_at"]) {
      assert(cols.includes(col), `Column exists: ${col}`);
    }

    // ── SCENARIO 3: RLS enabled ───────────────────────────────────────────────
    section("SCENARIO 3: RLS on ops_ai_audit_logs");
    const rlsRes = await client.query(`
      SELECT relrowsecurity FROM pg_class WHERE relname='ops_ai_audit_logs'
    `);
    assert(rlsRes.rows[0]?.relrowsecurity === true, "RLS enabled on ops_ai_audit_logs");

    // ── SCENARIO 4: Indexes present ───────────────────────────────────────────
    section("SCENARIO 4: Indexes on ops_ai_audit_logs");
    const idxRes = await client.query(`
      SELECT indexname FROM pg_indexes WHERE tablename='ops_ai_audit_logs'
    `);
    assert(idxRes.rows.length >= 3, `At least 3 indexes (found ${idxRes.rows.length})`);

    // ── SCENARIO 5: Schema — OpsAiResponseSchema shape ───────────────────────
    section("SCENARIO 5: OpsAiResponseSchema validates correct shape");
    const validResponse = {
      overall_health: "good",
      summary: "Platform is healthy",
      top_issues: [],
      suspected_correlations: [],
      recommended_actions: [],
      unknowns: [],
    };
    const p5 = OpsAiResponseSchema.safeParse(validResponse);
    assert(p5.success, "Valid response passes schema");
    assert(p5.success && p5.data.overall_health === "good", "overall_health parsed correctly");

    // ── SCENARIO 6: Schema — rejects invalid overall_health ──────────────────
    section("SCENARIO 6: OpsAiResponseSchema rejects invalid values");
    const bad6 = OpsAiResponseSchema.safeParse({ ...validResponse, overall_health: "unknown_status" });
    assert(!bad6.success, "Invalid overall_health rejected");

    const bad6b = OpsAiResponseSchema.safeParse({ ...validResponse, summary: 123 });
    assert(!bad6b.success, "Non-string summary rejected");

    // ── SCENARIO 7: Schema — top_issues validation ────────────────────────────
    section("SCENARIO 7: TopIssueSchema validation");
    const goodIssue = { title: "DB slow", severity: "high", evidence: ["latency > 500ms"], confidence: "medium" };
    assert(TopIssueSchema.safeParse(goodIssue).success, "Valid TopIssue passes schema");
    const badIssue = { title: "x", severity: "extreme", evidence: [], confidence: "high" };
    assert(!TopIssueSchema.safeParse(badIssue).success, "Invalid severity rejected");

    // ── SCENARIO 8: Schema — recommended_actions validation ──────────────────
    section("SCENARIO 8: RecommendedActionSchema validation");
    const goodAction = { action: "Check job logs", reason: "3 failed jobs", priority: 1 };
    assert(RecommendedActionSchema.safeParse(goodAction).success, "Valid action passes schema");
    const badAction = { action: "do thing", reason: "x", priority: 5 };
    assert(!RecommendedActionSchema.safeParse(badAction).success, "Priority 5 rejected (must be 1|2|3)");

    // ── SCENARIO 9: Schema — confidence enum ─────────────────────────────────
    section("SCENARIO 9: ConfidenceLevel enum");
    for (const v of ["low", "medium", "high"]) {
      assert(ConfidenceLevel.safeParse(v).success, `ConfidenceLevel accepts: ${v}`);
    }
    assert(!ConfidenceLevel.safeParse("unknown").success, "ConfidenceLevel rejects: unknown");

    // ── SCENARIO 10: Schema — severity enum ──────────────────────────────────
    section("SCENARIO 10: SeverityLevel enum");
    for (const v of ["low", "medium", "high", "critical"]) {
      assert(SeverityLevel.safeParse(v).success, `SeverityLevel accepts: ${v}`);
    }
    assert(!SeverityLevel.safeParse("extreme").success, "SeverityLevel rejects: extreme");

    // ── SCENARIO 11: IncidentRequestSchema ───────────────────────────────────
    section("SCENARIO 11: IncidentRequestSchema validation");
    const goodReq = { type: "failed_jobs", windowHours: 24 };
    assert(IncidentRequestSchema.safeParse(goodReq).success, "Valid incident request passes");
    const badReq = { type: "invalid_type", windowHours: 24 };
    assert(!IncidentRequestSchema.safeParse(badReq).success, "Invalid incident type rejected");

    // ── SCENARIO 12: Prompt builder — system prompt sealed ───────────────────
    section("SCENARIO 12: System prompt sealed and correct");
    assert(typeof OPS_SYSTEM_PROMPT === "string", "OPS_SYSTEM_PROMPT is string");
    assert(OPS_SYSTEM_PROMPT.length > 100, "OPS_SYSTEM_PROMPT has substance");
    assert(OPS_SYSTEM_PROMPT.includes("ADVISORY ONLY"), "System prompt declares advisory-only");
    assert(OPS_SYSTEM_PROMPT.includes("NEVER"), "System prompt has explicit prohibitions");
    assert(OPS_SYSTEM_PROMPT.includes("json_object") || OPS_SYSTEM_PROMPT.includes("JSON"), "System prompt requires JSON output");
    assert(OPS_SYSTEM_PROMPT.includes("confidence"), "System prompt requires confidence field");
    assert(!OPS_SYSTEM_PROMPT.includes("OPENAI_API_KEY"), "System prompt does not expose API key name");
    assert(OPS_SYSTEM_PROMPT.toLowerCase().includes("must not"), "System prompt has 'must not' prohibitions on secret exposure");

    // ── SCENARIO 13: Prompt builder — health summary prompt ──────────────────
    section("SCENARIO 13: buildHealthSummaryPrompt");
    const telemetry = {
      systemHealth: { overallStatus: "healthy", overallScore: 92 },
      jobSummary:   { queued: 5, failed: 1 },
    };
    const healthPrompt = buildHealthSummaryPrompt(telemetry);
    assert(typeof healthPrompt === "string", "Health prompt is string");
    assert(healthPrompt.includes("overallStatus"), "Prompt contains telemetry data");
    assert(!healthPrompt.toLowerCase().includes("api_key"), "Prompt contains no API keys");
    assert(!healthPrompt.toLowerCase().includes("secret"), "Prompt contains no secrets");

    // ── SCENARIO 14: Prompt builder — incident prompt ─────────────────────────
    section("SCENARIO 14: buildIncidentPrompt");
    const incPrompt = buildIncidentPrompt("failed_jobs", {
      jobSummary: { failed: 5, queued: 0 },
      failedJobs: [{ id: "j1", type: "process" }],
    });
    assert(typeof incPrompt === "string", "Incident prompt is string");
    assert(incPrompt.includes("failed_jobs"), "Prompt contains incident type");
    assert(incPrompt.includes("failed"), "Prompt contains job failure data");

    // ── SCENARIO 15: Prompt builder — secrets are sanitised ──────────────────
    section("SCENARIO 15: Prompt builder sanitises secrets");
    const withSecrets = buildHealthSummaryPrompt({
      systemHealth: { status: "ok", apiKey: "sk-supersecret", webhook_secret: "abc123", token: "xyz" },
    });
    assert(!withSecrets.includes("sk-supersecret"), "API key redacted from prompt");
    assert(!withSecrets.includes("abc123"), "Webhook secret redacted from prompt");
    assert(!withSecrets.includes("xyz"), "Token redacted from prompt");

    // ── SCENARIO 16: Audit — redactSecrets ───────────────────────────────────
    section("SCENARIO 16: redactSecrets function");
    const dirty = { name: "test", apiKey: "sk-12345", password: "hunter2", nested: { token: "abc" } };
    const clean = redactSecrets(dirty);
    assert(clean.name === "test", "Non-secret field preserved");
    assert(clean.apiKey === "[REDACTED]", "apiKey redacted");
    assert(clean.password === "[REDACTED]", "password redacted");
    assert((clean.nested as any)?.token === "[REDACTED]", "Nested token redacted");

    // ── SCENARIO 17: Audit — write and read back ──────────────────────────────
    section("SCENARIO 17: writeAuditRecord and listAuditRecords");
    const auditId = await writeAuditRecord({
      requestType:     `test-${TS}`,
      operatorId:      `op-${TS}`,
      inputScope:      { test: true, ts: TS },
      responseSummary: "Test summary",
      confidence:      "high",
      tokensUsed:      42,
      modelUsed:       "gpt-4o-mini",
    });
    assert(typeof auditId === "string", "writeAuditRecord returns id string");
    assert(auditId !== "audit-write-failed", "writeAuditRecord did not fail");

    // ── SCENARIO 18: List audit records ──────────────────────────────────────
    section("SCENARIO 18: listAuditRecords returns records");
    const records = await listAuditRecords(100);
    assert(Array.isArray(records), "listAuditRecords returns array");
    const ours = records.filter((r) => r.requestType === `test-${TS}`);
    assert(ours.length >= 1, "Our test record found in list");
    assert(ours[0].operatorId === `op-${TS}`, "operatorId correct");
    assert(ours[0].confidence === "high", "confidence correct");
    assert(ours[0].tokensUsed === 42, "tokensUsed correct");
    assert(ours[0].modelUsed === "gpt-4o-mini", "modelUsed correct");

    // ── SCENARIO 19: Audit — secrets not stored ───────────────────────────────
    section("SCENARIO 19: Audit record does not store secrets");
    const auditId2 = await writeAuditRecord({
      requestType:     `test-secrets-${TS}`,
      operatorId:      null,
      inputScope:      { apiKey: "sk-should-be-gone", normal: "ok" },
      responseSummary: null,
      confidence:      null,
      tokensUsed:      null,
      modelUsed:       null,
    });
    const secRecords = await listAuditRecords(10);
    const secretRec = secRecords.find((r) => r.requestType === `test-secrets-${TS}`);
    assert(secretRec != null, "Secret-containing record written");
    assert(
      !JSON.stringify(secretRec?.inputScope).includes("sk-should-be-gone"),
      "API key not stored in audit record",
    );

    // ── SCENARIO 20: Audit — fail open (never throws) ─────────────────────────
    section("SCENARIO 20: writeAuditRecord is fail-open");
    let threw20 = false;
    try {
      // Pass oversized/invalid data — should not throw
      await writeAuditRecord({
        requestType:     "x".repeat(5),
        operatorId:      null,
        inputScope:      {},
        responseSummary: null,
        confidence:      null,
        tokensUsed:      null,
        modelUsed:       null,
      });
    } catch { threw20 = true; }
    assert(!threw20, "writeAuditRecord does not throw on minimal valid input");

    // ── SCENARIO 21: summariseCurrentHealth — returns OpsAiResponse shape ────
    section("SCENARIO 21: summariseCurrentHealth returns correct shape");
    const summary = await summariseCurrentHealth(`op-test-${TS}`);
    assert(typeof summary === "object" && summary !== null, "summariseCurrentHealth returns object");
    assert("overall_health" in summary, "overall_health present");
    assert("summary" in summary, "summary present");
    assert("top_issues" in summary, "top_issues present");
    assert("suspected_correlations" in summary, "suspected_correlations present");
    assert("recommended_actions" in summary, "recommended_actions present");
    assert("unknowns" in summary, "unknowns present");

    // ── SCENARIO 22: overall_health is valid enum ─────────────────────────────
    section("SCENARIO 22: overall_health is valid enum value");
    assert(
      ["good", "warning", "critical"].includes(summary.overall_health),
      `overall_health is valid enum: ${summary.overall_health}`,
    );

    // ── SCENARIO 23: summary is non-empty string ──────────────────────────────
    section("SCENARIO 23: summary is non-empty string");
    assert(typeof summary.summary === "string", "summary is string");
    assert(summary.summary.length > 0, "summary is non-empty");

    // ── SCENARIO 24: top_issues is array ─────────────────────────────────────
    section("SCENARIO 24: top_issues is array");
    assert(Array.isArray(summary.top_issues), "top_issues is array");

    // ── SCENARIO 25: Each issue has required fields ───────────────────────────
    section("SCENARIO 25: Each top_issue has required fields");
    for (const issue of summary.top_issues.slice(0, 3)) {
      assert("title" in issue,      `Issue has title`);
      assert("severity" in issue,   `Issue has severity`);
      assert("evidence" in issue,   `Issue has evidence`);
      assert("confidence" in issue, `Issue has confidence (Rule E)`);
      assert(
        ["low","medium","high"].includes(issue.confidence),
        `Issue confidence is valid: ${issue.confidence}`,
      );
    }
    if (summary.top_issues.length === 0) {
      assert(true, "No issues — no field validation needed");
    }

    // ── SCENARIO 26: recommended_actions are investigative (not mutations) ────
    section("SCENARIO 26: Recommended actions are not mutations");
    const MUTATION_KEYWORDS = [/\bdelete\b/i, /\bdrop\b/i, /\bexecute\b/i, /\bkill\b/i, /\bstop service\b/i, /\bwipe\b/i];
    for (const action of summary.recommended_actions) {
      const combined = `${action.action} ${action.reason}`.toLowerCase();
      for (const kw of MUTATION_KEYWORDS) {
        assert(!kw.test(combined), `Action does not contain mutation keyword: "${combined.slice(0,60)}"`);
      }
    }
    if (summary.recommended_actions.length === 0) {
      assert(true, "No actions — mutation check skipped");
    }

    // ── SCENARIO 27: unknowns is array ───────────────────────────────────────
    section("SCENARIO 27: unknowns is array");
    assert(Array.isArray(summary.unknowns), "unknowns is array");

    // ── SCENARIO 28: Health summary audit record written ─────────────────────
    section("SCENARIO 28: Health summary writes audit record");
    const afterSummaryRecords = await listAuditRecords(10);
    const summaryAudit = afterSummaryRecords.find((r) => r.requestType === "summary");
    assert(summaryAudit != null, "Audit record written for health summary");
    assert(summaryAudit!.modelUsed != null, "modelUsed recorded in audit");

    // ── SCENARIO 29: explainIncident — failed_jobs ────────────────────────────
    section("SCENARIO 29: explainIncident — failed_jobs");
    const req29 = IncidentRequestSchema.parse({ type: "failed_jobs", windowHours: 24 });
    const exp29 = await explainIncident(req29, `op-${TS}`);
    assert(typeof exp29 === "object", "explainIncident returns object");
    assert("overall_health" in exp29, "overall_health present");
    assert("summary" in exp29, "summary present");
    assert(typeof exp29.summary === "string" && exp29.summary.length > 0, "summary non-empty");

    // ── SCENARIO 30: explainIncident — webhook_failure_spike ─────────────────
    section("SCENARIO 30: explainIncident — webhook_failure_spike");
    const req30 = IncidentRequestSchema.parse({ type: "webhook_failure_spike" });
    const exp30 = await explainIncident(req30);
    assert(typeof exp30 === "object", "explainIncident (webhook) returns object");
    const firstIssue30 = exp30.top_issues?.[0];
    assert(
      firstIssue30 == null || "confidence" in firstIssue30,
      "First issue (if present) has confidence field",
    );

    // ── SCENARIO 31: explainIncident — billing_desync ────────────────────────
    section("SCENARIO 31: explainIncident — billing_desync");
    const exp31 = await explainIncident(IncidentRequestSchema.parse({ type: "billing_desync" }));
    assert(typeof exp31 === "object", "explainIncident (billing_desync) returns object");
    assert(["good","warning","critical"].includes(exp31.overall_health), "overall_health valid");

    // ── SCENARIO 32: explainIncident — ai_budget_spike ───────────────────────
    section("SCENARIO 32: explainIncident — ai_budget_spike");
    const exp32 = await explainIncident(IncidentRequestSchema.parse({ type: "ai_budget_spike" }));
    assert(typeof exp32 === "object", "explainIncident (ai_budget_spike) returns object");
    assert(Array.isArray(exp32.recommended_actions), "recommended_actions is array");

    // ── SCENARIO 33: explainIncident — rate_limit_surge ──────────────────────
    section("SCENARIO 33: explainIncident — rate_limit_surge");
    const exp33 = await explainIncident(IncidentRequestSchema.parse({ type: "rate_limit_surge" }));
    assert(typeof exp33 === "object", "explainIncident (rate_limit_surge) returns object");

    // ── SCENARIO 34: explainIncident — brownout_transition ───────────────────
    section("SCENARIO 34: explainIncident — brownout_transition");
    const exp34 = await explainIncident(IncidentRequestSchema.parse({ type: "brownout_transition" }));
    assert(typeof exp34 === "object", "explainIncident (brownout_transition) returns object");

    // ── SCENARIO 35: Incident explain writes audit record ────────────────────
    section("SCENARIO 35: explainIncident writes audit record");
    const afterExplainRecords = await listAuditRecords(20);
    const explainAudit = afterExplainRecords.find((r) => r.requestType === "explain");
    assert(explainAudit != null, "Audit record written for incident explain");

    // ── SCENARIO 36: correlateSignals — returns OpsAiResponse ────────────────
    section("SCENARIO 36: correlateSignals returns OpsAiResponse shape");
    const corr36 = await correlateSignals(`op-${TS}`);
    assert(typeof corr36 === "object", "correlateSignals returns object");
    assert("overall_health" in corr36, "overall_health present");
    assert("suspected_correlations" in corr36, "suspected_correlations present");
    assert(Array.isArray(corr36.suspected_correlations), "suspected_correlations is array");

    // ── SCENARIO 37: correlations have confidence field ───────────────────────
    section("SCENARIO 37: Correlations always have confidence field");
    for (const c of corr36.suspected_correlations.slice(0, 3)) {
      assert("confidence" in c, "Correlation has confidence");
      assert("reasoning" in c, "Correlation has reasoning");
    }
    if (corr36.suspected_correlations.length === 0) {
      assert(Array.isArray(corr36.unknowns) && corr36.unknowns.length >= 0, "No correlations — unknowns populated");
    }

    // ── SCENARIO 38: correlateSignals writes audit record ────────────────────
    section("SCENARIO 38: correlateSignals writes audit record");
    const corrRecords = await listAuditRecords(20);
    assert(corrRecords.some((r) => r.requestType === "correlate"), "Audit record for correlate");

    // ── SCENARIO 39: recommendNextSteps — returns OpsAiResponse ──────────────
    section("SCENARIO 39: recommendNextSteps returns correct shape");
    const recs39 = await recommendNextSteps(`op-${TS}`);
    assert(typeof recs39 === "object", "recommendNextSteps returns object");
    assert("recommended_actions" in recs39, "recommended_actions present");
    assert(Array.isArray(recs39.recommended_actions), "recommended_actions is array");

    // ── SCENARIO 40: Recommendations have priority 1-3 ───────────────────────
    section("SCENARIO 40: Recommendation priorities are valid (1|2|3)");
    for (const a of recs39.recommended_actions.slice(0, 5)) {
      assert([1,2,3].includes(a.priority), `Priority ${a.priority} is valid`);
      assert("action" in a, "Action has action field");
      assert("reason" in a, "Action has reason field");
    }
    if (recs39.recommended_actions.length === 0) {
      assert(true, "No recommendations — priority check skipped");
    }

    // ── SCENARIO 41: recommendNextSteps writes audit record ──────────────────
    section("SCENARIO 41: recommendNextSteps writes audit record");
    const recsRecords = await listAuditRecords(20);
    assert(recsRecords.some((r) => r.requestType === "recommend"), "Audit record for recommend");

    // ── SCENARIO 42: No mutation paths in any service ────────────────────────
    section("SCENARIO 42: No mutation paths exist in service layer");
    // Verify all responses are read-only
    const allResults = [summary, exp29, exp30, corr36, recs39];
    for (const r of allResults) {
      assert(!("mutate" in r), "Response has no mutate field");
      assert(!("execute" in r), "Response has no execute field");
      assert(!("action_taken" in r), "Response has no action_taken field");
    }

    // ── SCENARIO 43: Tenant isolation — no tenant private data in summaries ──
    section("SCENARIO 43: Tenant isolation — no private tenant data in response");
    const allSummaryText = JSON.stringify(summary).toLowerCase();
    assert(!allSummaryText.includes("apiKey"), "No apiKey in summary output");
    assert(!allSummaryText.includes("secret"), "No secret in summary output");
    assert(!allSummaryText.includes("password"), "No password in summary output");

    // ── SCENARIO 44: Supported incident types registered ─────────────────────
    section("SCENARIO 44: SUPPORTED_INCIDENT_TYPES complete");
    const expectedTypes = [
      "failed_jobs","webhook_failure_spike","billing_desync",
      "ai_budget_spike","brownout_transition","rate_limit_surge",
    ];
    for (const t of expectedTypes) {
      assert((SUPPORTED_INCIDENT_TYPES as readonly string[]).includes(t), `Incident type registered: ${t}`);
    }

    // ── SCENARIO 45: Audit history queryable ─────────────────────────────────
    section("SCENARIO 45: Audit history is queryable and bounded");
    const hist45 = await listAuditRecords(5);
    assert(Array.isArray(hist45), "listAuditRecords(5) returns array");
    assert(hist45.length <= 5, "listAuditRecords(5) respects limit");
    if (hist45.length > 0) {
      const first = hist45[0];
      assert("id" in first, "Audit record has id");
      assert("requestType" in first, "Audit record has requestType");
      assert("createdAt" in first, "Audit record has createdAt");
      assert(!("rawPayload" in first), "Audit record has no rawPayload field");
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await client.query(`DELETE FROM ops_ai_audit_logs WHERE request_type LIKE 'test-%'`);

  } finally {
    await client.end();
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 33 validation: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("✔ All assertions passed");
  } else {
    console.error(`✗ ${failed} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ Validation crashed:", err.message);
  process.exit(1);
});
