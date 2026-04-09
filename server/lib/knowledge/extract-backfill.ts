/**
 * extract-backfill.ts — EXTRACT-MIGRATION Phase 3
 *
 * Resumable, idempotent backfill job that migrates extracted text from
 * knowledge_documents.metadata jsonb → knowledge_document_versions rows.
 *
 * Design:
 *   - Reads knowledge_documents WHERE metadata->>'extractedText' IS NOT NULL
 *   - Writes (upserts) knowledge_document_versions rows with extracted_text
 *   - Uses cursor (last processed id DESC) for resumability
 *   - Skips rows that already have a fresh normalized version row
 *   - Safe under concurrent production traffic (no locks held during batch)
 *   - Idempotent: ON CONFLICT DO UPDATE with timestamp guard
 *
 * Feature flags:
 *   EXTRACT_DUAL_WRITE=false  — disables live dual-write (not the backfill)
 *   Backfill is always safe regardless of EXTRACT_DUAL_WRITE
 *
 * Invoked via:
 *   POST /api/admin/extract-backfill
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface BackfillParams {
  /** Max rows to process in this run. Default: 500 */
  batchSize?: number;
  /** Cursor: process only rows with id < cursorId (for pagination) */
  cursorId?: string | null;
  /** Dry-run: reads + logs, does not write to version table */
  dryRun?: boolean;
  /** Tenant scope — if set, only backfills that tenant */
  tenantId?: string;
}

export interface BackfillResult {
  processed:  number;
  inserted:   number;
  skipped:    number;
  errors:     number;
  nextCursor: string | null;
  dryRun:     boolean;
  durationMs: number;
}

interface BackfillRow {
  id:               string;
  tenant_id:        string;
  metadata:         Record<string, unknown> | null;
}

/**
 * Run one backfill batch.
 * Returns a result object; call repeatedly with nextCursor until nextCursor is null.
 */
