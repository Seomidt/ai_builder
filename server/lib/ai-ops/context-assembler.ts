// ─── Phase 51: AI Ops Assistant — Context Assembler ───────────────────────────
//
// Assembles grounded, structured context for the AI Ops Assistant.
// Uses ONLY allowed data sources. Prefers aggregated/rollup data.
// Never includes raw secrets, tokens, signed URLs, or private content.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "../supabase";
import { AI_OPS_SOURCE_ID } from "./data-sources";
import { redactUnsafeOpsContext } from "./safety";

export interface ContextMeta {
  assembledAt: string;
  sourceIds: string[];
  scopeMode: "platform" | "tenant";
  organizationId?: string;
}

export interface PlatformHealthContext {
  meta: ContextMeta;
  recentAnomalyCount: number;
  activeAlertCount: number;
  analyticsRollupSummary: {
    totalEventsLast7d: number;
    familyBreakdown: Record<string, number>;
  };
  systemStatus: "healthy" | "degraded" | "critical" | "unknown";
}

export interface TenantUsageContext {
  meta: ContextMeta;
  tenantId: string;
  recentSnapshots: Array<{
    period: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: string;
  }>;
  budget: {
    monthlyBudgetUsd: string | null;
    dailyBudgetUsd: string | null;
    softLimitPercent: string | null;
    hardLimitPercent: string | null;
  } | null;
  rollupSummary: { totalEvents: number; uniqueUsers: number };
}

export interface AiCostContext {
  meta: ContextMeta;
  recentAlerts: Array<{ tenantId: string; alertType: string; usagePercent: string; triggeredAt: string }>;
  recentAnomalies: Array<{ tenantId: string; eventType: string; usageSpikePercent: string | null; createdAt: string }>;
  usageSnapshotCount: number;
  totalSnapshotCostUsd: number;
}

export interface AnomalyContext {
  meta: ContextMeta;
  anomalies: Array<{
    tenantId: string;
    eventType: string;
    usageSpikePercent: string | null;
    createdAt: string;
  }>;
  alerts: Array<{
    tenantId: string;
    alertType: string;
    usagePercent: string;
    triggeredAt: string;
  }>;
}

export interface RetentionContext {
  meta: ContextMeta;
  rollupsByFamily: Record<string, { totalEvents: number; uniqueUsers: number }>;
  retentionEvents: number;
  productEvents: number;
}

export interface BillingHealthContext {
  meta: ContextMeta;
  subscriptionStatusCounts: Record<string, number>;
  invoiceStatusCounts: Record<string, number>;
  overdueCount: number;
}

export interface StorageHealthContext {
  meta: ContextMeta;
  orgCount: number;
  totalFiles: number;
  totalBytes: number;
}

export interface SecurityContext {
  meta: ContextMeta;
  eventTypeCounts: Record<string, number>;
  totalEvents: number;
  criticalCount: number;
}

function makeMeta(sourceIds: string[], scopeMode: "platform" | "tenant", orgId?: string): ContextMeta {
  return {
    assembledAt: new Date().toISOString(),
    sourceIds,
    scopeMode,
    organizationId: orgId,
  };
}

