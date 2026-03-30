/**
 * server/lib/insights/run-tenant-insights.ts
 * Phase 2.2 — Tenant Insights Engine
 *
 * 1. Collects TenantInsightContext by querying existing telemetry tables.
 * 2. Evaluates all rules against the context.
 * 3. Upserts insights:
 *    - New trigger → INSERT active insight
 *    - Still triggered → UPDATE last_detected_at
 *    - No longer triggered → UPDATE status='resolved' if previously active
 * 4. Preserves dismissed insights (dismissed is a user action, not rule-driven).
 * 5. Logs structured events — no PII, SOC2-friendly.
 */

import { db } from "../../db.ts";
import {
  tenantInsights,
  tenantAiBudgets,
  tenantAiUsageSnapshots,
  tenantRateLimits,
  obsAiLatencyMetrics,
  knowledgeRetrievalQualitySignals,
} from "@shared/schema";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import type { TenantInsightContext, InsightRunResult } from "./types.ts";
import { ALL_RULES } from "./insight-rules.ts";

// ── Context collector ─────────────────────────────────────────────────────────

async function collectContext(tenantId: string): Promise<TenantInsightContext> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo   = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // ── Budget usage ──────────────────────────────────────────────────────────
  let budgetUsagePct: number | null = null;
  let budgetWarningThresholdPct = 80;

  try {
    const [budget] = await db
      .select()
      .from(tenantAiBudgets)
      .where(and(eq(tenantAiBudgets.organizationId, tenantId), eq(tenantAiBudgets.isActive, true)))
      .limit(1);

    if (budget) {
      budgetWarningThresholdPct = budget.warningThresholdPct ?? 80;

      const [snapshot] = await db
        .select()
        .from(tenantAiUsageSnapshots)
        .where(
          and(
            eq(tenantAiUsageSnapshots.organizationId, tenantId),
            eq(tenantAiUsageSnapshots.periodType, budget.periodType),
          ),
        )
        .orderBy(desc(tenantAiUsageSnapshots.periodStart))
        .limit(1);

      if (snapshot && Number(budget.budgetUsdCents) > 0) {
        budgetUsagePct = (Number(snapshot.totalCostUsdCents) / Number(budget.budgetUsdCents)) * 100;
      }
    }
  } catch (e) {
    console.warn("[insights/ctx] budget signal error:", (e as Error).message);
  }

  // ── Rate limit presence ────────────────────────────────────────────────────
  let hasRateLimit = false;

  try {
    const [rl] = await db
      .select({ id: tenantRateLimits.id })
      .from(tenantRateLimits)
      .where(and(eq(tenantRateLimits.tenantId, tenantId), eq(tenantRateLimits.isActive, true)))
      .limit(1);
    hasRateLimit = !!rl;
  } catch (e) {
    console.warn("[insights/ctx] rate-limit signal error:", (e as Error).message);
  }

  // ── AI latency p95 (last 24h) ─────────────────────────────────────────────
  let recentLatencyP95Ms: number | null = null;

  try {
    const rows = await db
      .select({ latencyMs: obsAiLatencyMetrics.latencyMs })
      .from(obsAiLatencyMetrics)
      .where(
        and(
          eq(obsAiLatencyMetrics.tenantId, tenantId),
          gte(obsAiLatencyMetrics.createdAt, oneDayAgo),
        ),
      )
      .orderBy(desc(obsAiLatencyMetrics.latencyMs));

    if (rows.length >= 5) {
      const p95Index = Math.floor(rows.length * 0.05);
      recentLatencyP95Ms = rows[p95Index]?.latencyMs ?? null;
    }
  } catch (e) {
    console.warn("[insights/ctx] latency signal error:", (e as Error).message);
  }

  // ── AI error rate (last 7 days) ───────────────────────────────────────────
  let recentErrorRatePct: number | null = null;

  try {
    const snapshots = await db
      .select({
        requestCount:       tenantAiUsageSnapshots.requestCount,
        failedRequestCount: tenantAiUsageSnapshots.failedRequestCount,
      })
      .from(tenantAiUsageSnapshots)
      .where(
        and(
          eq(tenantAiUsageSnapshots.organizationId, tenantId),
          gte(tenantAiUsageSnapshots.periodStart, sevenDaysAgo),
        ),
      );

    if (snapshots.length > 0) {
      const totalRequests = snapshots.reduce((s, r) => s + (r.requestCount ?? 0), 0);
      const totalFailed   = snapshots.reduce((s, r) => s + (r.failedRequestCount ?? 0), 0);
      if (totalRequests > 0) {
        recentErrorRatePct = (totalFailed / totalRequests) * 100;
      }
    }
  } catch (e) {
    console.warn("[insights/ctx] error-rate signal error:", (e as Error).message);
  }

  // ── Retrieval confidence (last 7 days) ────────────────────────────────────
  let recentLowConfidenceRatio: number | null = null;

  try {
    const signals = await db
      .select({ confidenceBand: knowledgeRetrievalQualitySignals.confidenceBand })
      .from(knowledgeRetrievalQualitySignals)
      .where(
        and(
          eq(knowledgeRetrievalQualitySignals.tenantId, tenantId),
          gte(knowledgeRetrievalQualitySignals.createdAt, sevenDaysAgo),
        ),
      );

    if (signals.length >= 5) {
      const lowCount = signals.filter((s) => s.confidenceBand === "low").length;
      recentLowConfidenceRatio = lowCount / signals.length;
    }
  } catch (e) {
    console.warn("[insights/ctx] confidence signal error:", (e as Error).message);
  }

  return {
    tenantId,
    budgetUsagePct,
    budgetWarningThresholdPct,
    hasRateLimit,
    recentLatencyP95Ms,
    recentErrorRatePct,
    recentLowConfidenceRatio,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runTenantInsights(tenantId: string): Promise<InsightRunResult> {
  const start = Date.now();
  let created = 0, updated = 0, resolved = 0, skipped = 0;

  const ctx = await collectContext(tenantId);

  // Fetch all existing active insights for tenant (one query, used for dedup)
  const existingActive = await db
    .select()
    .from(tenantInsights)
    .where(and(eq(tenantInsights.tenantId, tenantId), eq(tenantInsights.status, "active")));

  const activeByCode = new Map(existingActive.map((i) => [i.code, i]));
  const firedCodes   = new Set<string>();

  for (const rule of ALL_RULES) {
    let match = null;
    try {
      match = await rule.evaluate(ctx);
    } catch (e) {
      console.error(`[insights/runner] rule ${rule.code} threw:`, (e as Error).message);
      skipped++;
      continue;
    }

    if (match) {
      firedCodes.add(rule.code);
      const existing = activeByCode.get(rule.code);

      if (existing) {
        // Already active — refresh last_detected_at and metadata
        await db
          .update(tenantInsights)
          .set({
            lastDetectedAt: new Date(),
            metadata:       match.metadata,
            updatedAt:      new Date(),
          })
          .where(eq(tenantInsights.id, existing.id));
        updated++;
        console.info(`[insights] updated code=${rule.code} tenant=${tenantId}`);
      } else {
        // New — insert active insight
        await db.insert(tenantInsights).values({
          tenantId:          tenantId,
          code:              rule.code,
          category:          rule.category,
          severity:          rule.severity,
          status:            "active",
          titleKey:          match.titleKey,
          descriptionKey:    match.descriptionKey,
          recommendationKey: match.recommendationKey,
          metadata:          match.metadata,
        }).onConflictDoNothing();
        created++;
        console.info(`[insights] created code=${rule.code} severity=${rule.severity} tenant=${tenantId}`);
      }
    } else {
      // Rule did not fire — resolve existing active insight if present
      const existing = activeByCode.get(rule.code);
      if (existing) {
        await db
          .update(tenantInsights)
          .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(tenantInsights.id, existing.id));
        resolved++;
        console.info(`[insights] resolved code=${rule.code} tenant=${tenantId}`);
      } else {
        skipped++;
      }
    }
  }

  const durationMs = Date.now() - start;
  console.info(`[insights] run complete tenant=${tenantId} created=${created} updated=${updated} resolved=${resolved} skipped=${skipped} ms=${durationMs}`);

  return { tenantId, created, updated, resolved, skipped, durationMs };
}
