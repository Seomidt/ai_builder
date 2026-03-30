// ─── Phase 51: AI Ops Assistant — Intent Model ────────────────────────────────
//
// Defines the constrained set of supported ops intents.
// The assistant is POLICY-DRIVEN — only these intents are allowed.
// Free-form unrestricted queries are NOT supported.
// ─────────────────────────────────────────────────────────────────────────────

import { AI_OPS_SOURCE_ID, type AiOpsSourceId } from "./data-sources.ts";

export const OPS_INTENT = {
  PLATFORM_HEALTH_SUMMARY: "platform_health_summary",
  TENANT_USAGE_SUMMARY: "tenant_usage_summary",
  AI_COST_SUMMARY: "ai_cost_summary",
  ANOMALY_EXPLANATION: "anomaly_explanation",
  BILLING_HEALTH_SUMMARY: "billing_health_summary",
  RETENTION_SUMMARY: "retention_summary",
  SUPPORT_DEBUG_SUMMARY: "support_debug_summary",
  SECURITY_SUMMARY: "security_summary",
  STORAGE_HEALTH_SUMMARY: "storage_health_summary",
  WEEKLY_OPS_DIGEST: "weekly_ops_digest",
} as const;

export type OpsIntentId = (typeof OPS_INTENT)[keyof typeof OPS_INTENT];

export const SUPPORTED_INTENTS = Object.values(OPS_INTENT);

export type OpsIntentAudience = "platform_admin" | "tenant_admin" | "ops_only";

export interface OpsIntentInput {
  organizationId?: string;
  tenantId?: string;
  dateRange?: { from: string; to: string };
  limit?: number;
}

export interface OpsIntentDefinition {
  id: OpsIntentId;
  displayName: string;
  description: string;
  requiredInputs: Array<keyof OpsIntentInput>;
  optionalInputs: Array<keyof OpsIntentInput>;
  allowedSources: AiOpsSourceId[];
  allowedAudience: OpsIntentAudience[];
  isPlatformWide: boolean;
  isTenantScoped: boolean;
  estimatedContextSize: "small" | "medium" | "large";
}