export async function buildPlatformHealthContext(): Promise<PlatformHealthContext> {
  const [anomalyRes, alertRes, rollupRes] = await Promise.allSettled([
    supabaseAdmin
      .from("gov_anomaly_events")
      .select("id, tenant_id, event_type, created_at", { count: "exact" })
      .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString())
      .limit(100),
    supabaseAdmin
      .from("ai_usage_alerts")
      .select("id, tenant_id, alert_type, usage_percent, triggered_at", { count: "exact" })
      .gte("triggered_at", new Date(Date.now() - 7 * 86400_000).toISOString())
      .limit(50),
    supabaseAdmin
      .from("analytics_daily_rollups")
      .select("event_family, event_count, unique_users")
      .gte("date", new Date(Date.now() - 7 * 86400_000).toISOString().split("T")[0])
      .limit(200),
  ]);

  const anomalyCount = anomalyRes.status === "fulfilled" ? (anomalyRes.value.count ?? 0) : 0;
  const alertCount = alertRes.status === "fulfilled" ? (alertRes.value.count ?? 0) : 0;

  const familyBreakdown: Record<string, number> = {};
  let totalEvents = 0;
  if (rollupRes.status === "fulfilled" && rollupRes.value.data) {
    for (const row of rollupRes.value.data) {
      const family = row.event_family as string;
      const count = Number(row.event_count ?? 0);
      familyBreakdown[family] = (familyBreakdown[family] ?? 0) + count;
      totalEvents += count;
    }
  }

  const systemStatus = anomalyCount > 10 ? "degraded" : anomalyCount > 25 ? "critical" : "healthy";

  return redactUnsafeOpsContext({
    meta: makeMeta(
      [AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS, AI_OPS_SOURCE_ID.AI_USAGE_ALERTS, AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS],
      "platform",
    ),
    recentAnomalyCount: anomalyCount,
    activeAlertCount: alertCount,
    analyticsRollupSummary: { totalEventsLast7d: totalEvents, familyBreakdown },
    systemStatus,
  } as PlatformHealthContext);
}

export async function buildTenantUsageContext(tenantId: string): Promise<TenantUsageContext> {
  const [snapshotRes, budgetRes, rollupRes] = await Promise.allSettled([
    supabaseAdmin
      .from("tenant_ai_usage_snapshots")
      .select("period, tokens_in, tokens_out, cost_usd")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(6),
    supabaseAdmin
      .from("tenant_ai_budgets")
      .select("monthly_budget_usd, daily_budget_usd, soft_limit_percent, hard_limit_percent")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabaseAdmin
      .from("analytics_daily_rollups")
      .select("event_count, unique_users")
      .eq("organization_id", tenantId)
      .gte("date", new Date(Date.now() - 30 * 86400_000).toISOString().split("T")[0]),
  ]);

  const snapshots = snapshotRes.status === "fulfilled" && snapshotRes.value.data
    ? snapshotRes.value.data.map((r) => ({
        period: r.period as string,
        tokensIn: Number(r.tokens_in ?? 0),
        tokensOut: Number(r.tokens_out ?? 0),
        costUsd: String(r.cost_usd ?? "0"),
      }))
    : [];

  const budget = budgetRes.status === "fulfilled" && budgetRes.value.data
    ? {
        monthlyBudgetUsd: String(budgetRes.value.data.monthly_budget_usd ?? null),
        dailyBudgetUsd: String(budgetRes.value.data.daily_budget_usd ?? null),
        softLimitPercent: String(budgetRes.value.data.soft_limit_percent ?? null),
        hardLimitPercent: String(budgetRes.value.data.hard_limit_percent ?? null),
      }
    : null;

  let totalEvents = 0;
  let totalUsers = 0;
  if (rollupRes.status === "fulfilled" && rollupRes.value.data) {
    for (const row of rollupRes.value.data) {
      totalEvents += Number(row.event_count ?? 0);
      totalUsers += Number(row.unique_users ?? 0);
    }
  }

  return {
    meta: makeMeta(
      [AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS, AI_OPS_SOURCE_ID.TENANT_AI_BUDGETS, AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS],
      "tenant",
      tenantId,
    ),
    tenantId,
    recentSnapshots: snapshots,
    budget,
    rollupSummary: { totalEvents, uniqueUsers: totalUsers },
  };
}

