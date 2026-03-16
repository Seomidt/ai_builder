/**
 * Phase 33 — Ops AI Assistant Orchestrator
 *
 * TASK 1: Orchestrates all AI assistant requests.
 * Single entry point for the admin API layer.
 *
 * Rule B: No mutation paths — all operations are read-only.
 * Rule F: All runs are audited via ops-ai-audit.ts.
 */

import { type OpsAiResponse } from "@shared/ops-ai-schema";
import { type IncidentRequest } from "@shared/ops-ai-schema";

// Re-export all public surface from sub-modules
export { summariseCurrentHealth } from "./health-summary";
export { explainIncident }        from "./incident-explainer";
export { correlateSignals }       from "./signal-correlation";
export { recommendNextSteps }     from "./recommendations";
export { listAuditRecords }       from "./ops-ai-audit";

// ── Combined summary (health + recommendations in one call) ──────────────────

export async function getFullAssistantSummary(operatorId?: string): Promise<{
  health:          OpsAiResponse;
  recommendations: OpsAiResponse;
  generatedAt:     string;
}> {
  const { summariseCurrentHealth } = await import("./health-summary");
  const { recommendNextSteps }     = await import("./recommendations");

  const [health, recommendations] = await Promise.all([
    summariseCurrentHealth(operatorId),
    recommendNextSteps(operatorId),
  ]);

  return { health, recommendations, generatedAt: new Date().toISOString() };
}

// ── Explain a single incident ─────────────────────────────────────────────────

export async function handleExplainRequest(
  request: IncidentRequest,
  operatorId?: string,
): Promise<OpsAiResponse> {
  const { explainIncident } = await import("./incident-explainer");
  return explainIncident(request, operatorId);
}

// ── Supported incident types (for UI validation) ──────────────────────────────

export const SUPPORTED_INCIDENT_TYPES = [
  "failed_jobs",
  "webhook_failure_spike",
  "billing_desync",
  "ai_budget_spike",
  "brownout_transition",
  "rate_limit_surge",
] as const;

export type SupportedIncidentType = typeof SUPPORTED_INCIDENT_TYPES[number];
