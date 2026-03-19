/**
 * Phase 17 — Eval Runs
 * Benchmark run lifecycle management.
 *
 * INV-EVAL2: Benchmark runs are append-only.
 * INV-EVAL7: Benchmark failures must not break production runtime.
 * INV-EVAL3: All aggregated scores remain bounded.
 */

import { db } from "../../db";
import { aiEvalRuns, aiEvalResults, aiEvalCases } from "@shared/schema";
import { eq, desc, and } from "drizzle-orm";
import { listEvalCases } from "./eval-datasets";
import { scoreAnswerQuality, scoreRetrievalQuality, scoreGrounding, scoreHallucinationRisk, summarizeEvalScores } from "./eval-scorer";

// ── Run lifecycle ─────────────────────────────────────────────────────────────

/**
 * Create a new eval run in 'queued' state.
 * INV-EVAL2: Append-only — never overwrites historical runs.
 */
export async function createEvalRun(params: {
  tenantId?: string;
  datasetId: string;
  promptVersionId?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .insert(aiEvalRuns)
      .values({
        tenantId: params.tenantId ?? null,
        datasetId: params.datasetId,
        promptVersionId: params.promptVersionId ?? null,
        modelId: params.modelId ?? null,
        runStatus: "queued",
        totalCases: 0,
        completedCases: 0,
        summaryScores: null,
        metadata: params.metadata ?? null,
        startedAt: null,
        completedAt: null,
      })
      .returning({ id: aiEvalRuns.id });
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Transition run to 'running'.
 * INV-EVAL2: Status transitions never delete prior state.
 */
export async function startEvalRun(runId: string): Promise<boolean> {
  try {
    const result = await db
      .update(aiEvalRuns)
      .set({ runStatus: "running", startedAt: new Date() })
      .where(eq(aiEvalRuns.id, runId));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Transition run to 'completed' with summary scores.
 * INV-EVAL2: Append-only — completed_at is set once.
 */
export async function completeEvalRun(
  runId: string,
  summaryScores: Record<string, unknown>,
  completedCases: number,
): Promise<boolean> {
  try {
    const result = await db
      .update(aiEvalRuns)
      .set({ runStatus: "completed", summaryScores, completedCases, completedAt: new Date() })
      .where(eq(aiEvalRuns.id, runId));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Transition run to 'failed'.
 * INV-EVAL7: Failure recorded without touching production data.
 */
export async function failEvalRun(runId: string, reason?: string): Promise<boolean> {
  try {
    const result = await db
      .update(aiEvalRuns)
      .set({ runStatus: "failed", completedAt: new Date(), metadata: reason ? { failReason: reason } : undefined })
      .where(eq(aiEvalRuns.id, runId));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Get a single eval run by ID.
 */
export async function getEvalRun(runId: string): Promise<typeof aiEvalRuns.$inferSelect | null> {
  try {
    const [row] = await db.select().from(aiEvalRuns).where(eq(aiEvalRuns.id, runId)).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * List eval runs, optionally filtered by tenant/dataset.
 */
export async function listEvalRuns(params: {
  tenantId?: string;
  datasetId?: string;
  limit?: number;
}): Promise<typeof aiEvalRuns.$inferSelect[]> {
  try {
    const limit = Math.min(params.limit ?? 100, 500);
    const conditions = [];
    if (params.tenantId) conditions.push(eq(aiEvalRuns.tenantId, params.tenantId));
    if (params.datasetId) conditions.push(eq(aiEvalRuns.datasetId, params.datasetId));
    let q = db.select().from(aiEvalRuns);
    const filtered = conditions.length > 0
      ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : q;
    return await filtered.orderBy(desc(aiEvalRuns.createdAt)).limit(limit);
  } catch {
    return [];
  }
}

/**
 * List eval results for a run.
 */
export async function listEvalResults(runId: string, limit = 200): Promise<typeof aiEvalResults.$inferSelect[]> {
  try {
    return await db
      .select()
      .from(aiEvalResults)
      .where(eq(aiEvalResults.runId, runId))
      .orderBy(desc(aiEvalResults.createdAt))
      .limit(Math.min(limit, 1000));
  } catch {
    return [];
  }
}

// ── Benchmark runner ──────────────────────────────────────────────────────────

export interface BenchmarkCaseInput {
  caseId: string;
  answerText: string;
  retrievedChunks?: Array<{ finalScore: number; chunkText?: string }>;
  citedChunkTexts?: string[];
  unsupportedClaimCount?: number;
  totalClaimCount?: number;
  citationCoverageRatio?: number;
  certaintyPhraseCount?: number;
}

export interface BenchmarkRunResult {
  runId: string;
  completedCases: number;
  summaryScores: Record<string, unknown>;
  passRate: number;
}

/**
 * Run a full dataset benchmark.
 *
 * INV-EVAL2: Results appended — never overwrites historical runs.
 * INV-EVAL7: Exceptions caught — production runtime is not affected.
 * INV-EVAL3: All stored scores are bounded.
 *
 * Pipeline:
 * 1. Create run record
 * 2. Load cases from dataset
 * 3. Score each case
 * 4. Persist per-case results
 * 5. Aggregate + complete run
 */
export async function runDatasetBenchmark(params: {
  datasetId: string;
  tenantId?: string;
  promptVersionId?: string;
  modelId?: string;
  caseInputs: BenchmarkCaseInput[];
  passThreshold?: number;
}): Promise<BenchmarkRunResult | null> {
  let runId: string | undefined;
  try {
    // Step 1: create run
    const run = await createEvalRun({
      tenantId: params.tenantId,
      datasetId: params.datasetId,
      promptVersionId: params.promptVersionId,
      modelId: params.modelId,
    });
    if (!run) return null;
    runId = run.id;

    // Step 2: load cases for total count
    const cases = await listEvalCases({ datasetId: params.datasetId, tenantId: params.tenantId });
    await db.update(aiEvalRuns).set({ totalCases: cases.length }).where(eq(aiEvalRuns.id, runId));
    await startEvalRun(runId);

    // Step 3 + 4: score and persist per-case results
    const scoreAccumulator = { aq: 0, rq: 0, gr: 0, hr: 0, passes: 0 };
    let completed = 0;

    for (const ci of params.caseInputs) {
      try {
        const aqResult = scoreAnswerQuality({ answerText: ci.answerText, inputQuery: ci.caseId });
        const rqResult = scoreRetrievalQuality({ chunks: ci.retrievedChunks ?? [] });
        const grResult = scoreGrounding({
          answerText: ci.answerText,
          citedChunkTexts: ci.citedChunkTexts ?? [],
          unsupportedClaimCount: ci.unsupportedClaimCount ?? 0,
          totalClaimCount: ci.totalClaimCount ?? 0,
        });
        const hrResult = scoreHallucinationRisk({
          answerText: ci.answerText,
          unsupportedClaimCount: ci.unsupportedClaimCount ?? 0,
          totalClaimCount: ci.totalClaimCount ?? 0,
          citationCoverageRatio: ci.citationCoverageRatio ?? 0,
          certaintyPhraseCount: ci.certaintyPhraseCount ?? 0,
        });
        const summary = summarizeEvalScores({
          answerQualityScore: aqResult.score,
          retrievalQualityScore: rqResult.score,
          groundingScore: grResult.score,
          hallucinationRiskScore: hrResult.score,
          passThreshold: params.passThreshold,
        });

        // Persist result (INV-EVAL2: append-only)
        await db.insert(aiEvalResults).values({
          runId,
          caseId: ci.caseId,
          tenantId: params.tenantId ?? null,
          answerQualityScore: String(aqResult.score),
          retrievalQualityScore: String(rqResult.score),
          groundingScore: String(grResult.score),
          hallucinationRiskScore: String(hrResult.score),
          pass: summary.pass,
          resultSummary: {
            overallScore: summary.overallScore,
            breakdown: {
              aq: aqResult.breakdown,
              rq: rqResult.breakdown,
              gr: grResult.breakdown,
              hr: hrResult.breakdown,
            },
          },
        });

        scoreAccumulator.aq += aqResult.score;
        scoreAccumulator.rq += rqResult.score;
        scoreAccumulator.gr += grResult.score;
        scoreAccumulator.hr += hrResult.score;
        if (summary.pass) scoreAccumulator.passes++;
        completed++;
      } catch {
        // INV-EVAL7: per-case failure does not abort run
      }
    }

    // Step 5: aggregate
    const n = Math.max(1, completed);
    const summaryScores = {
      avgAnswerQuality: Math.round((scoreAccumulator.aq / n) * 10000) / 10000,
      avgRetrievalQuality: Math.round((scoreAccumulator.rq / n) * 10000) / 10000,
      avgGrounding: Math.round((scoreAccumulator.gr / n) * 10000) / 10000,
      avgHallucinationRisk: Math.round((scoreAccumulator.hr / n) * 10000) / 10000,
      passRate: Math.round((scoreAccumulator.passes / n) * 10000) / 10000,
      completedCases: completed,
      totalCases: cases.length,
    };

    await completeEvalRun(runId, summaryScores, completed);

    return {
      runId,
      completedCases: completed,
      summaryScores,
      passRate: summaryScores.passRate,
    };
  } catch {
    // INV-EVAL7: fail gracefully
    if (runId) await failEvalRun(runId, "Unexpected benchmark error");
    return null;
  }
}

/**
 * Explain a benchmark run — read-only, no writes.
 */
export async function explainEvalRun(runId: string): Promise<{
  run: typeof aiEvalRuns.$inferSelect | null;
  resultCount: number;
  passCount: number;
} | null> {
  try {
    const run = await getEvalRun(runId);
    if (!run) return null;
    const results = await listEvalResults(runId, 1000);
    const passCount = results.filter((r) => r.pass).length;
    return { run, resultCount: results.length, passCount };
  } catch {
    return null;
  }
}