export async function buildAiCostContext(tenantId?: string): Promise<AiCostContext> {
  const alertQuery = supabaseAdmin
    .from("ai_usage_alerts")
    .select("tenant_id, alert_type, usage_percent, triggered_at")
    .order("triggered_at", { ascending: false })
    .limit(20);

  const anomalyQuery = supabaseAdmin
    .from("gov_anomaly_events")
    .select("tenant_id, event_type, usage_spike_percent, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const snapshotQuery = supabaseAdmin
    .from("tenant_ai_usage_snapshots")
    .select("cost_usd")
    .limit(100);

  if (tenantId) {
    alertQuery.eq("tenant_id", tenantId);
    anomalyQuery.eq("tenant_id", tenantId);
    snapshotQuery.eq("tenant_id", tenantId);
  }

  const [alertRes, anomalyRes, snapshotRes] = await Promise.allSettled([
    alertQuery,
    anomalyQuery,
    snapshotQuery,
  ]);

  const alerts = alertRes.status === "fulfilled" && alertRes.value.data
    ? alertRes.value.data.map((r) => ({
        tenantId: r.tenant_id as string,
        alertType: r.alert_type as string,
        usagePercent: String(r.usage_percent),
        triggeredAt: String(r.triggered_at),
      }))
    : [];

  const anomalies = anomalyRes.status === "fulfilled" && anomalyRes.value.data
    ? anomalyRes.value.data.map((r) => ({
        tenantId: r.tenant_id as string,
        eventType: r.event_type as string,
        usageSpikePercent: r.usage_spike_percent != null ? String(r.usage_spike_percent) : null,
        createdAt: String(r.created_at),
      }))
    : [];

  const snapshots = snapshotRes.status === "fulfilled" && snapshotRes.value.data
    ? snapshotRes.value.data
    : [];

  const totalCost = snapshots.reduce((sum, r) => sum + Number((r as { cost_usd?: unknown }).cost_usd ?? 0), 0);

  return {
    meta: makeMeta(
      [AI_OPS_SOURCE_ID.AI_USAGE_ALERTS, AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS, AI_OPS_SOURCE_ID.TENANT_AI_USAGE_SNAPSHOTS],
      tenantId ? "tenant" : "platform",
      tenantId,
    ),
    recentAlerts: alerts,
    recentAnomalies: anomalies,
    usageSnapshotCount: snapshots.length,
    totalSnapshotCostUsd: totalCost,
  };
}

export async function buildAnomalyContext(tenantId?: string): Promise<AnomalyContext> {
  const anomalyQuery = supabaseAdmin
    .from("gov_anomaly_events")
    .select("tenant_id, event_type, usage_spike_percent, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const alertQuery = supabaseAdmin
    .from("ai_usage_alerts")
    .select("tenant_id, alert_type, usage_percent, triggered_at")
    .order("triggered_at", { ascending: false })
    .limit(30);

  if (tenantId) {
    anomalyQuery.eq("tenant_id", tenantId);
    alertQuery.eq("tenant_id", tenantId);
  }

  const [anomalyRes, alertRes] = await Promise.allSettled([anomalyQuery, alertQuery]);

  const anomalies = anomalyRes.status === "fulfilled" && anomalyRes.value.data
    ? anomalyRes.value.data.map((r) => ({
        tenantId: r.tenant_id as string,
        eventType: r.event_type as string,
        usageSpikePercent: r.usage_spike_percent != null ? String(r.usage_spike_percent) : null,
        createdAt: String(r.created_at),
      }))
    : [];

  const alerts = alertRes.status === "fulfilled" && alertRes.value.data
    ? alertRes.value.data.map((r) => ({
        tenantId: r.tenant_id as string,
        alertType: r.alert_type as string,
        usagePercent: String(r.usage_percent),
        triggeredAt: String(r.triggered_at),
      }))
    : [];

  return {
    meta: makeMeta(
      [AI_OPS_SOURCE_ID.GOV_ANOMALY_EVENTS, AI_OPS_SOURCE_ID.AI_USAGE_ALERTS],
      tenantId ? "tenant" : "platform",
      tenantId,
    ),
    anomalies,
    alerts,
  };
}

export async function buildRetentionContext(): Promise<RetentionContext> {
  const { data } = await supabaseAdmin
    .from("analytics_daily_rollups")
    .select("event_family, event_count, unique_users")
    .gte("date", new Date(Date.now() - 30 * 86400_000).toISOString().split("T")[0])
    .limit(500);

  const rollupsByFamily: Record<string, { totalEvents: number; uniqueUsers: number }> = {};
  let retentionEvents = 0;
  let productEvents = 0;

  for (const row of data ?? []) {
    const family = row.event_family as string;
    const count = Number(row.event_count ?? 0);
    const users = Number(row.unique_users ?? 0);
    if (!rollupsByFamily[family]) rollupsByFamily[family] = { totalEvents: 0, uniqueUsers: 0 };
    rollupsByFamily[family].totalEvents += count;
    rollupsByFamily[family].uniqueUsers += users;
    if (family === "retention") retentionEvents += count;
    if (family === "product") productEvents += count;
  }

  return {
    meta: makeMeta([AI_OPS_SOURCE_ID.ANALYTICS_DAILY_ROLLUPS], "platform"),
    rollupsByFamily,
    retentionEvents,
    productEvents,
  };
}

export async function buildBillingHealthContext(): Promise<BillingHealthContext> {
  const [subRes, invRes] = await Promise.allSettled([
    supabaseAdmin.from("stripe_subscriptions").select("status"),
    supabaseAdmin.from("stripe_invoices").select("status"),
  ]);

  const subCounts: Record<string, number> = {};
  if (subRes.status === "fulfilled" && subRes.value.data) {
    for (const r of subRes.value.data) {
      const s = r.status as string;
      subCounts[s] = (subCounts[s] ?? 0) + 1;
    }
  }

  const invCounts: Record<string, number> = {};
  let overdueCount = 0;
  if (invRes.status === "fulfilled" && invRes.value.data) {
    for (const r of invRes.value.data) {
      const s = r.status as string;
      invCounts[s] = (invCounts[s] ?? 0) + 1;
      if (s === "past_due" || s === "open") overdueCount++;
    }
  }

  return {
    meta: makeMeta([AI_OPS_SOURCE_ID.STRIPE_SUBSCRIPTIONS_SUMMARY, AI_OPS_SOURCE_ID.STRIPE_INVOICES_SUMMARY], "platform"),
    subscriptionStatusCounts: subCounts,
    invoiceStatusCounts: invCounts,
    overdueCount,
  };
}

export async function buildStorageHealthContext(tenantId?: string): Promise<StorageHealthContext> {
  const query = supabaseAdmin
    .from("tenant_files")
    .select("organization_id, file_size_bytes");

  if (tenantId) query.eq("organization_id", tenantId);

  const { data } = await query.limit(1000);

  const orgs = new Set<string>();
  let totalFiles = 0;
  let totalBytes = 0;

  for (const row of data ?? []) {
    if (row.organization_id) orgs.add(row.organization_id as string);
    totalFiles++;
    totalBytes += Number((row as { file_size_bytes?: unknown }).file_size_bytes ?? 0);
  }

  return {
    meta: makeMeta([AI_OPS_SOURCE_ID.STORAGE_SUMMARY], tenantId ? "tenant" : "platform", tenantId),
    orgCount: orgs.size,
    totalFiles,
    totalBytes,
  };
}

export async function buildSecurityContext(): Promise<SecurityContext> {
  const { data } = await supabaseAdmin
    .from("security_events")
    .select("event_type, severity")
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .limit(500);

  const eventTypeCounts: Record<string, number> = {};
  let criticalCount = 0;

  for (const row of data ?? []) {
    const t = row.event_type as string;
    eventTypeCounts[t] = (eventTypeCounts[t] ?? 0) + 1;
    if ((row as { severity?: string }).severity === "critical") criticalCount++;
  }

  return {
    meta: makeMeta([AI_OPS_SOURCE_ID.SECURITY_EVENTS_AGGREGATED], "platform"),
    eventTypeCounts,
    totalEvents: (data ?? []).length,
    criticalCount,
  };
}