export async function runExtractBackfillBatch(params: BackfillParams = {}): Promise<BackfillResult> {
  const {
    batchSize  = 500,
    cursorId   = null,
    dryRun     = false,
    tenantId,
  } = params;

  const t0     = Date.now();
  const result: BackfillResult = { processed: 0, inserted: 0, skipped: 0, errors: 0, nextCursor: null, dryRun, durationMs: 0 };

  const client = getClient();
  try {
    await client.connect();

    // ── Step 1: fetch batch of knowledge_documents with jsonb extracted text ──
    // Candidates: metadata->>'extractedText' IS NOT NULL
    // Skip: already have a knowledge_document_versions row with extracted_text IS NOT NULL
    //        AND extracted_at >= metadata->>'extractedAt' cast (fresher or equal)
    const whereParts: string[] = [`kd.metadata->>'extractedText' IS NOT NULL`];
    const qParams: unknown[]   = [batchSize];

    if (cursorId) {
      qParams.push(cursorId);
      whereParts.push(`kd.id < $${qParams.length}`);
    }
    if (tenantId) {
      qParams.push(tenantId);
      whereParts.push(`kd.tenant_id = $${qParams.length}`);
    }

    const rows = await client.query<BackfillRow>(
      `SELECT kd.id, kd.tenant_id, kd.metadata
       FROM   knowledge_documents kd
       WHERE  ${whereParts.join(" AND ")}
         AND  kd.lifecycle_state = 'active'
         AND  NOT EXISTS (
           SELECT 1 FROM knowledge_document_versions v
           WHERE  v.knowledge_document_id = kd.id
             AND  v.version_number = 1
             AND  v.extracted_text IS NOT NULL
             AND (
               v.extracted_at IS NULL
               OR v.extracted_at >= (kd.metadata->>'extractedAt')::timestamptz
             )
         )
       ORDER  BY kd.id DESC
       LIMIT  $1`,
      qParams,
    );

    const candidates = rows.rows;
    result.processed = candidates.length;

    if (candidates.length === 0) {
      console.log(`[extract-backfill] batch complete — no more candidates tenantId=${tenantId ?? "all"} dryRun=${dryRun}`);
      result.durationMs = Date.now() - t0;
      return result;
    }

    result.nextCursor = candidates[candidates.length - 1].id;

    console.log(`[extract-backfill] processing ${candidates.length} candidates cursorId=${cursorId ?? "START"} dryRun=${dryRun}`);

    // ── Step 2: upsert version rows for each candidate ─────────────────────
    for (const row of candidates) {
      try {
        const meta             = row.metadata;
        const extractedText    = (meta?.["extractedText"]       as string)              ?? null;
        const extractedStatus  = (meta?.["extractedTextStatus"] as "ready" | "failed")  ?? null;
        const extractedAtStr   = (meta?.["extractedAt"]         as string)              ?? null;
        const charCount        = (meta?.["charCount"]           as number)              ?? (extractedText?.length ?? 0);
        const extractionSource = (meta?.["extractionSource"]    as string)              ?? "backfill";

        if (!extractedText || !extractedStatus) {
          result.skipped++;
          console.log(`[extract-backfill] SKIP id=${row.id} — missing extractedText or status in metadata`);
          continue;
        }

        const versionStatus = extractedStatus === "ready" ? "indexed" : "failed";

        if (dryRun) {
          console.log(
            `[extract-backfill] DRY_RUN WOULD_INSERT id=${row.id} tenant=${row.tenant_id}` +
            ` status=${extractedStatus} source=${extractionSource} chars=${charCount}`,
          );
          result.inserted++;
          continue;
        }

        // Idempotent upsert: only update if incoming data is fresher or version row has no extracted_at
        await client.query(
          `INSERT INTO knowledge_document_versions
             (id, tenant_id, knowledge_document_id, version_number,
              is_current, version_status, character_count,
              extracted_text, extracted_text_status, extracted_at, extraction_source,
              processing_completed_at, created_by)
           VALUES
             (gen_random_uuid(), $1, $2, 1,
              TRUE, $3, $4,
              $5, $6, $7::timestamptz, $8,
              CASE WHEN $6 = 'ready' THEN $7::timestamptz ELSE NULL END,
              'system:extract-backfill')
           ON CONFLICT (knowledge_document_id, version_number) DO UPDATE
             SET extracted_text        = EXCLUDED.extracted_text,
                 extracted_text_status = EXCLUDED.extracted_text_status,
                 extracted_at          = EXCLUDED.extracted_at,
                 extraction_source     = EXCLUDED.extraction_source,
                 character_count       = COALESCE(EXCLUDED.character_count, knowledge_document_versions.character_count),
                 version_status        = EXCLUDED.version_status,
                 processing_completed_at = COALESCE(EXCLUDED.processing_completed_at, knowledge_document_versions.processing_completed_at)
             WHERE knowledge_document_versions.extracted_at IS NULL
                OR EXCLUDED.extracted_at > knowledge_document_versions.extracted_at`,
          [
            row.tenant_id,
            row.id,
            versionStatus,
            charCount,
            extractedText,
            extractedStatus,
            extractedAtStr ?? new Date().toISOString(),
            extractionSource,
          ],
        );

        result.inserted++;
        console.log(`[extract-backfill] UPSERTED id=${row.id} tenant=${row.tenant_id} status=${extractedStatus} chars=${charCount}`);

      } catch (rowErr) {
        result.errors++;
        console.error(`[extract-backfill] ERROR id=${row.id}: ${(rowErr as Error).message}`);
      }
    }

    result.durationMs = Date.now() - t0;
    console.log(
      `[extract-backfill] batch done processed=${result.processed} inserted=${result.inserted}` +
      ` skipped=${result.skipped} errors=${result.errors} nextCursor=${result.nextCursor} durationMs=${result.durationMs}`,
    );
    return result;

  } finally {
    await client.end();
  }
}
