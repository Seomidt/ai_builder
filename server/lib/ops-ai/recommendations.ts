/**
 * Phase 33 — Next-Step Recommendations
 *
 * Suggests investigation actions for operators.
 * NEVER triggers mutations — advisory only.
 *
 * Rule B: All recommended_actions are investigation/monitoring steps only.
 * Rule E: Confidence always present on each issue.
 */

import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { OPS_SYSTEM_PROMPT, buildHealthSummaryPrompt, type TelemetryInput } from "./prompt-builder";
import { OpsAiResponseSchema, type OpsAiResponse } from "@shared/ops-ai-schema";
import { writeAuditRecord } from "./ops-ai-audit";

const OPS_AI_MODEL = "gpt-4o-mini";

const RECOMMENDATIONS_SYSTEM_PROMPT = OPS_SYSTEM_PROMPT + `

RECOMMENDATIONS FOCUS:
Your primary task is to fill the "recommended_actions" array with specific, actionable investigation steps.
Each action must be:
1. An investigation or observation step — NOT a system command or mutation
2. Clearly tied to specific evidence in the telemetry
3. Prioritised: 1 (most urgent) to 3 (least urgent)
4. Safe to perform without disrupting the platform

Avoid vague suggestions like "investigate further". Be specific about WHAT to look at and WHERE.
`;

async function gatherTelemetry(): Promise<TelemetryInput> {
  const results = await Promise.allSettled([
    (async () => {
      const { getSystemHealthReport } = await import("../ops/system-health");
      const r = await getSystemHealthReport();
      return { overallStatus: r.overallStatus, overallScore: r.overallScore,
               subsystems: Object.fromEntries(Object.entries(r.subsystems).map(([k, v]) => [k, { status: v.status, score: v.score, issues: v.issues }])) };
    })(),
    (async () => {
      const { getJobQueueSummary, getFailedJobs } = await import("../ops/job-inspector");
      return { summary: await getJobQueueSummary(), failed: (await getFailedJobs()).slice(0, 5) };
    })(),
    (async () => {
      const { getWebhookHealthSummary } = await import("../ops/webhook-inspector");
      return await getWebhookHealthSummary();
    })(),
    (async () => {
      const { getSecurityHealthSnapshot } = await import("../ops/security-inspector");
      return await getSecurityHealthSnapshot();
    })(),
    (async () => {
      const { getBillingHealth } = await import("../ops/system-health");
      return await getBillingHealth();
    })(),
  ]);

  const t: TelemetryInput = {};
  if (results[0].status === "fulfilled") t.systemHealth    = results[0].value as Record<string, unknown>;
  if (results[1].status === "fulfilled") { const v = results[1].value as any; t.jobSummary = v.summary; t.failedJobs = v.failed; }
  if (results[2].status === "fulfilled") t.webhookHealth   = results[2].value as Record<string, unknown>;
  if (results[3].status === "fulfilled") t.securitySnapshot = results[3].value as Record<string, unknown>;
  if (results[4].status === "fulfilled") t.billingHealth   = results[4].value as Record<string, unknown>;
  return t;
}

export async function recommendNextSteps(operatorId?: string): Promise<OpsAiResponse> {
  const telemetry = await gatherTelemetry();

  if (!isOpenAIAvailable()) {
    const result: OpsAiResponse = {
      overall_health: "warning",
      summary: "Recommendation engine requires AI (OPENAI_API_KEY not configured).",
      top_issues: [],
      suspected_correlations: [],
      recommended_actions: [{ action: "Configure OPENAI_API_KEY environment variable", reason: "Required for AI-powered recommendations", priority: 1 }],
      unknowns: ["AI unavailable"],
    };
    await writeAuditRecord({ requestType: "recommend", operatorId: operatorId ?? null, inputScope: {}, responseSummary: result.summary, confidence: "low", tokensUsed: null, modelUsed: "fallback" });
    return result;
  }

  const userPrompt = buildHealthSummaryPrompt(telemetry);
  const raw = await chatJSON<OpsAiResponse>(RECOMMENDATIONS_SYSTEM_PROMPT, userPrompt, OPS_AI_MODEL, { agentKey: "ops-recommendations" });

  const parsed = OpsAiResponseSchema.safeParse(raw);
  const result = parsed.success ? parsed.data : raw as OpsAiResponse;

  await writeAuditRecord({
    requestType:     "recommend",
    operatorId:      operatorId ?? null,
    inputScope:      { subsystemsPresent: Object.keys(telemetry).filter((k) => (telemetry as any)[k] != null) },
    responseSummary: result.summary?.slice(0, 500) ?? null,
    confidence:      result.recommended_actions?.[0] ? "high" : "low",
    tokensUsed:      null,
    modelUsed:       OPS_AI_MODEL,
  });

  return result;
}
