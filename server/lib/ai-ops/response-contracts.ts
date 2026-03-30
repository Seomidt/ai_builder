// ─── Phase 51: AI Ops Assistant — Response Contracts ─────────────────────────
//
// Strict output contracts for each intent.
// Outputs must be concise, operational, explainable, and grounded.
// No arbitrary essay-style text. Machine-structured + readable summary.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { type OpsIntentId, OPS_INTENT } from "./intents.ts";

export const ConfidenceSchema = z.enum(["high", "medium", "low", "insufficient_data"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const FindingSchema = z.object({
  area: z.string(),
  observation: z.string(),
  severity: z.enum(["info", "warning", "critical", "ok"]),
  metric: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const RiskSchema = z.object({
  risk: z.string(),
  likelihood: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  mitigation: z.string().optional(),
});
export type Risk = z.infer<typeof RiskSchema>;

export const RecommendedActionSchema = z.object({
  action: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  owner: z.string().optional(),
  rationale: z.string(),
});
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

export const OpsResponseBaseSchema = z.object({
  intent: z.string(),
  scope: z.enum(["platform", "tenant"]),
  organizationId: z.string().nullable(),
  summary: z.string().max(600),
  findings: z.array(FindingSchema),
  risks: z.array(RiskSchema),
  recommendedActions: z.array(RecommendedActionSchema),
  confidence: ConfidenceSchema,
  dataFreshness: z.string(),
  sourcesUsed: z.array(z.string()),
  generatedAt: z.string(),
});

export type OpsResponseBase = z.infer<typeof OpsResponseBaseSchema>;

export const PlatformHealthResponseSchema = OpsResponseBaseSchema.extend({
  healthScore: z.number().min(0).max(100).optional(),
  activeAnomalies: z.number().int().min(0),
  systemStatus: z.enum(["healthy", "degraded", "critical", "unknown"]),
});

export const TenantUsageResponseSchema = OpsResponseBaseSchema.extend({
  tenantId: z.string(),
  tokensConsumedTotal: z.number().min(0),
  estimatedCostUsd: z.number().min(0),
  budgetUtilizationPct: z.number().min(0).optional(),
});

export const AiCostResponseSchema = OpsResponseBaseSchema.extend({
  totalCostUsd: z.number().min(0),
  activeAlerts: z.number().int().min(0),
  tenantsOverBudget: z.number().int().min(0),
  topCostDrivers: z.array(z.object({ tenantId: z.string(), costUsd: z.number() })),
});

export const AnomalyResponseSchema = OpsResponseBaseSchema.extend({
  anomalyCount: z.number().int().min(0),
  mostRecentAnomalyAt: z.string().nullable(),
  anomalyTypes: z.array(z.string()),
});

export const BillingHealthResponseSchema = OpsResponseBaseSchema.extend({
  activeSubscriptions: z.number().int().min(0),
  pastDueSubscriptions: z.number().int().min(0),
  overdueInvoices: z.number().int().min(0),
  totalDueUsd: z.number().min(0),
});

export const RetentionResponseSchema = OpsResponseBaseSchema.extend({
  activeUsersLast7d: z.number().int().min(0),
  activeUsersLast30d: z.number().int().min(0),
  churnSignals: z.array(z.string()),
});

export const SupportDebugResponseSchema = OpsResponseBaseSchema.extend({
  tenantId: z.string(),
  recentAlertCount: z.number().int().min(0),
  recentAnomalyCount: z.number().int().min(0),
  debugSignals: z.array(z.string()),
});

export const SecurityResponseSchema = OpsResponseBaseSchema.extend({
  totalSecurityEvents: z.number().int().min(0),
  criticalEventCount: z.number().int().min(0),
  eventsByType: z.record(z.number()),
});

export const StorageHealthResponseSchema = OpsResponseBaseSchema.extend({
  totalFiles: z.number().int().min(0),
  totalBytes: z.number().min(0),
  orgCount: z.number().int().min(0),
});

export const WeeklyDigestResponseSchema = OpsResponseBaseSchema.extend({
  weekStart: z.string(),
  weekEnd: z.string(),
  highlights: z.array(z.string()),
  platformHealthScore: z.number().min(0).max(100).optional(),
  aiCostTrendPct: z.number().optional(),
  newAnomalies: z.number().int().min(0),
  billingIssues: z.number().int().min(0),
});

export const INTENT_RESPONSE_SCHEMAS: Record<OpsIntentId, z.ZodTypeAny> = {
  [OPS_INTENT.PLATFORM_HEALTH_SUMMARY]: PlatformHealthResponseSchema,
  [OPS_INTENT.TENANT_USAGE_SUMMARY]: TenantUsageResponseSchema,
  [OPS_INTENT.AI_COST_SUMMARY]: AiCostResponseSchema,
  [OPS_INTENT.ANOMALY_EXPLANATION]: AnomalyResponseSchema,
  [OPS_INTENT.BILLING_HEALTH_SUMMARY]: BillingHealthResponseSchema,
  [OPS_INTENT.RETENTION_SUMMARY]: RetentionResponseSchema,
  [OPS_INTENT.SUPPORT_DEBUG_SUMMARY]: SupportDebugResponseSchema,
  [OPS_INTENT.SECURITY_SUMMARY]: SecurityResponseSchema,
  [OPS_INTENT.STORAGE_HEALTH_SUMMARY]: StorageHealthResponseSchema,
  [OPS_INTENT.WEEKLY_OPS_DIGEST]: WeeklyDigestResponseSchema,
};

export function validateOpsResponse(intent: OpsIntentId, data: unknown): OpsResponseBase {
  const schema = INTENT_RESPONSE_SCHEMAS[intent];
  if (!schema) {
    throw new Error(`No response contract defined for intent: ${intent}`);
  }
  return schema.parse(data) as OpsResponseBase;
}

export function makeBaseResponse(
  intent: OpsIntentId,
  scope: "platform" | "tenant",
  organizationId: string | null,
  sourcesUsed: string[],
): Omit<OpsResponseBase, "summary" | "findings" | "risks" | "recommendedActions" | "confidence"> {
  return {
    intent,
    scope,
    organizationId,
    dataFreshness: new Date().toISOString(),
    sourcesUsed,
    generatedAt: new Date().toISOString(),
  };
}
