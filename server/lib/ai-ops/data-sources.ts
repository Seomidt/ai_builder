// ─── Phase 51: AI Ops Assistant — Allowed Data Sources ───────────────────────
//
// This module defines the ONLY data sources the AI Ops Assistant may consume.
// The assistant must NEVER access raw prompts, raw AI outputs, private documents,
// raw check-in text, or arbitrary tenant content.
// ─────────────────────────────────────────────────────────────────────────────

export const AI_OPS_SOURCE_ID = {
  ANALYTICS_DAILY_ROLLUPS: "analytics_daily_rollups",
  TENANT_AI_BUDGETS: "tenant_ai_budgets",
  TENANT_AI_USAGE_SNAPSHOTS: "tenant_ai_usage_snapshots",
  AI_USAGE_ALERTS: "ai_usage_alerts",
  GOV_ANOMALY_EVENTS: "gov_anomaly_events",
  SECURITY_EVENTS_AGGREGATED: "security_events_aggregated",
  STRIPE_SUBSCRIPTIONS_SUMMARY: "stripe_subscriptions_summary",
  STRIPE_INVOICES_SUMMARY: "stripe_invoices_summary",
  OBS_SYSTEM_METRICS: "obs_system_metrics",
  OBS_TENANT_USAGE_METRICS: "obs_tenant_usage_metrics",
  OBS_AI_LATENCY_METRICS: "obs_ai_latency_metrics",
  STORAGE_SUMMARY: "storage_summary",
  PLATFORM_HEALTH_SYNTHETIC: "platform_health_synthetic",
} as const;

export type AiOpsSourceId = (typeof AI_OPS_SOURCE_ID)[keyof typeof AI_OPS_SOURCE_ID];

export type AiOpsSourceAccessLevel =
  | "aggregated_only"
  | "admin_only"
  | "tenant_scoped"
  | "platform_scoped";

export interface AiOpsDataSource {
  id: AiOpsSourceId;
  displayName: string;
  purpose: string;
  accessLevel: AiOpsSourceAccessLevel[];
  isAggregated: boolean;
  isAdminOnly: boolean;
  isTenantScoped: boolean;
  isPlatformScoped: boolean;
  forbiddenFields: string[];
  notes: string;
}

