/**
 * Phase 5Z.1 — Segment Cost Rollup
 *
 * Aggregates per-job cost data into a document-level cost summary.
 *
 * Design principles:
 *  - Actual and estimated costs are ALWAYS clearly distinguished.
 *  - Superseded/stale job rows are EXCLUDED from rollup (only completed jobs).
 *  - Rollup is deterministic: same DB state → same result.
 *  - Multi-tenant safe: all queries scoped by tenantId.
 *
 * INV-COST1: estimated_total and actual_total are never mixed without labelling.
 * INV-COST2: Only completed job rows contribute to cost totals.
 * INV-COST3: No cross-tenant cost leakage.
 * INV-COST4: fallback_count reflects real fallback events, not estimates.
 */

import pg from "pg";
import { resolveDbUrl } from "../jobs/job-queue.ts";
import { getSupabaseSslConfig } from "../jobs/ssl-config.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SegmentCostRow {
  job_type:            string;
  status:              string;
  estimated_cost_usd:  string | null;
  token_usage:         number | null;
  embedding_provider:  string | null;
  embedding_model:     string | null;
  started_at:          Date | null;
  completed_at:        Date | null;
}

export interface JobCostSummary {
  jobType:          string;
  provider:         string | null;
  model:            string | null;
  /** Estimated cost in USD. Labelled clearly — not actual. */
  estimatedCostUsd: number;
  /** Total token usage (input+output combined where tracked). */
  tokenUsage:       number;
  /** Duration in ms, null if timing unavailable. */
  durationMs:       number | null;
  /** Whether this is an estimate or actual (always estimate here). */
  costIsEstimate:   true;
}

export interface DocumentCostRollup {
  /** Sum of all completed job estimated costs — ESTIMATE, not actual. */
  totalEstimatedCostUsd: number;
  /** Actual total: null because provider actuals are not yet tracked. */
  totalActualCostUsd: null;
  /** true = totalEstimatedCostUsd is an estimate, not a confirmed figure. */
  totalCostIsEstimate: true;
  /** Breakdown per job type. */
  byJobType: JobCostSummary[];
  /** Breakdown per provider. */
  byProvider: Record<string, { estimatedCostUsd: number; tokenUsage: number }>;
  /** Total token usage across all completed steps. */
  totalTokenUsage: number;
  /** Number of completed job steps included in this rollup. */
  completedStepCount: number;
  /** Steps that failed and are NOT included in the cost rollup. */
  excludedFailedSteps: number;
  /** Note explaining cost accounting limitations. */
  accountingNote: string;
}

// ── getDocumentCostRollup ─────────────────────────────────────────────────────

export async function getDocumentCostRollup(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<DocumentCostRollup> {
  const { tenantId, knowledgeDocumentVersionId } = params;

  const client = new pg.Client({
    connectionString: resolveDbUrl(),
    ssl: getSupabaseSslConfig(),
  });
  await client.connect();

  try {
    // INV-COST2: Only completed / skipped jobs contribute to cost rollup.
    // Failed, running, queued jobs are counted separately but excluded from totals.
    const result = await client.query<SegmentCostRow>(`
      SELECT
        job_type,
        status,
        estimated_cost_usd,
        token_usage,
        embedding_provider,
        embedding_model,
        started_at,
        completed_at
      FROM knowledge_processing_jobs
      WHERE tenant_id = $1
        AND knowledge_document_version_id = $2
      ORDER BY created_at ASC
    `, [tenantId, knowledgeDocumentVersionId]);

    const allRows = result.rows;
    const completedRows = allRows.filter(
      (r) => r.status === "completed" || r.status === "skipped",
    );
    const failedRows = allRows.filter((r) => r.status === "failed");

    let totalEstimatedCostUsd = 0;
    let totalTokenUsage       = 0;
    const byJobType: JobCostSummary[] = [];
    const byProvider: Record<string, { estimatedCostUsd: number; tokenUsage: number }> = {};

    for (const row of completedRows) {
      const est        = parseFloat(row.estimated_cost_usd ?? "0") || 0;
      const tokens     = row.token_usage ?? 0;
      const durationMs = (row.started_at && row.completed_at)
        ? new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()
        : null;
      const provider   = row.embedding_provider ?? null;
      const model      = row.embedding_model    ?? null;

      totalEstimatedCostUsd += est;
      totalTokenUsage       += tokens;

      byJobType.push({
        jobType:          row.job_type,
        provider,
        model,
        estimatedCostUsd: est,
        tokenUsage:       tokens,
        durationMs,
        costIsEstimate:   true,
      });

      const providerKey = provider ?? "unknown";
      if (!byProvider[providerKey]) {
        byProvider[providerKey] = { estimatedCostUsd: 0, tokenUsage: 0 };
      }
      byProvider[providerKey].estimatedCostUsd += est;
      byProvider[providerKey].tokenUsage       += tokens;
    }

    return {
      totalEstimatedCostUsd: Math.round(totalEstimatedCostUsd * 1e8) / 1e8,
      totalActualCostUsd:    null,
      totalCostIsEstimate:   true,
      byJobType,
      byProvider,
      totalTokenUsage,
      completedStepCount:    completedRows.length,
      excludedFailedSteps:   failedRows.length,
      accountingNote:
        "Cost figures are estimates derived from token usage × pricing defaults. " +
        "Provider-confirmed actual costs are not yet tracked. " +
        "Only completed job steps are included in totals.",
    };

  } finally {
    await client.end();
  }
}

// ── rollupJobCostToDocument ───────────────────────────────────────────────────
// Update the document-level estimated cost field after a job completes.
// Uses a simple SUM — supersession-safe because only completed rows are summed.

export async function rollupJobCostToDocument(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<{ totalEstimatedCostUsd: number; totalTokenUsage: number }> {
  const { tenantId, knowledgeDocumentVersionId } = params;

  const client = new pg.Client({
    connectionString: resolveDbUrl(),
    ssl: getSupabaseSslConfig(),
  });
  await client.connect();

  try {
    const result = await client.query<{ total_cost: string; total_tokens: string }>(`
      SELECT
        COALESCE(SUM(estimated_cost_usd), 0)::text AS total_cost,
        COALESCE(SUM(token_usage), 0)::text        AS total_tokens
      FROM knowledge_processing_jobs
      WHERE tenant_id = $1
        AND knowledge_document_version_id = $2
        AND status IN ('completed', 'skipped')
    `, [tenantId, knowledgeDocumentVersionId]);

    const totalEstimatedCostUsd = parseFloat(result.rows[0]?.total_cost ?? "0");
    const totalTokenUsage       = parseInt(result.rows[0]?.total_tokens ?? "0", 10);

    // Write rollup back to the document version (best-effort — no TX needed here)
    // The knowledge_document_versions table tracks overall processing cost
    // via the resultSummary jsonb on the parent processing job.
    // We log the rollup but do not update a non-existent column.
    // A future migration can add cost columns to knowledge_document_versions.
    console.info(
      `[segment-cost-rollup] version=${knowledgeDocumentVersionId} ` +
      `totalEstimatedCostUsd=${totalEstimatedCostUsd} totalTokenUsage=${totalTokenUsage}`,
    );

    return { totalEstimatedCostUsd, totalTokenUsage };

  } finally {
    await client.end();
  }
}
