/**
 * Phase 17 — Eval Observability
 * Integrates evaluation platform with Phase 15 observability layer.
 *
 * INV-EVAL6: Metrics remain tenant-safe.
 * INV-EVAL7: Observability reads never affect production runtime.
 * INV-EVAL12: No cross-tenant metric leakage.
 *
 * Privacy / overhead policy:
 * - No PII stored in eval metrics
 * - Metrics are aggregated counts and scores only
 * - Tenant isolation enforced at query level
 */

import { db } from "../../db";
import { aiEvalRuns, aiEvalResults, aiEvalRegressions } from "@shared/schema";
import { eq, desc, and, count, sql as drizzleSql } from "drizzle-orm";
import { listEvalResults } from "./eval-runs";

// ── Eval Metrics ──────────────────────────────────────────────────────────────

export interface EvalMetrics {
  tenantId: string | null;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalResults: number;
  passCount: number;
  failCount: number;
  passRate: number;
  avgAnswerQuality: number;
  avgRetrievalQuality: number;
  avgGrounding: number;
  avgHallucinationRisk: number;
  regressionCount: number;
  window: string;
}

/**
 * Get aggregated eval metrics for a tenant (or global).
 * INV-EVAL6: Tenant-scoped when tenantId provided.
 */
export async function getEvalMetrics(params: {
  tenantId?: string;
  limitRuns?: number;
}): Promise<EvalMetrics> {
  const tenantId = params.tenantId ?? null;
  const limitRuns = Math.min(params.limitRuns ?? 100, 500);

  try {
    // Fetch recent runs
    const conditions = tenantId ? [eq(aiEvalRuns.tenantId, tenantId)] : [];
    const runs = await (conditions.length > 0
      ? db.select().from(aiEvalRuns).where(conditions[0]).orderBy(desc(aiEvalRuns.createdAt)).limit(limitRuns)
      : db.select().from(aiEvalRuns).orderBy(desc(aiEvalRuns.createdAt)).limit(limitRuns));

    const completedRuns = runs.filter((r) => r.runStatus === "completed").length;
    const failedRuns = runs.filter((r) => r.runStatus === "failed").length;

    // Aggregate summary scores from completed runs
    let totalResults = 0, passCount = 0, failCount = 0;
    let sumAQ = 0, sumRQ = 0, sumGR = 0, sumHR = 0, scoreCount = 0;

    for (const run of runs.filter((r) => r.runStatus === "completed")) {
      const ss = (run.summaryScores ?? {}) as Record<string, number>;
      if (ss.completedCases) totalResults += ss.completedCases;
      if (ss.passRate != null && ss.completedCases) passCount += Math.round(ss.passRate * ss.completedCases);
      if (ss.avgAnswerQuality != null) { sumAQ += ss.avgAnswerQuality; scoreCount++; }
      if (ss.avgRetrievalQuality != null) sumRQ += ss.avgRetrievalQuality;
      if (ss.avgGrounding != null) sumGR += ss.avgGrounding;
      if (ss.avgHallucinationRisk != null) sumHR += ss.avgHallucinationRisk;
    }

    failCount = totalResults - passCount;
    const n = Math.max(1, scoreCount);

    // Regression count
    const regConditions = tenantId ? [eq(aiEvalRegressions.tenantId, tenantId)] : [];
    const regressionRows = await (regConditions.length > 0
      ? db.select({ id: aiEvalRegressions.id }).from(aiEvalRegressions).where(regConditions[0]).limit(1000)
      : db.select({ id: aiEvalRegressions.id }).from(aiEvalRegressions).limit(1000));

    return {
      tenantId,
      totalRuns: runs.length,
      completedRuns,
      failedRuns,
      totalResults,
      passCount,
      failCount,
      passRate: totalResults > 0 ? Math.round((passCount / totalResults) * 10000) / 10000 : 0,
      avgAnswerQuality: Math.round((sumAQ / n) * 10000) / 10000,
      avgRetrievalQuality: Math.round((sumRQ / n) * 10000) / 10000,
      avgGrounding: Math.round((sumGR / n) * 10000) / 10000,
      avgHallucinationRisk: Math.round((sumHR / n) * 10000) / 10000,
      regressionCount: regressionRows.length,
      window: `last ${limitRuns} runs`,
    };
  } catch {
    return {
      tenantId,
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      totalResults: 0,
      passCount: 0,
      failCount: 0,
      passRate: 0,
      avgAnswerQuality: 0,
      avgRetrievalQuality: 0,
      avgGrounding: 0,
      avgHallucinationRisk: 0,
      regressionCount: 0,
      window: "error",
    };
  }
}

/**
 * Summarize eval metrics as text.
 * INV-EVAL6: No PII, no production data.
 */
export function summarizeEvalMetrics(metrics: EvalMetrics): string {
  return [
    `Eval Metrics [${metrics.tenantId ?? "global"}] (${metrics.window}):`,
    `  Runs: ${metrics.totalRuns} total (${metrics.completedRuns} completed, ${metrics.failedRuns} failed)`,
    `  Results: ${metrics.totalResults} | Pass: ${metrics.passCount} | Fail: ${metrics.failCount} | PassRate: ${(metrics.passRate * 100).toFixed(2)}%`,
    `  Avg Scores: AnswerQuality=${metrics.avgAnswerQuality.toFixed(4)}, RetrievalQuality=${metrics.avgRetrievalQuality.toFixed(4)}`,
    `              Grounding=${metrics.avgGrounding.toFixed(4)}, HallucinationRisk=${metrics.avgHallucinationRisk.toFixed(4)}`,
    `  Regressions: ${metrics.regressionCount}`,
  ].join("\n");
}

/**
 * List recent failed eval results for observability triage.
 * INV-EVAL6: Tenant-scoped where provided.
 */
export async function listRecentFailures(params: {
  tenantId?: string;
  limit?: number;
}): Promise<typeof aiEvalResults.$inferSelect[]> {
  try {
    const limit = Math.min(params.limit ?? 50, 200);
    const conditions = [eq(aiEvalResults.pass, false)];
    if (params.tenantId) conditions.push(eq(aiEvalResults.tenantId, params.tenantId));
    return await db
      .select()
      .from(aiEvalResults)
      .where(and(...conditions))
      .orderBy(desc(aiEvalResults.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Get benchmark run latency from a completed run's metadata.
 * INV-EVAL6: Read-only. No writes.
 */
export function extractBenchmarkLatency(run: { startedAt: Date | null; completedAt: Date | null }): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  return run.completedAt.getTime() - run.startedAt.getTime();
}
