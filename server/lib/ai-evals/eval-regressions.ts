/**
 * Phase 17 — Eval Regressions
 * Detect and record regressions between benchmark runs.
 *
 * INV-EVAL5: Regression results are persisted in ai_eval_regressions.
 * INV-EVAL6: Regression detection remains tenant-safe.
 * INV-EVAL12: No cross-tenant regression leakage.
 */

import { db } from "../../db.ts";
import { aiEvalRegressions } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { getEvalRun, listEvalResults } from "./eval-runs.ts";

export type RegressionType =
  | "answer_quality_drop"
  | "retrieval_quality_drop"
  | "grounding_drop"
  | "hallucination_increase"
  | "latency_regression"
  | "cost_regression";

export type Severity = "low" | "medium" | "high";

// Thresholds for severity assignment (deterministic — INV-EVAL5)
const DROP_THRESHOLDS = {
  medium: 0.05, // 5 percentage point drop → medium severity
  high: 0.15,   // 15 percentage point drop → high severity
};

const INCREASE_THRESHOLDS = {
  medium: 0.05,
  high: 0.15,
};

function assignSeverityForDrop(baselineScore: number, candidateScore: number): Severity {
  const drop = baselineScore - candidateScore;
  if (drop >= DROP_THRESHOLDS.high) return "high";
  if (drop >= DROP_THRESHOLDS.medium) return "medium";
  return "low";
}

function assignSeverityForIncrease(baselineScore: number, candidateScore: number): Severity {
  const increase = candidateScore - baselineScore;
  if (increase >= INCREASE_THRESHOLDS.high) return "high";
  if (increase >= INCREASE_THRESHOLDS.medium) return "medium";
  return "low";
}

export interface RegressionRecord {
  regressionType: RegressionType;
  severity: Severity;
  baselineValue: number;
  candidateValue: number;
  delta: number;
}

/**
 * Detect regressions between a baseline and candidate run.
 * INV-EVAL5: All detected regressions are persisted.
 */
