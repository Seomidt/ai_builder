/**
 * Phase 33 — Platform Health Summary
 *
 * Gathers telemetry from existing Phase 27 inspectors,
 * calls OpenAI, and returns a structured OpsAiResponse.
 *
 * Rule A: AI may only summarise provided telemetry.
 * Rule B: No mutations.
 */

import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { OPS_SYSTEM_PROMPT, buildHealthSummaryPrompt, type TelemetryInput } from "./prompt-builder";
import { OpsAiResponseSchema, type OpsAiResponse } from "@shared/ops-ai-schema";
import { writeAuditRecord } from "./ops-ai-audit";

const OPS_AI_MODEL = "gpt-4o-mini";

// ── Telemetry gatherers (fail-open) ───────────────────────────────────────────

async function gatherSystemHealth(): Promise<Record<string, unknown> | null> {
  try {
    const { getSystemHealthReport } = await import("../ops/system-health");
    const report = await getSystemHealthReport();
    return {
      overallStatus: report.overallStatus,
      overallScore:  report.overallScore,
      subsystems: Object.fromEntries(
        Object.entries(report.subsystems).map(([k, v]) => [
          k,
          { status: v.status, score: v.score, issues: v.issues.slice(0, 5) },
        ])
      ),
    };
  } catch { return null; }
}

async function gatherJobTelemetry(): Promise<{ summary: Record<string, unknown> | null; failed: unknown[] }> {
  try {
    const { getJobQueueSummary, getFailedJobs } = await import("../ops/job-inspector");
    const [summary, failed] = await Promise.all([getJobQueueSummary(), getFailedJobs()]);
    return {
      summary: summary as unknown as Record<string, unknown>,
      failed:  (failed as unknown[]).slice(0, 8),
    };
  } catch { return { summary: null, failed: [] }; }
}

async function gatherWebhookTelemetry(): Promise<{ health: Record<string, unknown> | null; failures: unknown[] }> {
  try {
    const { getWebhookHealthSummary, getDeliveryFailureHistory } = await import("../ops/webhook-inspector");
    const [health, failures] = await Promise.all([
      getWebhookHealthSummary(),
      getDeliveryFailureHistory(),
    ]);
    return {
      health:   health as unknown as Record<string, unknown>,
      failures: (failures as unknown[]).slice(0, 8),
    };
  } catch { return { health: null, failures: [] }; }
}

async function gatherSecurityTelemetry(): Promise<{ snapshot: Record<string, unknown> | null; summary: Record<string, unknown> | null }> {
  try {
    const { getSecurityHealthSnapshot, getSecurityEventSummary } = await import("../ops/security-inspector");
    const [snapshot, summary] = await Promise.all([
      getSecurityHealthSnapshot(),
      getSecurityEventSummary(24),
    ]);
    return {
      snapshot: snapshot as unknown as Record<string, unknown>,
      summary:  summary  as unknown as Record<string, unknown>,
    };
  } catch { return { snapshot: null, summary: null }; }
}

async function gatherGovernanceTelemetry(): Promise<Record<string, unknown> | null> {
  try {
    const { getGovernanceHealth } = await import("../ops/system-health");
    return (await getGovernanceHealth()) as unknown as Record<string, unknown>;
  } catch { return null; }
}

async function gatherBillingTelemetry(): Promise<Record<string, unknown> | null> {
  try {
    const { getBillingHealth } = await import("../ops/system-health");
    return (await getBillingHealth()) as unknown as Record<string, unknown>;
  } catch { return null; }
}

// ── Fallback when OpenAI unavailable ─────────────────────────────────────────

function buildFallbackSummary(telemetry: TelemetryInput): OpsAiResponse {
  const health = telemetry.systemHealth as any;
  const status = health?.overallStatus ?? "unknown";
  const overall =
    status === "healthy" ? "good"
    : status === "degraded" ? "warning"
    : "critical";

  return {
    overall_health: overall as OpsAiResponse["overall_health"],
    summary: "AI assistant is not available (OpenAI API key missing). Platform telemetry has been gathered but analysis requires AI.",
    top_issues: [],
    suspected_correlations: [],
    recommended_actions: [
      { action: "Configure OPENAI_API_KEY to enable AI-powered analysis", reason: "AI assistant requires an API key to generate summaries", priority: 1 },
    ],
    unknowns: ["AI analysis unavailable — configure OPENAI_API_KEY"],
  };
}

// ── Main: summariseCurrentHealth ──────────────────────────────────────────────

export async function summariseCurrentHealth(operatorId?: string): Promise<OpsAiResponse> {
  // Gather all telemetry in parallel (fail-open)
  const [systemHealth, jobData, webhookData, securityData, governance, billing] =
    await Promise.all([
      gatherSystemHealth(),
      gatherJobTelemetry(),
      gatherWebhookTelemetry(),
      gatherSecurityTelemetry(),
      gatherGovernanceTelemetry(),
      gatherBillingTelemetry(),
    ]);

  const telemetry: TelemetryInput = {
    systemHealth,
    jobSummary:       jobData.summary,
    failedJobs:       jobData.failed,
    webhookHealth:    webhookData.health,
    webhookFailures:  webhookData.failures,
    securitySnapshot: securityData.snapshot,
    securitySummary:  securityData.summary,
    aiGovernance:     governance,
    billingHealth:    billing,
  };

  // Fallback if no API key
  if (!isOpenAIAvailable()) {
    const result = buildFallbackSummary(telemetry);
    await writeAuditRecord({
      requestType:     "summary",
      operatorId:      operatorId ?? null,
      inputScope:      { dataSourcesPresent: Object.keys(telemetry).filter((k) => (telemetry as any)[k] != null) },
      responseSummary: result.summary,
      confidence:      "low",
      tokensUsed:      null,
      modelUsed:       "fallback",
    });
    return result;
  }

  const userPrompt = buildHealthSummaryPrompt(telemetry);
  const raw = await chatJSON<OpsAiResponse>(OPS_SYSTEM_PROMPT, userPrompt, OPS_AI_MODEL, { agentKey: "ops-health-summary" });

  // Validate — if schema mismatch, return partial result
  const parsed = OpsAiResponseSchema.safeParse(raw);
  const result = parsed.success ? parsed.data : { ...raw } as OpsAiResponse;

  await writeAuditRecord({
    requestType:     "summary",
    operatorId:      operatorId ?? null,
    inputScope:      { dataSourcesPresent: Object.keys(telemetry).filter((k) => (telemetry as any)[k] != null) },
    responseSummary: result.summary?.slice(0, 500) ?? null,
    confidence:      result.top_issues?.[0]?.confidence ?? "medium",
    tokensUsed:      null,
    modelUsed:       OPS_AI_MODEL,
  });

  return result;
}
