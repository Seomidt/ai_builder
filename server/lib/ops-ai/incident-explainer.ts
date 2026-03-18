/**
 * Phase 33 — Incident Explainer
 *
 * TASK 5: Explains specific platform incidents.
 * Supported types: failed_jobs, webhook_failure_spike, billing_desync,
 *                  ai_budget_spike, brownout_transition, rate_limit_surge
 *
 * Rule B: No mutations triggered.
 * Rule C: Outputs grounded in real telemetry.
 */

import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { OPS_SYSTEM_PROMPT, buildIncidentPrompt, type TelemetryInput } from "./prompt-builder";
import { OpsAiResponseSchema, type OpsAiResponse, type IncidentRequest, type IncidentType } from "@shared/ops-ai-schema";
import { writeAuditRecord } from "./ops-ai-audit";

const OPS_AI_MODEL = "gpt-4o-mini";

// ── Telemetry gatherers per incident type ─────────────────────────────────────

async function gatherForFailedJobs(tenantId?: string): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getJobQueueSummary, getFailedJobs, getActiveJobs } = await import("../ops/job-inspector");
    const [summary, failed, active] = await Promise.all([
      getJobQueueSummary(), getFailedJobs(), getActiveJobs(),
    ]);
    t.jobSummary = summary as unknown as Record<string, unknown>;
    t.failedJobs = (failed as unknown[]).slice(0, 10);
    t.incidentContext = {
      totalActive:  (active as unknown[]).length,
      totalFailed:  (failed as unknown[]).length,
      tenantFilter: tenantId ?? "all",
    };
  } catch { /**/ }
  return t;
}

async function gatherForWebhookFailures(tenantId?: string): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getWebhookHealthSummary, getDeliveryFailureHistory } = await import("../ops/webhook-inspector");
    const [health, failures] = await Promise.all([
      getWebhookHealthSummary(), getDeliveryFailureHistory(),
    ]);
    t.webhookHealth   = health   as unknown as Record<string, unknown>;
    t.webhookFailures = (failures as unknown[]).slice(0, 10);
    t.incidentContext = { tenantFilter: tenantId ?? "all", failureCount: (failures as unknown[]).length };
  } catch { /**/ }
  return t;
}

async function gatherForAiBudgetSpike(tenantId?: string): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getGovernanceHealth } = await import("../ops/system-health");
    t.aiGovernance = (await getGovernanceHealth()) as unknown as Record<string, unknown>;
    t.incidentContext = { tenantFilter: tenantId ?? "all", incidentType: "ai_budget_spike" };
  } catch { /**/ }
  return t;
}

async function gatherForBillingDesync(): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getBillingHealth } = await import("../ops/system-health");
    t.billingHealth  = (await getBillingHealth()) as unknown as Record<string, unknown>;
    t.incidentContext = { incidentType: "billing_desync" };
  } catch { /**/ }
  return t;
}

async function gatherForRateLimitSurge(tenantId?: string): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getSecurityHealthSnapshot, getSecurityEventSummary } = await import("../ops/security-inspector");
    const [snapshot, summary] = await Promise.all([
      getSecurityHealthSnapshot(), getSecurityEventSummary(6),
    ]);
    t.securitySnapshot = snapshot as unknown as Record<string, unknown>;
    t.securitySummary  = summary  as unknown as Record<string, unknown>;
    t.incidentContext  = { tenantFilter: tenantId ?? "all", incidentType: "rate_limit_surge" };
  } catch { /**/ }
  return t;
}

async function gatherForBrownout(): Promise<TelemetryInput> {
  const t: TelemetryInput = {};
  try {
    const { getSystemHealthReport } = await import("../ops/system-health");
    const report = await getSystemHealthReport();
    t.systemHealth = {
      overallStatus: report.overallStatus,
      overallScore:  report.overallScore,
      subsystems: Object.fromEntries(
        Object.entries(report.subsystems).map(([k, v]) => [
          k, { status: v.status, score: v.score, issues: v.issues },
        ])
      ),
    };
    t.incidentContext = { incidentType: "brownout_transition" };
  } catch { /**/ }
  return t;
}

// ── telemetry router ──────────────────────────────────────────────────────────

async function gatherTelemetryForIncident(
  type: IncidentType,
  tenantId?: string,
): Promise<TelemetryInput> {
  switch (type) {
    case "failed_jobs":            return gatherForFailedJobs(tenantId);
    case "webhook_failure_spike":  return gatherForWebhookFailures(tenantId);
    case "ai_budget_spike":        return gatherForAiBudgetSpike(tenantId);
    case "billing_desync":         return gatherForBillingDesync();
    case "rate_limit_surge":       return gatherForRateLimitSurge(tenantId);
    case "brownout_transition":    return gatherForBrownout();
    default:                       return {};
  }
}

function buildFallbackExplanation(type: IncidentType): OpsAiResponse {
  return {
    overall_health:         "warning",
    summary:                `Incident type "${type}" received. AI analysis unavailable — OPENAI_API_KEY not configured.`,
    top_issues:             [{ title: `Incident: ${type}`, severity: "medium", evidence: [], confidence: "low" }],
    suspected_correlations: [],
    recommended_actions:    [{ action: "Configure OPENAI_API_KEY to enable incident analysis", reason: "AI assistant requires API access", priority: 1 }],
    unknowns:               ["AI analysis unavailable"],
  };
}

// ── Main: explainIncident ─────────────────────────────────────────────────────

export async function explainIncident(
  request: IncidentRequest,
  operatorId?: string,
): Promise<OpsAiResponse> {
  const telemetry = await gatherTelemetryForIncident(request.type, request.tenantId);

  if (!isOpenAIAvailable()) {
    const result = buildFallbackExplanation(request.type);
    await writeAuditRecord({
      requestType:     "explain",
      operatorId:      operatorId ?? null,
      inputScope:      { incidentType: request.type, tenantId: request.tenantId ?? null },
      responseSummary: result.summary,
      confidence:      "low",
      tokensUsed:      null,
      modelUsed:       "fallback",
    });
    return result;
  }

  const userPrompt = buildIncidentPrompt(request.type, telemetry);
  const raw = await chatJSON<OpsAiResponse>(OPS_SYSTEM_PROMPT, userPrompt, OPS_AI_MODEL, { agentKey: "ops-incident-explainer" });

  const parsed = OpsAiResponseSchema.safeParse(raw);
  const result = parsed.success ? parsed.data : raw as OpsAiResponse;

  await writeAuditRecord({
    requestType:     "explain",
    operatorId:      operatorId ?? null,
    inputScope:      { incidentType: request.type, tenantId: request.tenantId ?? null },
    responseSummary: result.summary?.slice(0, 500) ?? null,
    confidence:      result.top_issues?.[0]?.confidence ?? "medium",
    tokensUsed:      null,
    modelUsed:       OPS_AI_MODEL,
  });

  return result;
}
