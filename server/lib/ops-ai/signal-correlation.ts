/**
 * Phase 33 — Signal Correlation
 *
 * Identifies likely relationships across platform subsystems:
 * jobs, webhooks, billing, AI usage, security events.
 *
 * Rule A: Correlation is inference only — grounded in telemetry.
 * Rule D: Explicitly states when evidence is insufficient.
 */

import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { OPS_SYSTEM_PROMPT, buildHealthSummaryPrompt, type TelemetryInput } from "./prompt-builder";
import { OpsAiResponseSchema, type OpsAiResponse } from "@shared/ops-ai-schema";
import { writeAuditRecord } from "./ops-ai-audit";

const OPS_AI_MODEL = "gpt-4o-mini";
const CORRELATION_SYSTEM_PROMPT = OPS_SYSTEM_PROMPT + `

CORRELATION FOCUS:
Your primary task is to identify CROSS-SUBSYSTEM relationships.
Focus especially on:
- Whether job failures correlate with webhook delivery failures
- Whether AI budget spikes correlate with security events
- Whether billing anomalies correlate with usage pattern changes
- Whether rate limit surges correlate with job queue growth
Report all correlations in the "suspected_correlations" array.
If no correlation is evident, return suspected_correlations: [] and note this in unknowns.
`;

// ── Gather broad telemetry ────────────────────────────────────────────────────

async function gatherAllTelemetry(): Promise<TelemetryInput> {
  const results = await Promise.allSettled([
    (async () => {
      const { getSystemHealthReport } = await import("../ops/system-health");
      const r = await getSystemHealthReport();
      return { overallStatus: r.overallStatus, overallScore: r.overallScore,
               subsystems: Object.fromEntries(Object.entries(r.subsystems).map(([k, v]) => [k, { status: v.status, score: v.score, issues: v.issues.slice(0, 3) }])) };
    })(),
    (async () => {
      const { getJobQueueSummary, getFailedJobs } = await import("../ops/job-inspector");
      return { summary: await getJobQueueSummary(), failed: (await getFailedJobs()).slice(0, 5) };
    })(),
    (async () => {
      const { getWebhookHealthSummary, getDeliveryFailureHistory } = await import("../ops/webhook-inspector");
      return { health: await getWebhookHealthSummary(), failures: (await getDeliveryFailureHistory()).slice(0, 5) };
    })(),
    (async () => {
      const { getSecurityHealthSnapshot } = await import("../ops/security-inspector");
      return await getSecurityHealthSnapshot();
    })(),
    (async () => {
      const { getGovernanceHealth } = await import("../ops/system-health");
      return await getGovernanceHealth();
    })(),
    (async () => {
      const { getBillingHealth } = await import("../ops/system-health");
      return await getBillingHealth();
    })(),
  ]);

  const t: TelemetryInput = {};
  if (results[0].status === "fulfilled") t.systemHealth    = results[0].value as Record<string, unknown>;
  if (results[1].status === "fulfilled") { const v = results[1].value as any; t.jobSummary = v.summary; t.failedJobs = v.failed; }
  if (results[2].status === "fulfilled") { const v = results[2].value as any; t.webhookHealth = v.health; t.webhookFailures = v.failures; }
  if (results[3].status === "fulfilled") t.securitySnapshot = results[3].value as Record<string, unknown>;
  if (results[4].status === "fulfilled") t.aiGovernance     = results[4].value as Record<string, unknown>;
  if (results[5].status === "fulfilled") t.billingHealth    = results[5].value as Record<string, unknown>;
  return t;
}

// ── Main: correlateSignals ────────────────────────────────────────────────────

export async function correlateSignals(operatorId?: string): Promise<OpsAiResponse> {
  const telemetry = await gatherAllTelemetry();

  if (!isOpenAIAvailable()) {
    const result: OpsAiResponse = {
      overall_health: "warning",
      summary: "Signal correlation requires AI (OPENAI_API_KEY not configured).",
      top_issues: [],
      suspected_correlations: [],
      recommended_actions: [{ action: "Configure OPENAI_API_KEY", reason: "Required for signal correlation", priority: 1 }],
      unknowns: ["AI unavailable — correlation analysis cannot be performed"],
    };
    await writeAuditRecord({ requestType: "correlate", operatorId: operatorId ?? null, inputScope: {}, responseSummary: result.summary, confidence: "low", tokensUsed: null, modelUsed: "fallback" });
    return result;
  }

  const userPrompt = buildHealthSummaryPrompt(telemetry);
  const raw = await chatJSON<OpsAiResponse>(CORRELATION_SYSTEM_PROMPT, userPrompt, OPS_AI_MODEL, { agentKey: "ops-signal-correlation" });

  const parsed = OpsAiResponseSchema.safeParse(raw);
  const result = parsed.success ? parsed.data : raw as OpsAiResponse;

  await writeAuditRecord({
    requestType:     "correlate",
    operatorId:      operatorId ?? null,
    inputScope:      { subsystemsAnalysed: Object.keys(telemetry).filter((k) => (telemetry as any)[k] != null) },
    responseSummary: result.summary?.slice(0, 500) ?? null,
    confidence:      result.suspected_correlations?.[0]?.confidence ?? "medium",
    tokensUsed:      null,
    modelUsed:       OPS_AI_MODEL,
  });

  return result;
}
