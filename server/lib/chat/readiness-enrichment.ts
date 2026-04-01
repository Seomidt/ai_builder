/**
 * Phase 5Z.2 — Chat Readiness Enrichment
 *
 * Fetches partial-readiness metadata for knowledge documents referenced
 * in a chat request, and attaches it to the API response.
 *
 * Usage: call enrichResponseWithReadiness() after the AI call completes,
 * passing any knowledge document IDs from the request context.
 *
 * INV-RE1: partialWarning is null iff answerCompleteness === "complete".
 * INV-RE2: isPartial is true iff answerCompleteness !== "complete".
 * INV-RE3: All DB queries are tenant-scoped.
 */

import { getDocumentReadiness }          from "../media/partial-readiness.ts";
import { checkInstantAnswerEligibility } from "../media/instant-answer-readiness.ts";
import { evaluateAnswerTiming }          from "../media/answer-timing-policy.ts";

// ── Public type: enrichment blob added to chat responses ──────────────────────

export interface ChatReadinessEnrichment {
  documentStatus:        string;
  answerCompleteness:    string;
  isPartial:             boolean;
  coveragePercent:       number;
  segmentsReady:         number;
  segmentsTotal:         number;
  hasFailedSegments:     boolean;
  hasDeadLetterSegments: boolean;
  fullCompletionBlocked: boolean;
  partialWarning:        string | null;
  firstRetrievalReadyAt: string | null;
  canRefreshForBetterAnswer: boolean;
  answerTimingDecision:  string;
}

// ── enrichResponseWithReadiness ────────────────────────────────────────────────

/**
 * Look up readiness for the given knowledge document IDs and return
 * an enrichment blob ready to spread into the API response.
 *
 * Returns null if documentIds is empty or an error occurs (non-fatal).
 */
export async function enrichResponseWithReadiness(params: {
  tenantId:    string;
  documentIds: string[];
}): Promise<ChatReadinessEnrichment | null> {
  const { tenantId, documentIds } = params;
  if (!documentIds.length) return null;

  try {
    const { db } = await import("../../db.ts");
    const { knowledgeDocuments } = await import("../../../shared/schema.ts");
    const { inArray, eq, and } = await import("drizzle-orm");

    // Fetch current_version_id for each document (tenant-scoped — INV-RE3)
    const docs = await db
      .select({ id: knowledgeDocuments.id, currentVersionId: knowledgeDocuments.currentVersionId })
      .from(knowledgeDocuments)
      .where(
        and(
          inArray(knowledgeDocuments.id, documentIds),
          eq(knowledgeDocuments.tenantId, tenantId),
        ),
      );

    const versionIds = docs
      .map((d) => d.currentVersionId)
      .filter((v): v is string => !!v);

    if (!versionIds.length) return null;

    // Fetch readiness for each version and aggregate
    const readinessResults = await Promise.allSettled(
      versionIds.map((versionId) =>
        getDocumentReadiness({ tenantId, knowledgeDocumentVersionId: versionId }),
      ),
    );

    const successfulResults = readinessResults
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getDocumentReadiness>>> =>
        r.status === "fulfilled",
      )
      .map((r) => r.value);

    if (!successfulResults.length) return null;

    // Aggregate: worst-case across all documents
    const aggregated = aggregateReadiness(successfulResults);

    // Eligibility check from the first available version
    const eligibility = await checkInstantAnswerEligibility({
      tenantId,
      knowledgeDocumentVersionId: versionIds[0]!,
    });

    // Timing policy
    const timingResult = evaluateAnswerTiming({
      coveragePercent:       aggregated.coveragePercent,
      segmentsReady:         aggregated.segmentsReady,
      segmentsTotal:         aggregated.segmentsTotal,
      retrievalChunksActive: successfulResults[0]?.retrievalChunksActive ?? 0,
      timeSinceUploadMs:     0,
      fullCompletionBlocked: aggregated.fullCompletionBlocked,
    });

    return {
      documentStatus:           aggregated.documentStatus,
      answerCompleteness:       aggregated.answerCompleteness,
      isPartial:                aggregated.answerCompleteness !== "complete",
      coveragePercent:          aggregated.coveragePercent,
      segmentsReady:            aggregated.segmentsReady,
      segmentsTotal:            aggregated.segmentsTotal,
      hasFailedSegments:        aggregated.hasFailedSegments,
      hasDeadLetterSegments:    aggregated.hasDeadLetterSegments,
      fullCompletionBlocked:    aggregated.fullCompletionBlocked,
      partialWarning:           aggregated.partialWarning,
      firstRetrievalReadyAt:    eligibility.firstRetrievalReadyAt,
      canRefreshForBetterAnswer: eligibility.canRefreshForBetterAnswer,
      answerTimingDecision:     timingResult.decision,
    };
  } catch (err) {
    console.error("[readiness-enrichment] non-fatal error:", (err as Error).message);
    return null;
  }
}

// ── aggregateReadiness (worst-case across multiple documents) ─────────────────

type ReadinessResult = Awaited<ReturnType<typeof getDocumentReadiness>>;

function aggregateReadiness(results: ReadinessResult[]): ReadinessResult {
  if (results.length === 1) return results[0]!;

  const COMPLETENESS_RANK: Record<string, number> = {
    complete: 2,
    partial:  1,
    none:     0,
  };

  // Pick the worst-case across all documents
  let worst = results[0]!;
  for (const r of results.slice(1)) {
    const worstRank = COMPLETENESS_RANK[worst.answerCompleteness] ?? 0;
    const rRank     = COMPLETENESS_RANK[r.answerCompleteness]    ?? 0;
    if (rRank < worstRank) worst = r;
  }

  return {
    ...worst,
    // Sum up segments across all docs for total picture
    segmentsReady: results.reduce((s, r) => s + r.segmentsReady,  0),
    segmentsTotal: results.reduce((s, r) => s + r.segmentsTotal,  0),
    // Any failure in any doc counts
    hasFailedSegments:     results.some((r) => r.hasFailedSegments),
    hasDeadLetterSegments: results.some((r) => r.hasDeadLetterSegments),
    fullCompletionBlocked: results.some((r) => r.fullCompletionBlocked),
    // Average coverage
    coveragePercent: Math.round(
      results.reduce((s, r) => s + r.coveragePercent, 0) / results.length,
    ),
    // Collect all warnings
    partialWarning: results
      .map((r) => r.partialWarning)
      .filter((w): w is string => w !== null)
      .join(" | ") || null,
  };
}
