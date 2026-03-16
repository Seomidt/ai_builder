/**
 * Phase 33 — Ops AI Structured Output Schema
 *
 * All AI assistant responses must conform to this contract.
 * AI may never return free-form text — always structured JSON.
 *
 * Design rules (enforced at runtime):
 *   A) AI is not a source of truth — summarises telemetry only
 *   B) AI must never mutate state
 *   C) Confidence field always present
 *   D) Unknowns explicitly listed when data is weak
 */

import { z } from "zod";

// ── Confidence + Severity ─────────────────────────────────────────────────────

export const ConfidenceLevel = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const SeverityLevel = z.enum(["low", "medium", "high", "critical"]);
export type SeverityLevel = z.infer<typeof SeverityLevel>;

export const OverallHealth = z.enum(["good", "warning", "critical"]);
export type OverallHealth = z.infer<typeof OverallHealth>;

export const Priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Priority = z.infer<typeof Priority>;

// ── Core output blocks ────────────────────────────────────────────────────────

export const TopIssueSchema = z.object({
  title:      z.string(),
  severity:   SeverityLevel,
  evidence:   z.array(z.string()),
  confidence: ConfidenceLevel,
});
export type TopIssue = z.infer<typeof TopIssueSchema>;

export const SuspectedCorrelationSchema = z.object({
  title:      z.string(),
  reasoning:  z.string(),
  confidence: ConfidenceLevel,
});
export type SuspectedCorrelation = z.infer<typeof SuspectedCorrelationSchema>;

export const RecommendedActionSchema = z.object({
  action:   z.string(),
  reason:   z.string(),
  priority: Priority,
});
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

// ── Primary output contract ───────────────────────────────────────────────────

export const OpsAiResponseSchema = z.object({
  overall_health:          OverallHealth,
  summary:                 z.string(),
  top_issues:              z.array(TopIssueSchema),
  suspected_correlations:  z.array(SuspectedCorrelationSchema),
  recommended_actions:     z.array(RecommendedActionSchema),
  unknowns:                z.array(z.string()),
});
export type OpsAiResponse = z.infer<typeof OpsAiResponseSchema>;

// ── Incident explainer ────────────────────────────────────────────────────────

export const IncidentType = z.enum([
  "failed_jobs",
  "webhook_failure_spike",
  "billing_desync",
  "ai_budget_spike",
  "brownout_transition",
  "rate_limit_surge",
]);
export type IncidentType = z.infer<typeof IncidentType>;

export const IncidentRequestSchema = z.object({
  type:       IncidentType,
  tenantId:   z.string().optional(),
  windowHours: z.number().min(1).max(168).default(24),
  metadata:   z.record(z.unknown()).optional(),
});
export type IncidentRequest = z.infer<typeof IncidentRequestSchema>;

// ── Audit record ──────────────────────────────────────────────────────────────

export const AuditRecordSchema = z.object({
  id:              z.string(),
  requestType:     z.string(),
  operatorId:      z.string().nullable(),
  inputScope:      z.record(z.unknown()).nullable(),
  responseSummary: z.string().nullable(),
  confidence:      z.string().nullable(),
  tokensUsed:      z.number().nullable(),
  modelUsed:       z.string().nullable(),
  createdAt:       z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
