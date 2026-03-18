/**
 * Phase 27 — Security Event Inspector
 * Operational visibility into: abuse events, rate limit triggers,
 * policy violations, and moderation spikes.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SecurityEventSummary {
  tenantId:      string | null;
  eventType:     string;
  severity:      string;
  count:         number;
  firstSeenAt:   string;
  lastSeenAt:    string;
}

export interface AbuseEventEntry {
  id:         string;
  tenantId:   string;
  eventType:  string;
  severity:   string;
  metadata:   Record<string, unknown> | null;
  createdAt:  string;
}

export interface RateLimitTriggerSummary {
  tenantId:    string;
  limitType:   string;
  triggerCount: number;
  lastTriggered: string;
}

export interface ModerationSpikeSummary {
  tenantId:    string | null;
  category:    string | null;
  spikeCount:  number;
  windowStart: string;
  windowEnd:   string;
}

export interface PolicyViolationEntry {
  tenantId:    string;
  policyKey:   string;
  policyType:  string;
  violationType: string;
  count:       number;
  lastSeenAt:  string;
}

export interface SecurityHealthSnapshot {
  securityEventsLast24h:  number;
  criticalEventsLast24h:  number;
  moderationEventsLast24h: number;
  anomalyEventsLast24h:   number;
  activeHolds:            number;
  tenantsWithOpenEvents:  number;
  topThreatTenantId:      string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }

// ── Security Events ───────────────────────────────────────────────────────────

export async function getSecurityEventSummary(
  windowHours = 24,
  tenantId?: string,
): Promise<SecurityEventSummary[]> {
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const r = await db.execute(sql.raw(`
    SELECT
      tenant_id,
      event_type,
      'info'         AS severity,
      COUNT(*)       AS cnt,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen
    FROM security_events
    WHERE created_at >= '${cutoff}' ${tFilter}
    GROUP BY tenant_id, event_type
    ORDER BY cnt DESC
    LIMIT 100
  `));

  return (r.rows as any[]).map(row => ({
    tenantId:    row.tenant_id  ?? null,
    eventType:   row.event_type,
    severity:    row.severity,
    count:       safeNum(row.cnt),
    firstSeenAt: new Date(row.first_seen).toISOString(),
    lastSeenAt:  new Date(row.last_seen).toISOString(),
  }));
}

// ── Abuse Events ──────────────────────────────────────────────────────────────

export async function getAbuseEvents(
  options: {
    tenantId?: string;
    severity?: string;
    windowHours?: number;
    limit?: number;
  } = {},
): Promise<AbuseEventEntry[]> {
  const { tenantId, severity, windowHours = 24, limit = 50 } = options;
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const filters = [`created_at >= '${cutoff}'`];
  if (tenantId) filters.push(`tenant_id = '${tenantId.replace(/'/g, "''")}'`);
  if (severity) filters.push(`severity = '${severity.replace(/'/g, "''")}'`);

  // Abuse events come from security_events where event_type indicates abuse
  const r = await db.execute(sql.raw(`
    SELECT id, tenant_id, event_type, 'info' AS severity, metadata, created_at
    FROM security_events
    WHERE ${filters.join(" AND ")}
      AND (event_type ILIKE '%abuse%' OR event_type ILIKE '%block%' OR event_type ILIKE '%threat%')
    ORDER BY created_at DESC
    LIMIT ${limit}
  `));

  return (r.rows as any[]).map(row => ({
    id:        row.id,
    tenantId:  row.tenant_id,
    eventType: row.event_type,
    severity:  row.severity,
    metadata:  row.metadata ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

// ── Rate Limit Triggers ───────────────────────────────────────────────────────

export async function getRateLimitTriggers(
  windowHours = 24,
  tenantId?: string,
): Promise<RateLimitTriggerSummary[]> {
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND se.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  // Rate limit events sourced from security_events (event_type = 'rate_limit_*')
  const r = await db.execute(sql.raw(`
    SELECT
      se.tenant_id,
      se.event_type     AS limit_type,
      COUNT(*)          AS trigger_count,
      MAX(se.created_at) AS last_triggered
    FROM security_events se
    WHERE se.event_type ILIKE '%rate_limit%'
      AND se.created_at >= '${cutoff}'
      ${tFilter}
    GROUP BY se.tenant_id, se.event_type
    ORDER BY trigger_count DESC
    LIMIT 100
  `));

  return (r.rows as any[]).map(row => ({
    tenantId:     row.tenant_id,
    limitType:    row.limit_type,
    triggerCount: safeNum(row.trigger_count),
    lastTriggered: new Date(row.last_triggered).toISOString(),
  }));
}

// ── Moderation Spikes ─────────────────────────────────────────────────────────

export async function getModerationSpikes(
  windowHours = 24,
  spikeThreshold = 5,
  tenantId?: string,
): Promise<ModerationSpikeSummary[]> {
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const r = await db.execute(sql.raw(`
    SELECT
      tenant_id,
      event_type AS category,
      COUNT(*)        AS spike_count,
      MIN(created_at) AS window_start,
      MAX(created_at) AS window_end
    FROM moderation_events
    WHERE created_at >= '${cutoff}' ${tFilter}
    GROUP BY tenant_id, event_type
    HAVING COUNT(*) >= ${spikeThreshold}
    ORDER BY spike_count DESC
    LIMIT 50
  `));

  return (r.rows as any[]).map(row => ({
    tenantId:    row.tenant_id ?? null,
    category:    row.category  ?? null,
    spikeCount:  safeNum(row.spike_count),
    windowStart: new Date(row.window_start).toISOString(),
    windowEnd:   new Date(row.window_end).toISOString(),
  }));
}

// ── Policy Violations ─────────────────────────────────────────────────────────

export async function getPolicyViolations(
  windowHours = 168,
  tenantId?: string,
): Promise<PolicyViolationEntry[]> {
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND me.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  // Violations from moderation_events (blocked/flagged) — policy_key is stored on the event
  const r = await db.execute(sql.raw(`
    SELECT
      me.tenant_id,
      COALESCE(me.policy_key, 'unknown') AS policy_key,
      'ai_governance'                    AS policy_type,
      me.result                          AS violation_type,
      COUNT(*)                           AS cnt,
      MAX(me.created_at)                 AS last_seen
    FROM moderation_events me
    WHERE me.created_at >= '${cutoff}'
      AND me.result IN ('blocked','flagged')
      ${tFilter}
    GROUP BY me.tenant_id, me.policy_key, me.result
    ORDER BY cnt DESC
    LIMIT 100
  `));

  return (r.rows as any[]).map(row => ({
    tenantId:      row.tenant_id,
    policyKey:     row.policy_key,
    policyType:    row.policy_type,
    violationType: row.violation_type,
    count:         safeNum(row.cnt),
    lastSeenAt:    new Date(row.last_seen).toISOString(),
  }));
}

// ── Security Health Snapshot ──────────────────────────────────────────────────

export async function getSecurityHealthSnapshot(): Promise<SecurityHealthSnapshot> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();

  const r = await db.execute(sql.raw(`
    SELECT
      (SELECT COUNT(*) FROM security_events  WHERE created_at>='${yesterday}')                       AS sec_events,
      (SELECT COUNT(*) FROM security_events  WHERE created_at>='${yesterday}' AND event_type ILIKE '%critical%') AS crit_events,
      (SELECT COUNT(*) FROM moderation_events WHERE created_at>='${yesterday}')                      AS mod_events,
      (SELECT COUNT(*) FROM ai_anomaly_events WHERE created_at>='${yesterday}')                      AS anomaly_events,
      (SELECT COUNT(*) FROM legal_holds WHERE active=TRUE)                                           AS active_holds,
      (SELECT COUNT(DISTINCT tenant_id) FROM security_events WHERE created_at>='${yesterday}')       AS tenants_with_events
  `));

  // Top threat tenant (most security events in 24h)
  const topRes = await db.execute(sql.raw(`
    SELECT tenant_id, COUNT(*) AS cnt
    FROM security_events
    WHERE created_at>='${yesterday}'
    GROUP BY tenant_id
    ORDER BY cnt DESC
    LIMIT 1
  `));

  const row = (r.rows[0]   as any) ?? {};
  const top = (topRes.rows[0] as any) ?? {};

  return {
    securityEventsLast24h:   safeNum(row.sec_events),
    criticalEventsLast24h:   safeNum(row.crit_events),
    moderationEventsLast24h: safeNum(row.mod_events),
    anomalyEventsLast24h:    safeNum(row.anomaly_events),
    activeHolds:             safeNum(row.active_holds),
    tenantsWithOpenEvents:   safeNum(row.tenants_with_events),
    topThreatTenantId:       top.tenant_id ?? null,
  };
}

// ── Anomaly Event Stream ──────────────────────────────────────────────────────

export interface AnomalyEventEntry {
  id:            string;
  tenantId:      string;
  eventType:     string;
  detectedValue: number | null;
  thresholdValue: number | null;
  metadata:      Record<string, unknown> | null;
  createdAt:     string;
}

export async function getAnomalyEventStream(
  windowHours = 24,
  tenantId?: string,
  limit = 100,
): Promise<AnomalyEventEntry[]> {
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const r = await db.execute(sql.raw(`
    SELECT id, tenant_id, event_type, observed_value AS detected_value, threshold_value, NULL::jsonb AS metadata, created_at
    FROM ai_anomaly_events
    WHERE created_at >= '${cutoff}' ${tFilter}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `));

  return (r.rows as any[]).map(row => ({
    id:             row.id,
    tenantId:       row.tenant_id,
    eventType:      row.event_type,
    detectedValue:  row.detected_value  != null ? safeNum(row.detected_value)  : null,
    thresholdValue: row.threshold_value != null ? safeNum(row.threshold_value) : null,
    metadata:       row.metadata ?? null,
    createdAt:      new Date(row.created_at).toISOString(),
  }));
}
