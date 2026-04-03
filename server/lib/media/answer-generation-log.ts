/**
 * answer-generation-log.ts — Append-only log of AI answer generations.
 *
 * PHASE 5Z.6 — Every AI answer generated is logged to chat_answer_generations.
 * Enables:
 *   - Full replay capability (reconstruct any answer from its gen key)
 *   - Audit trail (who answered what, with what context, at what coverage)
 *   - Determinism verification (same key → same stored answer)
 *
 * Rules:
 *   - NEVER UPDATE existing rows — always INSERT a new row
 *   - Rows are tenant-scoped (tenantId on every row)
 *   - Replay returns the LATEST row for a given (tenantId, queryHash, refinementGenKey)
 *   - All DB errors are caught and swallowed — callers get graceful degradation
 */

import { Client as PgClient } from "pg";
import { resolveDbUrl }        from "../jobs/job-queue.ts";
import { getSupabaseSslConfig } from "../jobs/ssl-config.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnswerGenerationRecord {
  id:               string;
  tenantId:         string;
  queryHash:        string;
  refinementGenKey: string;
  answer:           string;
  completeness:     string;
  coveragePct:      number | null;
  createdAt:        Date;
}

export interface AppendAnswerOptions {
  tenantId:         string;
  queryHash:        string;
  refinementGenKey: string;
  answer:           string;
  completeness:     "partial" | "complete";
  coveragePct?:     number;
}

export interface ReplayResult {
  found:            boolean;
  answer:           string | null;
  completeness:     string | null;
  coveragePct:      number | null;
  refinementGenKey: string | null;
  createdAt:        Date | null;
}

// ── Append ────────────────────────────────────────────────────────────────────

/**
 * Append a new answer generation record.
 * Fully non-critical: connection errors and query errors are both swallowed.
 */
export async function appendAnswerGeneration(opts: AppendAnswerOptions): Promise<string | null> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  try {
    await client.connect();
    const res = await client.query<{ id: string }>(
      `INSERT INTO chat_answer_generations
         (tenant_id, query_hash, refinement_gen_key, answer, completeness, coverage_pct)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        opts.tenantId,
        opts.queryHash,
        opts.refinementGenKey,
        opts.answer.slice(0, 200_000),
        opts.completeness,
        opts.coveragePct ?? null,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("does not exist") && !msg.includes("relation") && !msg.includes("ENOTFOUND") && !msg.includes("ECONNREFUSED")) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), svc: "answer-gen-log",
        event: "append_warn", error: msg,
      }));
    }
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Reconstruct an answer from the append-only log.
 *
 * Returns the LATEST stored answer for (tenantId, queryHash, refinementGenKey).
 * Returns found=false on any error or miss — safe to call without error handling.
 */
export async function replayAnswerGeneration(
  tenantId:         string,
  queryHash:        string,
  refinementGenKey: string,
): Promise<ReplayResult> {
  const NOT_FOUND: ReplayResult = {
    found: false, answer: null, completeness: null,
    coveragePct: null, refinementGenKey: null, createdAt: null,
  };

  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  try {
    await client.connect();
    const res = await client.query<{
      answer: string;
      completeness: string;
      coverage_pct: string | null;
      refinement_gen_key: string;
      created_at: Date;
    }>(
      `SELECT answer, completeness, coverage_pct, refinement_gen_key, created_at
       FROM chat_answer_generations
       WHERE tenant_id          = $1
         AND query_hash         = $2
         AND refinement_gen_key = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, queryHash, refinementGenKey],
    );

    if (res.rows.length === 0) return NOT_FOUND;

    const row = res.rows[0];
    return {
      found:            true,
      answer:           row.answer,
      completeness:     row.completeness,
      coveragePct:      row.coverage_pct !== null ? parseFloat(row.coverage_pct) : null,
      refinementGenKey: row.refinement_gen_key,
      createdAt:        row.created_at,
    };
  } catch {
    return NOT_FOUND;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * List all answer generations for a query (audit/debugging).
 * Returns rows ordered newest-first. Returns [] on any error.
 */
export async function listAnswerGenerations(
  tenantId:  string,
  queryHash: string,
  limit = 10,
): Promise<AnswerGenerationRecord[]> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  try {
    await client.connect();
    const res = await client.query<{
      id: string;
      tenant_id: string;
      query_hash: string;
      refinement_gen_key: string;
      answer: string;
      completeness: string;
      coverage_pct: string | null;
      created_at: Date;
    }>(
      `SELECT id, tenant_id, query_hash, refinement_gen_key, answer, completeness, coverage_pct, created_at
       FROM chat_answer_generations
       WHERE tenant_id  = $1
         AND query_hash = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [tenantId, queryHash, limit],
    );

    return res.rows.map(r => ({
      id:               r.id,
      tenantId:         r.tenant_id,
      queryHash:        r.query_hash,
      refinementGenKey: r.refinement_gen_key,
      answer:           r.answer,
      completeness:     r.completeness,
      coveragePct:      r.coverage_pct !== null ? parseFloat(r.coverage_pct) : null,
      createdAt:        r.created_at,
    }));
  } catch {
    return [];
  } finally {
    await client.end().catch(() => {});
  }
}