export async function detectRegressions(params: {
  baselineRunId: string;
  candidateRunId: string;
  tenantId?: string;
  latencyBaselineMs?: number;
  latencyCandidateMs?: number;
  costBaselineUsd?: number;
  costCandidateUsd?: number;
}): Promise<{ regressions: Array<{ id: string; regressionType: RegressionType; severity: Severity }> }> {
  const { baselineRunId, candidateRunId, tenantId } = params;

  try {
    const [baselineRun, candidateRun] = await Promise.all([
      getEvalRun(baselineRunId),
      getEvalRun(candidateRunId),
    ]);

    if (!baselineRun?.summaryScores || !candidateRun?.summaryScores) {
      return { regressions: [] };
    }

    const bs = baselineRun.summaryScores as Record<string, number>;
    const cs = candidateRun.summaryScores as Record<string, number>;

    const detectedRegressions: RegressionRecord[] = [];

    // answer_quality_drop
    if (bs.avgAnswerQuality != null && cs.avgAnswerQuality != null && cs.avgAnswerQuality < bs.avgAnswerQuality - 0.01) {
      detectedRegressions.push({
        regressionType: "answer_quality_drop",
        severity: assignSeverityForDrop(bs.avgAnswerQuality, cs.avgAnswerQuality),
        baselineValue: bs.avgAnswerQuality,
        candidateValue: cs.avgAnswerQuality,
        delta: cs.avgAnswerQuality - bs.avgAnswerQuality,
      });
    }

    // retrieval_quality_drop
    if (bs.avgRetrievalQuality != null && cs.avgRetrievalQuality != null && cs.avgRetrievalQuality < bs.avgRetrievalQuality - 0.01) {
      detectedRegressions.push({
        regressionType: "retrieval_quality_drop",
        severity: assignSeverityForDrop(bs.avgRetrievalQuality, cs.avgRetrievalQuality),
        baselineValue: bs.avgRetrievalQuality,
        candidateValue: cs.avgRetrievalQuality,
        delta: cs.avgRetrievalQuality - bs.avgRetrievalQuality,
      });
    }

    // grounding_drop
    if (bs.avgGrounding != null && cs.avgGrounding != null && cs.avgGrounding < bs.avgGrounding - 0.01) {
      detectedRegressions.push({
        regressionType: "grounding_drop",
        severity: assignSeverityForDrop(bs.avgGrounding, cs.avgGrounding),
        baselineValue: bs.avgGrounding,
        candidateValue: cs.avgGrounding,
        delta: cs.avgGrounding - bs.avgGrounding,
      });
    }

    // hallucination_increase
    if (bs.avgHallucinationRisk != null && cs.avgHallucinationRisk != null && cs.avgHallucinationRisk > bs.avgHallucinationRisk + 0.01) {
      detectedRegressions.push({
        regressionType: "hallucination_increase",
        severity: assignSeverityForIncrease(bs.avgHallucinationRisk, cs.avgHallucinationRisk),
        baselineValue: bs.avgHallucinationRisk,
        candidateValue: cs.avgHallucinationRisk,
        delta: cs.avgHallucinationRisk - bs.avgHallucinationRisk,
      });
    }

    // latency_regression (optional, if provided)
    if (params.latencyBaselineMs != null && params.latencyCandidateMs != null) {
      const increase = (params.latencyCandidateMs - params.latencyBaselineMs) / Math.max(1, params.latencyBaselineMs);
      if (increase > 0.2) { // > 20% latency increase
        detectedRegressions.push({
          regressionType: "latency_regression",
          severity: increase > 0.5 ? "high" : increase > 0.3 ? "medium" : "low",
          baselineValue: params.latencyBaselineMs,
          candidateValue: params.latencyCandidateMs,
          delta: params.latencyCandidateMs - params.latencyBaselineMs,
        });
      }
    }

    // cost_regression (optional, if provided)
    if (params.costBaselineUsd != null && params.costCandidateUsd != null) {
      const increase = (params.costCandidateUsd - params.costBaselineUsd) / Math.max(0.0001, params.costBaselineUsd);
      if (increase > 0.2) {
        detectedRegressions.push({
          regressionType: "cost_regression",
          severity: increase > 0.5 ? "high" : increase > 0.3 ? "medium" : "low",
          baselineValue: params.costBaselineUsd,
          candidateValue: params.costCandidateUsd,
          delta: params.costCandidateUsd - params.costBaselineUsd,
        });
      }
    }

    // Persist all detected regressions (INV-EVAL5)
    const persisted: Array<{ id: string; regressionType: RegressionType; severity: Severity }> = [];
    for (const r of detectedRegressions) {
      try {
        const [row] = await db
          .insert(aiEvalRegressions)
          .values({
            tenantId: tenantId ?? null,
            baselineRunId,
            candidateRunId,
            regressionType: r.regressionType,
            severity: r.severity,
            regressionSummary: {
              baselineValue: r.baselineValue,
              candidateValue: r.candidateValue,
              delta: r.delta,
            },
          })
          .returning({ id: aiEvalRegressions.id });
        if (row) persisted.push({ id: row.id, regressionType: r.regressionType, severity: r.severity });
      } catch {
        // non-fatal
      }
    }

    return { regressions: persisted };
  } catch {
    return { regressions: [] };
  }
}

/**
 * List regressions for a tenant (or globally).
 * INV-EVAL6 / INV-EVAL12: Tenant-scoped.
 */
export async function listRegressions(params: {
  tenantId?: string;
  regressionType?: RegressionType;
  limit?: number;
}): Promise<typeof aiEvalRegressions.$inferSelect[]> {
  try {
    const limit = Math.min(params.limit ?? 100, 500);
    const conditions = [];
    if (params.tenantId) conditions.push(eq(aiEvalRegressions.tenantId, params.tenantId));
    if (params.regressionType) conditions.push(eq(aiEvalRegressions.regressionType, params.regressionType));
    let q = db.select().from(aiEvalRegressions);
    const filtered = conditions.length > 0
      ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : q;
    return await filtered.orderBy(desc(aiEvalRegressions.createdAt)).limit(limit);
  } catch {
    return [];
  }
}

/**
 * Explain a regression record — read-only.
 */
export async function explainRegression(regressionId: string): Promise<{
  regression: typeof aiEvalRegressions.$inferSelect;
  baselineRun: unknown;
  candidateRun: unknown;
} | null> {
  try {
    const [reg] = await db
      .select()
      .from(aiEvalRegressions)
      .where(eq(aiEvalRegressions.id, regressionId))
      .limit(1);
    if (!reg) return null;
    const [baseline, candidate] = await Promise.all([
      getEvalRun(reg.baselineRunId),
      getEvalRun(reg.candidateRunId),
    ]);
    return { regression: reg, baselineRun: baseline, candidateRun: candidate };
  } catch {
    return null;
  }
}
