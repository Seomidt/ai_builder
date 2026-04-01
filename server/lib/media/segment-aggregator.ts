/**
 * Phase 5Z.1 — Segment Aggregator
 *
 * Computes the authoritative completion/readiness status of a document version
 * by inspecting all its knowledge_processing_jobs (the "segments" in this
 * codebase's terminology).
 *
 * Design rules (per Phase 5Z.1 spec):
 *  A. completed          — all required steps done with validated output
 *  B. partially_ready    — ≥1 retrieval-ready chunk exists, but not fully done
 *  C. partially_ready_with_failures — partially ready AND some steps are dead
 *  D. retryable_failed   — ≥1 required step failed but retries remain
 *  E. failed             — required steps exhausted, no retrieval chunks
 *  F. dead_letter        — all retries exhausted AND full completion is blocked
 *  G. processing         — work still in progress
 *
 * INV-AGG1: completed requires zero failed/running required steps.
 * INV-AGG2: partially_ready requires at least one indexed/embedded chunk.
 * INV-AGG3: dead_letter requires attempt_count >= max_attempts AND failed steps.
 * INV-AGG4: status transitions are computed — never stored without re-check.
 * INV-AGG5: All queries are tenant-scoped.
 */

import pg from "pg";
import { resolveDbUrl } from "../jobs/job-queue.ts";
import { getSupabaseSslConfig } from "../jobs/ssl-config.ts";

// ── Job step categories ────────────────────────────────────────────────────────
// "Retrieval-producing" steps: completing these creates searchable chunks.
// Completion of ALL required steps → document is fully complete.

const RETRIEVAL_PRODUCING_JOB_TYPES = new Set([
  "embed",
  "embedding_generate",
  "index",
]);

const PARSE_JOB_TYPES = new Set([
  "parse",
  "extract_text",
  "ocr_parse",
  "structured_parse",
  "transcript_parse",
  "import_parse",
]);

const CHUNK_JOB_TYPES = new Set([
  "chunk",
  "ocr_chunk",
  "structured_chunk",
  "transcript_chunk",
  "import_chunk",
]);

// A job is "terminal-failed" when it has exhausted all retries.
function isTerminalFailed(row: JobRow): boolean {
  return row.status === "failed" && row.attempt_count >= row.max_attempts;
}