export const INTENT_DEFINITIONS: Record<OpsIntentId, OpsIntentDefinition> = {
  [OPS_INTENT.PLATFORM_HEALTH_SUMMARY]: {
    id: OPS_INTENT.PLATFORM_HEALTH_SUMMARY,
    displayName: "Platform Health Summary",
    description: "Overall platform operational health across infrastructure, AI, and tenants.",
    requiredInputs: [],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.OBS_SYSTEM_METRICS,
      AI_OPS_SOURCE_ID.OBS_AI_LATENCY_METRICS,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
      AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
      AI_OPS_SOURCE_ID.PLATFORM_HEALTH_SYNTHETIC,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: false,
    estimatedContextSize: "medium",
  },

  [OPS_INTENT.TENANT_USAGE_SUMMARY]: {
    id: OPS_INTENT.TENANT_USAGE_SUMMARY,
    displayName: "Tenant Usage Summary",
    description: "AI usage, API calls, and activity summary for a specific tenant.",
    requiredInputs: ["tenantId"],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
      AI_OPS_SOURCE_ID.OBS_TENANT_USAGE_METRICS,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
      AI_OPS_SOURCE_ID.TENANT_AI_BUDGETS,
    ],
    allowedAudience: ["platform_admin", "tenant_admin", "ops_only"],
    isPlatformWide: false,
    isTenantScoped: true,
    estimatedContextSize: "medium",
  },

  [OPS_INTENT.AI_COST_SUMMARY]: {
    id: OPS_INTENT.AI_COST_SUMMARY,
    displayName: "AI Cost Summary",
    description: "Token consumption, cost trends, budget utilization, and alerts.",
    requiredInputs: [],
    optionalInputs: ["tenantId", "dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.TENANT_AI_BUDGETS,
      AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
      AI_OPS_SOURCE_ID.AI_USAGE_ALERTS,
      AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
    ],
    allowedAudience: ["platform_admin", "tenant_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: true,
    estimatedContextSize: "medium",
  },

  [OPS_INTENT.ANOMALY_EXPLANATION]: {
    id: OPS_INTENT.ANOMALY_EXPLANATION,
    displayName: "Anomaly Explanation",
    description: "Explain detected usage spikes or runaway agent events.",
    requiredInputs: [],
    optionalInputs: ["tenantId", "dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
      AI_OPS_SOURCE_ID.AI_USAGE_ALERTS,
      AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: true,
    estimatedContextSize: "small",
  },

  [OPS_INTENT.BILLING_HEALTH_SUMMARY]: {
    id: OPS_INTENT.BILLING_HEALTH_SUMMARY,
    displayName: "Billing Health Summary",
    description: "Subscription statuses, overdue invoices, and revenue health signals.",
    requiredInputs: [],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY,
      AI_OPS_SOURCE_ID.STRIPE_INVOICES_SUMMARY,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: false,
    estimatedContextSize: "small",
  },

  [OPS_INTENT.RETENTION_SUMMARY]: {
    id: OPS_INTENT.RETENTION_SUMMARY,
    displayName: "Retention Summary",
    description: "User retention signals, churn indicators, and engagement trends.",
    requiredInputs: [],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
      AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: false,
    estimatedContextSize: "medium",
  },

  [OPS_INTENT.SUPPORT_DEBUG_SUMMARY]: {
    id: OPS_INTENT.SUPPORT_DEBUG_SUMMARY,
    displayName: "Support Debug Summary",
    description: "Tenant-scoped operational signals for support investigation.",
    requiredInputs: ["tenantId"],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
      AI_OPS_SOURCE_ID.AI_USAGE_ALERTS,
      AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
      AI_OPS_SOURCE_ID.OBS_TENANT_USAGE_METRICS,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: false,
    isTenantScoped: true,
    estimatedContextSize: "medium",
  },

  [OPS_INTENT.SECURITY_SUMMARY]: {
    id: OPS_INTENT.SECURITY_SUMMARY,
    displayName: "Security Summary",
    description: "Aggregated security event counts and severity distribution.",
    requiredInputs: [],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.SECURITY_EVENTS_AGGREGATED,
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: false,
    estimatedContextSize: "small",
  },

  [OPS_INTENT.STORAGE_HEALTH_SUMMARY]: {
    id: OPS_INTENT.STORAGE_HEALTH_SUMMARY,
    displayName: "Storage Health Summary",
    description: "Aggregate file counts and byte usage across orgs.",
    requiredInputs: [],
    optionalInputs: ["tenantId", "dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.STORAGE_SUMMARY,
    ],
    allowedAudience: ["platform_admin", "tenant_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: true,
    estimatedContextSize: "small",
  },

  [OPS_INTENT.WEEKLY_OPS_DIGEST]: {
    id: OPS_INTENT.WEEKLY_OPS_DIGEST,
    displayName: "Weekly Ops Digest",
    description: "Comprehensive weekly summary across all operational domains.",
    requiredInputs: [],
    optionalInputs: ["dateRange"],
    allowedSources: [
      AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
      AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
      AI_OPS_SOURCE_ID.AI_USAGE_ALERTS,
      AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
      AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY,
      AI_OPS_SOURCE_ID.STRIPE_INVOICES_SUMMARY,
      AI_OPS_SOURCE_ID.OBS_SYSTEM_METRICS,
      AI_OPS_SOURCE_ID.SECURITY_EVENTS_AGGREGATED,
      AI_OPS_SOURCE_ID.PLATFORM_HEALTH_SYNTHETIC,
    ],
    allowedAudience: ["platform_admin", "ops_only"],
    isPlatformWide: true,
    isTenantScoped: false,
    estimatedContextSize: "large",
  },
};

export function isValidIntent(intent: string): intent is OpsIntentId {
  return SUPPORTED_INTENTS.includes(intent as OpsIntentId);
}

export function getIntentDefinition(intent: OpsIntentId): OpsIntentDefinition {
  return INTENT_DEFINITIONS[intent];
}

export function assertValidIntent(intent: string): asserts intent is OpsIntentId {
  if (!isValidIntent(intent)) {
    throw new Error(
      `Unsupported AI Ops intent: "${intent}". Supported: ${SUPPORTED_INTENTS.join(", ")}`,
    );
  }
}