export const AI_OPS_DATA_SOURCES: Record<AiOpsSourceId, AiOpsDataSource> = {
  [AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS]: {
    id: AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS,
    displayName: "Analytics Daily Rollups",
    purpose: "Aggregated event counts by day, family, and org. Safe for trend analysis.",
    accessLevel: ["aggregated_only", "admin_only", "tenant_scoped"],
    isAggregated: true,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: ["idempotency_key", "actor_user_id", "client_id", "session_id"],
    notes: "Prefer rollups over raw analytics_events. Never expose individual user events.",
  },

  [AI_OPS_SOURCE_ID.TENANT_AI_BUDGETS]: {
    id: AI_OPS_SOURCE_ID.TENANT_AI_BUDGETS,
    displayName: "Tenant AI Budgets",
    purpose: "Monthly/daily budget config per tenant. Used for cost health signals.",
    accessLevel: ["admin_only", "tenant_scoped"],
    isAggregated: false,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Budget thresholds are safe to summarize. Do not expose internal IDs.",
  },

  [AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS]: {
    id: AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS,
    displayName: "Tenant AI Usage Snapshots",
    purpose: "Periodic token/cost snapshots per tenant and period.",
    accessLevel: ["admin_only", "tenant_scoped"],
    isAggregated: true,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Aggregated snapshots only. Never expose individual request details.",
  },

  [AI_OPS_SOURCE_ID.AI_USAGE_ALERTS]: {
    id: AI_OPS_SOURCE_ID.AI_USAGE_ALERTS,
    displayName: "AI Usage Alerts",
    purpose: "Triggered soft/hard limit alerts per tenant.",
    accessLevel: ["admin_only", "tenant_scoped"],
    isAggregated: false,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Alert types and thresholds are safe. No raw prompts or model outputs.",
  },

  [AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS]: {
    id: AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS,
    displayName: "Governance Anomaly Events",
    purpose: "Usage spikes and runaway agent detections from Phase 16 governance.",
    accessLevel: ["admin_only", "tenant_scoped"],
    isAggregated: false,
    isAdminOnly: true,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: ["metadata"],
    notes: "Metadata may contain partial prompt fingerprints — omit from assistant context.",
  },

  [AI_OPS_SOURCE_ID.SECURITY_EVENTS_AGGREGATED]: {
    id: AI_OPS_SOURCE_ID.SECURITY_EVENTS_AGGREGATED,
    displayName: "Security Events (Aggregated)",
    purpose: "Count and category of security events. Never expose raw event details.",
    accessLevel: ["aggregated_only", "admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: ["ip_address", "user_agent", "raw_payload", "actor_user_id"],
    notes: "Only aggregate counts by event_type and severity. Never raw event bodies.",
  },

  [AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY]: {
    id: AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY,
    displayName: "Stripe Subscriptions Summary",
    purpose: "Subscription status counts for billing health.",
    accessLevel: ["aggregated_only", "admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: ["stripe_subscription_id", "stripe_customer_id", "current_period_end"],
    notes: "Aggregate by status only. Never expose stripe IDs or payment details.",
  },

  [AI_OPS_SOURCE_ID.STRIPE_INVOICES_SUMMARY]: {
    id: AI_OPS_SOURCE_ID.STRIPE_INVOICES_SUMMARY,
    displayName: "Stripe Invoices Summary",
    purpose: "Invoice status and overdue counts for billing health.",
    accessLevel: ["aggregated_only", "admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: ["stripe_invoice_id", "stripe_customer_id", "hosted_invoice_url"],
    notes: "Count by status. Never expose invoice URLs or payment method details.",
  },

  [AI_OPS_SOURCE_ID.OBS_SYSTEM_METRICS]: {
    id: AI_OPS_SOURCE_ID.OBS_SYSTEM_METRICS,
    displayName: "Observability System Metrics",
    purpose: "CPU/memory/latency metrics for platform health.",
    accessLevel: ["admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Safe for platform health summaries. No PII.",
  },

  [AI_OPS_SOURCE_ID.OBS_TENANT_USAGE_METRICS]: {
    id: AI_OPS_SOURCE_ID.OBS_TENANT_USAGE_METRICS,
    displayName: "Observability Tenant Usage Metrics",
    purpose: "Per-tenant API call and token usage for capacity planning.",
    accessLevel: ["admin_only", "tenant_scoped"],
    isAggregated: true,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Safe aggregated usage. No content or user data.",
  },

  [AI_OPS_SOURCE_ID.OBS_AI_LATENCY_METRICS]: {
    id: AI_OPS_SOURCE_ID.OBS_AI_LATENCY_METRICS,
    displayName: "AI Latency Metrics",
    purpose: "P50/P95/P99 latency per model and provider.",
    accessLevel: ["admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Latency data is safe. No content.",
  },

  [AI_OPS_SOURCE_ID.STORAGE_SUMMARY]: {
    id: AI_OPS_SOURCE_ID.STORAGE_SUMMARY,
    displayName: "Storage Summary",
    purpose: "Aggregate file counts and byte usage per org.",
    accessLevel: ["admin_only", "tenant_scoped", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: false,
    isTenantScoped: true,
    isPlatformScoped: true,
    forbiddenFields: ["file_path", "signed_url", "r2_key", "upload_status"],
    notes: "Only counts and byte totals. Never file paths, signed URLs, or content.",
  },

  [AI_OPS_SOURCE_ID.PLATFORM_HEALTH_SYNTHETIC]: {
    id: AI_OPS_SOURCE_ID.PLATFORM_HEALTH_SYNTHETIC,
    displayName: "Platform Health (Synthetic)",
    purpose: "Pre-assembled health indicator derived from multiple sources.",
    accessLevel: ["admin_only", "platform_scoped"],
    isAggregated: true,
    isAdminOnly: true,
    isTenantScoped: false,
    isPlatformScoped: true,
    forbiddenFields: [],
    notes: "Assembled by the context layer. Not a raw DB table.",
  },
};

export const FORBIDDEN_SOURCE_CATEGORIES = [
  "raw_ai_prompts",
  "raw_ai_outputs",
  "private_documents",
  "raw_checkin_text",
  "arbitrary_tenant_content",
  "user_pii",
  "signed_urls",
  "api_keys",
  "secrets",
  "webhook_payloads_raw",
] as const;

export type ForbiddenSourceCategory = (typeof FORBIDDEN_SOURCE_CATEGORIES)[number];

export function isAllowedSource(sourceId: string): sourceId is AiOpsSourceId {
  return sourceId in AI_OPS_DATA_SOURCES;
}

export function getSourceConfig(sourceId: AiOpsSourceId): AiOpsDataSource {
  return AI_OPS_DATA_SOURCES[sourceId];
}

export const HOST_ALLOWLIST_CONFIG = {
  allowedSourceIds: Object.keys(AI_OPS_DATA_SOURCES) as AiOpsSourceId[],
  forbiddenCategories: FORBIDDEN_SOURCE_CATEGORIES,
  totalAllowedSources: Object.keys(AI_OPS_DATA_SOURCES).length,
};