// A job is "retryable" when it failed but retries remain.
function isRetryableFailed(row: JobRow): boolean {
  return row.status === "failed" && row.attempt_count < row.max_attempts;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type AggregatedDocumentStatus =
  | "not_started"
  | "processing"
  | "partially_ready"
  | "partially_ready_with_failures"
  | "completed"
  | "retryable_failed"
  | "failed"
  | "dead_letter";

export type AnswerCompleteness = "none" | "partial" | "complete";

export interface JobRow {
  id:            string;
  job_type:      string;
  status:        string;
  attempt_count: number;
  max_attempts:  number;
  failure_reason: string | null;
  started_at:    Date | null;
  completed_at:  Date | null;
  estimated_cost_usd: string | null;
  token_usage:   number | null;
}

export interface AggregationResult {
  documentStatus:        AggregatedDocumentStatus;
  answerCompleteness:    AnswerCompleteness;
  segmentsTotal:         number;
  segmentsCompleted:     number;
  segmentsFailed:        number;
  segmentsProcessing:    number;
  segmentsQueued:        number;
  segmentsDeadLetter:    number;
  coveragePercent:       number;
  hasFailedSegments:     boolean;
  hasDeadLetterSegments: boolean;
  fullCompletionBlocked: boolean;
  retrievalChunksActive: number;
  /** ISO timestamp of first retrieval-producing job completion, if available. */
  firstRetrievalReadyAt: string | null;
  jobDetails:            JobRow[];
  invariantViolations:   string[];
}

// ── invariant checks ───────────────────────────────────────────────────────────

function checkInvariants(result: Omit<AggregationResult, "invariantViolations">): string[] {
  const violations: string[] = [];

  if (result.segmentsCompleted > result.segmentsTotal) {
    violations.push(
      `INV-AGG1 VIOLATION: segmentsCompleted(${result.segmentsCompleted}) > segmentsTotal(${result.segmentsTotal})`,
    );
  }

  if (result.documentStatus === "completed" && result.retrievalChunksActive === 0) {
    violations.push(
      "INV-AGG2 VIOLATION: status=completed but retrievalChunksActive=0",
    );
  }

  if (result.documentStatus === "completed" && result.hasFailedSegments) {
    violations.push(
      "INV-AGG1 VIOLATION: status=completed but hasFailedSegments=true",
    );
  }

  if (result.documentStatus === "completed" && result.segmentsProcessing > 0) {
    violations.push(
      "INV-AGG1 VIOLATION: status=completed but segmentsProcessing > 0",
    );
  }

  if (
    result.documentStatus === "dead_letter" &&
    !result.hasDeadLetterSegments &&
    !result.fullCompletionBlocked
  ) {
    violations.push(
      "INV-AGG3 VIOLATION: status=dead_letter but no dead-letter segments found",
    );
  }

  return violations;
}

// ── getDocumentAggregation ─────────────────────────────────────────────────────

export async function getDocumentAggregation(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<AggregationResult> {
  const { tenantId, knowledgeDocumentVersionId } = params;

  const client = new pg.Client({
    connectionString: resolveDbUrl(),
    ssl: getSupabaseSslConfig(),
  });
  await client.connect();

  try {
    // ── 1. Fetch all processing jobs for this document version ─────────────
    const jobsResult = await client.query<JobRow>(`
      SELECT
        id, job_type, status, attempt_count, max_attempts,
        failure_reason, started_at, completed_at,
        estimated_cost_usd, token_usage
      FROM knowledge_processing_jobs
      WHERE tenant_id = $1
        AND knowledge_document_version_id = $2
      ORDER BY created_at ASC
    `, [tenantId, knowledgeDocumentVersionId]);

    const jobs = jobsResult.rows;

    // ── 2. Count active retrieval chunks ────────────────────────────────────
    const chunksResult = await client.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt
      FROM knowledge_chunks
      WHERE tenant_id = $1
        AND knowledge_document_version_id = $2
        AND chunk_active = true
    `, [tenantId, knowledgeDocumentVersionId]);
    const retrievalChunksActive = parseInt(chunksResult.rows[0]?.cnt ?? "0", 10);

    // ── 3. Categorise jobs ─────────────────────────────────────────────────
    let segmentsCompleted  = 0;
    let segmentsFailed     = 0;
    let segmentsProcessing = 0;
    let segmentsQueued     = 0;
    let segmentsDeadLetter = 0;
    let hasDeadLetterSegments = false;
    let hasRetryableFailures  = false;

    for (const job of jobs) {
      switch (job.status) {
        case "completed":
        case "skipped":
          segmentsCompleted++;
          break;
        case "running":
          segmentsProcessing++;
          break;
        case "failed":
          segmentsFailed++;
          if (isTerminalFailed(job)) {
            segmentsDeadLetter++;
            hasDeadLetterSegments = true;
          } else {
            hasRetryableFailures = true;
          }
          break;
        case "queued":
          segmentsQueued++;
          break;
        case "cancelled":
          break;
      }
    }

    const segmentsTotal      = jobs.length;
    const hasFailedSegments  = segmentsFailed > 0;

    // ── 4. Determine retrieval-producing coverage ──────────────────────────
    // Among embedding/index jobs only
    const retrievalJobs        = jobs.filter((j) => RETRIEVAL_PRODUCING_JOB_TYPES.has(j.job_type));
    const retrievalJobsDone    = retrievalJobs.filter((j) => j.status === "completed" || j.status === "skipped");
    const retrievalJobsFailed  = retrievalJobs.filter((j) => isTerminalFailed(j));
    const retrievalJobsRetry   = retrievalJobs.filter((j) => isRetryableFailed(j));

    const totalRelevant    = retrievalJobs.length;
    const completedRelevant = retrievalJobsDone.length;
    const coveragePercent  = totalRelevant > 0
      ? Math.round((completedRelevant / totalRelevant) * 100)
      : (jobs.length > 0 && segmentsCompleted === jobs.length ? 100 : 0);

    // ── 5. Determine full-completion blocked ──────────────────────────────
    const fullCompletionBlocked =
      hasDeadLetterSegments ||
      (retrievalJobsFailed.length > 0) ||
      (coveragePercent < 100 && segmentsDeadLetter > 0);

    // ── 6. Compute aggregated status ───────────────────────────────────────
    let documentStatus: AggregatedDocumentStatus;
    let answerCompleteness: AnswerCompleteness;

    if (jobs.length === 0) {
      documentStatus     = "not_started";
      answerCompleteness = "none";
    } else if (
      segmentsCompleted === segmentsTotal &&
      segmentsTotal > 0 &&
      retrievalChunksActive > 0 &&
      !hasFailedSegments
    ) {
      // INV-AGG1: ALL steps completed, chunks exist, no failures
      documentStatus     = "completed";
      answerCompleteness = "complete";
    } else if (retrievalChunksActive > 0 && fullCompletionBlocked) {
      // Chunks exist but we can never finish — partial with permanent failures
      documentStatus     = "partially_ready_with_failures";
      answerCompleteness = "partial";
    } else if (retrievalChunksActive > 0 && (segmentsProcessing > 0 || segmentsQueued > 0 || hasRetryableFailures)) {
      // Chunks exist and more work is pending/retrying
      documentStatus     = "partially_ready";
      answerCompleteness = "partial";
    } else if (hasDeadLetterSegments && retrievalChunksActive === 0) {
      // No usable chunks and permanently blocked
      documentStatus     = "dead_letter";
      answerCompleteness = "none";
    } else if (hasRetryableFailures && retrievalChunksActive === 0) {
      documentStatus     = "retryable_failed";
      answerCompleteness = "none";
    } else if (hasFailedSegments && retrievalChunksActive === 0 && segmentsProcessing === 0 && segmentsQueued === 0) {
      documentStatus     = "failed";
      answerCompleteness = "none";
    } else if (segmentsProcessing > 0 || segmentsQueued > 0) {
      documentStatus     = "processing";
      answerCompleteness = "none";
    } else {
      documentStatus     = "processing";
      answerCompleteness = "none";
    }

    // ── 8. Compute firstRetrievalReadyAt ──────────────────────────────────
    // Earliest completed_at among retrieval-producing jobs.
    const firstRetrievalReadyAt = (() => {
      const done = jobs
        .filter((j) => RETRIEVAL_PRODUCING_JOB_TYPES.has(j.job_type) && j.status === "completed" && j.completed_at)
        .sort((a, b) => {
          const aMs = a.completed_at instanceof Date ? a.completed_at.getTime() : new Date(a.completed_at as unknown as string).getTime();
          const bMs = b.completed_at instanceof Date ? b.completed_at.getTime() : new Date(b.completed_at as unknown as string).getTime();
          return aMs - bMs;
        });
      const first = done[0];
      if (!first?.completed_at) return null;
      return first.completed_at instanceof Date
        ? first.completed_at.toISOString()
        : new Date(first.completed_at as unknown as string).toISOString();
    })();

    const resultWithoutViolations = {
      documentStatus,
      answerCompleteness,
      segmentsTotal,
      segmentsCompleted,
      segmentsFailed,
      segmentsProcessing,
      segmentsQueued,
      segmentsDeadLetter,
      coveragePercent,
      hasFailedSegments,
      hasDeadLetterSegments,
      fullCompletionBlocked,
      retrievalChunksActive,
      firstRetrievalReadyAt,
      jobDetails: jobs,
    };

    // ── 7. Invariant checks (fail loud in logs, never silently pass) ───────
    const invariantViolations = checkInvariants(resultWithoutViolations);
    if (invariantViolations.length > 0) {
      console.error(
        `[segment-aggregator] INVARIANT VIOLATIONS for version=${knowledgeDocumentVersionId}:`,
        invariantViolations,
      );
    }

    return { ...resultWithoutViolations, invariantViolations };

  } finally {
    await client.end();
  }
}

// ── canMarkJobCompleted ────────────────────────────────────────────────────────
// Guards the job completion path: a "completed" status must not be written
// unless aggregation confirms it is valid.
// Call this BEFORE marking the parent document version as 'completed'.

export async function canMarkDocumentCompleted(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<{ allowed: boolean; reason: string; aggregation: AggregationResult }> {
  const aggregation = await getDocumentAggregation(params);

  if (aggregation.documentStatus !== "completed") {
    return {
      allowed: false,
      reason:  `Aggregation status is '${aggregation.documentStatus}' — not all required segments are complete`,
      aggregation,
    };
  }

  if (aggregation.invariantViolations.length > 0) {
    return {
      allowed: false,
      reason:  `Aggregation invariant violations: ${aggregation.invariantViolations.join("; ")}`,
      aggregation,
    };
  }

  return { allowed: true, reason: "All segments completed with valid output", aggregation };
}
