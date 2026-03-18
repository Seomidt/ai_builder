/**
 * Phase 16 — Anomaly Detector
 * Detects unusual usage spikes and runaway patterns.
 *
 * INV-GOV-1: Never throws — fail open.
 * INV-GOV-4: All anomaly events are strictly per-tenant.
 * INV-GOV-5: All anomaly events are recorded for audit trail.
 */

import { db } from "../../db";
import { govAnomalyEvents } from "@shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";

export type AnomalyEventType = "usage_spike" | "runaway_agent" | "excessive_tokens" | "cost_spike";

export interface AnomalyDetectionResult {
  isAnomaly: boolean;
  eventType?: AnomalyEventType;
  spikePercent?: number;
  description?: string;
}

/**
 * Detect usage anomaly by comparing current-hour cost to previous-hour average.
 * Anomaly threshold: current hour is >200% of the previous 6-hour average.
 * INV-GOV-1: Returns {isAnomaly: false} on error.
 */
export async function detectUsageAnomaly(tenantId: string): Promise<AnomalyDetectionResult> {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sevenHoursAgo = new Date(now.getTime() - 7 * 60 * 60 * 1000);

    const result = await db.execute<{
      current_cost: string;
      baseline_cost: string;
    }>(drizzleSql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${oneHourAgo} THEN cost_usd::numeric ELSE 0 END), 0)::float AS current_cost,
        COALESCE(
          SUM(CASE WHEN created_at < ${oneHourAgo} AND created_at >= ${sevenHoursAgo} THEN cost_usd::numeric ELSE 0 END) / 6.0,
          0
        )::float AS baseline_cost
      FROM obs_ai_latency_metrics
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${sevenHoursAgo}
    `);

    const row = result.rows[0];
    const currentCost = Number(row?.current_cost ?? 0);
    const baselineCost = Number(row?.baseline_cost ?? 0);

    // Only flag if there's meaningful activity and the spike is >200%
    if (baselineCost > 0 && currentCost > 0) {
      const spikePercent = ((currentCost - baselineCost) / baselineCost) * 100;
      if (spikePercent > 200) {
        return {
          isAnomaly: true,
          eventType: "usage_spike",
          spikePercent,
          description: `Cost spike of ${spikePercent.toFixed(1)}% above baseline`,
        };
      }
    }

    // Check token anomaly: if current hour tokens > 10x baseline
    const tokenResult = await db.execute<{
      current_tokens: string;
      baseline_tokens: string;
    }>(drizzleSql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${oneHourAgo} THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) ELSE 0 END), 0)::int AS current_tokens,
        COALESCE(
          SUM(CASE WHEN created_at < ${oneHourAgo} AND created_at >= ${sevenHoursAgo} THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) ELSE 0 END) / 6.0,
          0
        )::int AS baseline_tokens
      FROM obs_ai_latency_metrics
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${sevenHoursAgo}
    `);

    const tRow = tokenResult.rows[0];
    const currentTokens = Number(tRow?.current_tokens ?? 0);
    const baselineTokens = Number(tRow?.baseline_tokens ?? 0);

    if (baselineTokens > 0 && currentTokens > baselineTokens * 10) {
      const spikePercent = ((currentTokens - baselineTokens) / baselineTokens) * 100;
      return {
        isAnomaly: true,
        eventType: "excessive_tokens",
        spikePercent,
        description: `Token spike of ${spikePercent.toFixed(1)}% above baseline`,
      };
    }

    return { isAnomaly: false };
  } catch {
    return { isAnomaly: false }; // INV-GOV-1: fail open
  }
}

/**
 * Record an anomaly event to the database.
 * INV-GOV-1: Never throws.
 * INV-GOV-5: All events recorded for audit trail.
 */
export async function recordAnomalyEvent(params: {
  tenantId: string;
  eventType: AnomalyEventType | string;
  usageSpikePercent?: number;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .insert(govAnomalyEvents)
      .values({
        tenantId: params.tenantId,
        eventType: params.eventType,
        usageSpikePercent: params.usageSpikePercent != null ? String(params.usageSpikePercent) : undefined,
        metadata: params.metadata ?? null,
      })
      .returning({ id: govAnomalyEvents.id });
    return row ?? null;
  } catch {
    return null; // INV-GOV-1: never throw
  }
}

/**
 * List recent anomaly events for a tenant.
 * INV-GOV-4: Results are strictly scoped to the given tenant.
 */
export async function listAnomalyEvents(tenantId: string, limit = 50) {
  try {
    return await db
      .select()
      .from(govAnomalyEvents)
      .where(eq(govAnomalyEvents.tenantId, tenantId))
      .orderBy(desc(govAnomalyEvents.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * List all anomaly events across all tenants (admin view).
 */
export async function listAllAnomalyEvents(limit = 100) {
  try {
    return await db
      .select()
      .from(govAnomalyEvents)
      .orderBy(desc(govAnomalyEvents.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Check for anomaly and auto-record if detected.
 * INV-GOV-1: Never throws.
 */
export async function detectAndRecordAnomaly(tenantId: string): Promise<AnomalyDetectionResult> {
  try {
    const detection = await detectUsageAnomaly(tenantId);
    if (detection.isAnomaly && detection.eventType) {
      await recordAnomalyEvent({
        tenantId,
        eventType: detection.eventType,
        usageSpikePercent: detection.spikePercent,
        metadata: { description: detection.description, detectedAt: new Date().toISOString() },
      });
    }
    return detection;
  } catch {
    return { isAnomaly: false };
  }
}
