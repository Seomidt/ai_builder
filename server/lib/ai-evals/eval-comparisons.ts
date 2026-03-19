/**
 * Phase 17 — Eval Comparisons
 * Explicit prompt version and model comparison.
 *
 * INV-EVAL4: Comparisons are explicit, structured, and tenant-safe.
 * INV-EVAL6: Comparison outputs remain tenant-safe.
 * INV-EVAL12: No hidden cross-tenant data exposure.
 */

import { getEvalRun, listEvalResults } from "./eval-runs";

export interface ScoreDelta {
  dimension: string;
  baselineValue: number;
  candidateValue: number;
  delta: number;
  deltaPercent: number;
  direction: "improvement" | "regression" | "neutral";
}

export interface ComparisonSummary {
  baselineRunId: string;
  candidateRunId: string;
  label: string;
  deltas: ScoreDelta[];
  overallDelta: number;
  regressionCount: number;
  improvementCount: number;
  tenantId: string | null;
}

function computeDelta(baseline: number, candidate: number, dimension: string): ScoreDelta {
  const delta = candidate - baseline;
  const deltaPercent = baseline !== 0 ? (delta / baseline) * 100 : 0;
  const direction: ScoreDelta["direction"] =
    Math.abs(delta) < 0.005 ? "neutral" : delta > 0 ? "improvement" : "regression";
  return { dimension, baselineValue: baseline, candidateValue: candidate, delta, deltaPercent, direction };
}

function extractSummaryScores(run: { summaryScores: unknown } | null): Record<string, number> {
  if (!run?.summaryScores || typeof run.summaryScores !== "object") return {};
  return run.summaryScores as Record<string, number>;
}

/**
 * Compare two prompt versions run over the same dataset.
 * INV-EVAL4: Output is structured and explicit — no hidden winner mutation.
 */
export async function comparePromptVersions(params: {
  baselineRunId: string;
  candidateRunId: string;
  tenantId?: string;
}): Promise<ComparisonSummary | null> {
  try {
    const [baselineRun, candidateRun] = await Promise.all([
      getEvalRun(params.baselineRunId),
      getEvalRun(params.candidateRunId),
    ]);

    if (!baselineRun || !candidateRun) return null;

    const bs = extractSummaryScores(baselineRun);
    const cs = extractSummaryScores(candidateRun);

    const deltas: ScoreDelta[] = [
      computeDelta(bs.avgAnswerQuality ?? 0, cs.avgAnswerQuality ?? 0, "avgAnswerQuality"),
      computeDelta(bs.avgRetrievalQuality ?? 0, cs.avgRetrievalQuality ?? 0, "avgRetrievalQuality"),
      computeDelta(bs.avgGrounding ?? 0, cs.avgGrounding ?? 0, "avgGrounding"),
      // Hallucination: lower is better, so flip for delta direction
      computeDelta(1 - (bs.avgHallucinationRisk ?? 0), 1 - (cs.avgHallucinationRisk ?? 0), "hallucinationSafety"),
      computeDelta(bs.passRate ?? 0, cs.passRate ?? 0, "passRate"),
    ];

    const overallDelta = deltas.reduce((s, d) => s + d.delta, 0) / deltas.length;
    const regressionCount = deltas.filter((d) => d.direction === "regression").length;
    const improvementCount = deltas.filter((d) => d.direction === "improvement").length;

    return {
      baselineRunId: params.baselineRunId,
      candidateRunId: params.candidateRunId,
      label: "prompt_version_comparison",
      deltas,
      overallDelta,
      regressionCount,
      improvementCount,
      tenantId: params.tenantId ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Compare two models run over the same dataset.
 * Also surfaces latency and cost differences if available.
 * INV-EVAL4: No hidden winner. Explicit structured output only.
 */
export async function compareModels(params: {
  baselineRunId: string;
  candidateRunId: string;
  tenantId?: string;
  baselineLatencyMs?: number;
  candidateLatencyMs?: number;
  baselineCostUsd?: number;
  candidateCostUsd?: number;
}): Promise<ComparisonSummary & { latencyDeltaMs: number | null; costDeltaUsd: number | null } | null> {
  try {
    const base = await comparePromptVersions({
      baselineRunId: params.baselineRunId,
      candidateRunId: params.candidateRunId,
      tenantId: params.tenantId,
    });
    if (!base) return null;

    // Latency comparison
    const latencyDeltaMs =
      params.baselineLatencyMs != null && params.candidateLatencyMs != null
        ? params.candidateLatencyMs - params.baselineLatencyMs
        : null;

    // Cost comparison
    const costDeltaUsd =
      params.baselineCostUsd != null && params.candidateCostUsd != null
        ? params.candidateCostUsd - params.baselineCostUsd
        : null;

    // Optionally add latency/cost deltas to the delta list
    const enriched: ScoreDelta[] = [...base.deltas];
    if (latencyDeltaMs !== null && params.baselineLatencyMs! > 0) {
      enriched.push(computeDelta(params.baselineLatencyMs!, params.candidateLatencyMs!, "latencyMs"));
    }
    if (costDeltaUsd !== null && params.baselineCostUsd! > 0) {
      enriched.push(computeDelta(params.baselineCostUsd!, params.candidateCostUsd!, "costUsd"));
    }

    return {
      ...base,
      label: "model_comparison",
      deltas: enriched,
      latencyDeltaMs,
      costDeltaUsd,
    };
  } catch {
    return null;
  }
}

/**
 * Summarize a comparison result in human-readable form.
 * Read-only — no writes.
 */
export function summarizeComparison(summary: ComparisonSummary): {
  headline: string;
  verdict: "improvement" | "regression" | "neutral";
  details: string[];
} {
  const verdict: "improvement" | "regression" | "neutral" =
    summary.improvementCount > summary.regressionCount
      ? "improvement"
      : summary.regressionCount > summary.improvementCount
      ? "regression"
      : "neutral";

  const headline = `${summary.label}: ${verdict} (${summary.improvementCount} improvements, ${summary.regressionCount} regressions)`;
  const details = summary.deltas.map(
    (d) => `${d.dimension}: baseline=${d.baselineValue.toFixed(4)}, candidate=${d.candidateValue.toFixed(4)}, delta=${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(4)} [${d.direction}]`,
  );

  return { headline, verdict, details };
}
