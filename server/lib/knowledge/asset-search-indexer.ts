/**
 * asset-search-indexer.ts — SEARCH-INDEX Phase 2+6
 *
 * Indexing source of truth: knowledge_document_versions.extracted_text
 * (normalized post-extract-migration — never reads legacy metadata jsonb).
 *
 * Responsibilities:
 *   • indexAssetVersion()       — UPSERT one version into knowledge_asset_search
 *   • removeFromSearchIndex()   — mark rows superseded on archival/purge
 *   • runAssetSearchBackfill()  — resumable batch backfill for historic rows
 *
 * Idempotency invariants:
 *   • Two partial unique indexes prevent duplicate rows
 *     (kas_asset_version_asset_level_uniq / kas_asset_version_chunk_level_uniq)
 *   • All writes are ON CONFLICT DO UPDATE — safe to retry indefinitely
 *   • Timestamp guard: only overwrites if incoming text is different or fresher
 *
 * Lifecycle invariants:
 *   • Archived / purged / deleted assets → indexing_status='superseded', lifecycle_state updated
 *   • Worker sets indexing_status='indexing' then 'indexed' on success, 'failed' on error
 *
 * Observability:
 *   Emits SEARCH_INDEX_CREATED / SEARCH_INDEX_UPDATED / SEARCH_INDEX_DELETED /
 *   INDEXING_FAILED per operation.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexAssetVersionParams {
  tenantId:        string;
  assetId:         string;
  assetVersionId:  string;
  textContent:     string;
  documentType?:   string;
  assetScope?:     string;
  knowledgeBaseId?: string;
  lifecycleState?: string;
  language?:       string;
}

export interface IndexResult {
  ok:     boolean;
  action: "created" | "updated" | "noop" | "error";
  rowId?: string;
  error?: string;
}

export interface BackfillParams {
  batchSize?:  number;
  cursorId?:   string | null;
  dryRun?:     boolean;
  tenantId?:   string;
}

export interface BackfillResult {
  processed:  number;
  indexed:    number;
  skipped:    number;
  errors:     number;
  nextCursor: string | null;
  dryRun:     boolean;
  durationMs: number;
}

// ── indexAssetVersion ─────────────────────────────────────────────────────────
// UPSERT one version row into knowledge_asset_search.
// Precondition: textContent must be non-empty (caller must validate).
// Returns action='noop' if textContent is identical to the existing row.

export async function indexAssetVersion(
  params: IndexAssetVersionParams,
): Promise<IndexResult> {
  const {
    tenantId, assetId, assetVersionId, textContent,
    documentType = null, assetScope = null, knowledgeBaseId = null,
    lifecycleState = "active", language = "english",
  } = params;

  if (!textContent?.trim()) {
    return { ok: false, action: "error", error: "textContent is empty" };
  }

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<{ id: string; xmax: string }>(
      `INSERT INTO public.knowledge_asset_search
         (id, tenant_id, asset_id, asset_version_id, chunk_id,
          document_type, asset_scope, knowledge_base_id,
          lifecycle_state, text_content, language,
          indexing_status, indexed_at, created_at, updated_at)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, NULL,
          $4, $5, $6,
          $7, $8, $9,
          'indexed', NOW(), NOW(), NOW())
       ON CONFLICT ON CONSTRAINT kas_asset_version_asset_level_uniq
       DO UPDATE
         SET text_content    = EXCLUDED.text_content,
             document_type   = COALESCE(EXCLUDED.document_type, knowledge_asset_search.document_type),
             asset_scope     = COALESCE(EXCLUDED.asset_scope,   knowledge_asset_search.asset_scope),
             knowledge_base_id = COALESCE(EXCLUDED.knowledge_base_id, knowledge_asset_search.knowledge_base_id),
             lifecycle_state = EXCLUDED.lifecycle_state,
             language        = EXCLUDED.language,
             indexing_status = 'indexed',
             indexed_at      = NOW(),
             updated_at      = NOW()
         WHERE knowledge_asset_search.text_content IS DISTINCT FROM EXCLUDED.text_content
            OR knowledge_asset_search.lifecycle_state IS DISTINCT FROM EXCLUDED.lifecycle_state
       RETURNING id, xmax::text`,
      [tenantId, assetId, assetVersionId,
       documentType, assetScope, knowledgeBaseId,
       lifecycleState, textContent, language],
    );

    if (!result.rowCount || result.rowCount === 0) {
      // ON CONFLICT WHERE not matched — identical content, noop
      console.log(`[asset-search-indexer] NOOP assetVersionId=${assetVersionId} (content unchanged)`);
      return { ok: true, action: "noop" };
    }

    const row = result.rows[0];
    // xmax=0 → INSERT (new row), xmax>0 → UPDATE
    const action = row.xmax === "0" ? "created" : "updated";

    console.log(
      action === "created"
        ? `[asset-search-indexer] SEARCH_INDEX_CREATED assetId=${assetId} versionId=${assetVersionId} tenant=${tenantId}`
        : `[asset-search-indexer] SEARCH_INDEX_UPDATED assetId=${assetId} versionId=${assetVersionId} tenant=${tenantId}`,
    );

    return { ok: true, action, rowId: row.id };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[asset-search-indexer] INDEXING_FAILED assetVersionId=${assetVersionId}: ${msg}`);
    return { ok: false, action: "error", error: msg };
  } finally {
    await client.end();
  }
}

// ── removeFromSearchIndex ─────────────────────────────────────────────────────
// Called by retention cleanup and archival flow.
// Marks all rows for asset as superseded — does NOT delete (preserves audit trail).
// Workers will stop returning superseded rows in retrieval.

export async function removeFromSearchIndex(params: {
  assetId:   string;
  tenantId:  string;
  reason:    "archived" | "deleted" | "purged";
}): Promise<{ rowsAffected: number }> {
  const { assetId, tenantId, reason } = params;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query(
      `UPDATE public.knowledge_asset_search
          SET indexing_status = 'superseded',
              lifecycle_state = $3,
              updated_at      = NOW()
        WHERE asset_id  = $1
          AND tenant_id = $2
          AND indexing_status != 'superseded'`,
      [assetId, tenantId, reason],
    );

    const rowsAffected = result.rowCount ?? 0;
    if (rowsAffected > 0) {
      console.log(
        `[asset-search-indexer] SEARCH_INDEX_DELETED assetId=${assetId}` +
        ` tenant=${tenantId} reason=${reason} rows=${rowsAffected}`,
      );
    }

    return { rowsAffected };
  } finally {
    await client.end();
  }
}

// ── markStaleForAsset ─────────────────────────────────────────────────────────
// Called when extracted_text is updated (re-extraction) — marks existing rows
// as 'pending' so the background worker picks them up for reindex.

export async function markStaleForAsset(params: {
  assetId:   string;
  tenantId:  string;
}): Promise<{ rowsAffected: number }> {
  const { assetId, tenantId } = params;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query(
      `UPDATE public.knowledge_asset_search
          SET indexing_status = 'pending',
              updated_at      = NOW()
        WHERE asset_id  = $1
          AND tenant_id = $2
          AND indexing_status = 'indexed'`,
      [assetId, tenantId],
    );

    return { rowsAffected: result.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

// ── runAssetSearchBackfill ────────────────────────────────────────────────────
// Resumable, idempotent batch backfill.
// Sources: knowledge_document_versions.extracted_text (normalized).
// Excludes:
//   • rows already indexed (existing kas row with indexing_status='indexed'
//     and lifecycle_state='active')
//   • lifecycle_state != 'active' on knowledge_documents
//   • extracted_text_status != 'ready'
//   • extracted_text IS NULL
//
// Run iteratively:
//   let cursor = null;
//   do {
//     const r = await runAssetSearchBackfill({ cursorId: cursor });
//     cursor = r.nextCursor;
//   } while (cursor);

export async function runAssetSearchBackfill(
  params: BackfillParams = {},
): Promise<BackfillResult> {
  const {
    batchSize  = 500,
    cursorId   = null,
    dryRun     = false,
    tenantId,
  } = params;

  const t0 = Date.now();
  const result: BackfillResult = {
    processed: 0, indexed: 0, skipped: 0, errors: 0,
    nextCursor: null, dryRun, durationMs: 0,
  };

  const client = getClient();
  try {
    await client.connect();

    const tenantFilter = tenantId ? `AND kd.tenant_id = $3` : "";
    const cursorFilter = cursorId ? `AND kdv.id > '${cursorId.replace(/'/g, "''")}'` : "";

    // SELECT candidates: versions with ready extracted_text, active docs,
    //                    not yet in kas (or not yet indexed)
    const candidates = await client.query<Record<string, unknown>>(
      `SELECT
         kdv.id                   AS version_id,
         kdv.knowledge_document_id AS asset_id,
         kdv.tenant_id,
         kdv.extracted_text,
         kdv.extraction_source,
         kd.document_type,
         kd.asset_scope,
         kd.knowledge_base_id,
         kd.lifecycle_state
       FROM knowledge_document_versions kdv
       INNER JOIN knowledge_documents kd
              ON kd.id        = kdv.knowledge_document_id
             AND kd.lifecycle_state = 'active'
       WHERE kdv.extracted_text        IS NOT NULL
         AND kdv.extracted_text_status = 'ready'
         AND kdv.extracted_text        != ''
         ${tenantFilter ? tenantFilter.replace("$3", tenantId ? `'${tenantId.replace(/'/g, "''")}'` : "NULL") : ""}
         ${cursorFilter}
         AND NOT EXISTS (
           SELECT 1 FROM public.knowledge_asset_search kas
            WHERE kas.asset_version_id = kdv.id
              AND kas.chunk_id         IS NULL
              AND kas.indexing_status  = 'indexed'
              AND kas.lifecycle_state  = 'active'
         )
       ORDER BY kdv.id ASC
       LIMIT $${tenantId ? "4" : "3"}`,
      tenantId
        ? [batchSize, batchSize, tenantId, batchSize]
        : [batchSize],
    );

    if (!candidates.rowCount || candidates.rowCount === 0) {
      console.log(`[asset-search-backfill] no candidates tenantId=${tenantId ?? "all"} dryRun=${dryRun}`);
      result.durationMs = Date.now() - t0;
      return result;
    }

    result.processed = candidates.rows.length;
    result.nextCursor = candidates.rows[candidates.rows.length - 1]!["version_id"] as string;

    console.log(
      `[asset-search-backfill] ${result.processed} candidates` +
      ` cursor=${cursorId ?? "START"} dryRun=${dryRun}`,
    );

    for (const row of candidates.rows) {
      try {
        const versionId = row["version_id"] as string;
        const assetId   = row["asset_id"]   as string;
        const text      = row["extracted_text"] as string;
        const tenant    = row["tenant_id"]   as string;

        if (!text?.trim()) {
          result.skipped++;
          continue;
        }

        if (dryRun) {
          console.log(`[asset-search-backfill] DRY_RUN assetVersionId=${versionId} tenant=${tenant} chars=${text.length}`);
          result.indexed++;
          continue;
        }

        const r = await indexAssetVersion({
          tenantId:        tenant,
          assetId,
          assetVersionId:  versionId,
          textContent:     text,
          documentType:    (row["document_type"]   as string) ?? undefined,
          assetScope:      (row["asset_scope"]      as string) ?? undefined,
          knowledgeBaseId: (row["knowledge_base_id"] as string) ?? undefined,
          lifecycleState:  (row["lifecycle_state"]  as string) ?? "active",
        });

        if (r.ok) {
          result.indexed++;
        } else {
          result.errors++;
          console.error(`[asset-search-backfill] ERROR versionId=${versionId}: ${r.error}`);
        }
      } catch (rowErr) {
        result.errors++;
        console.error(`[asset-search-backfill] ROW_ERROR: ${(rowErr as Error).message}`);
      }
    }

    console.log(
      `[asset-search-backfill] done processed=${result.processed}` +
      ` indexed=${result.indexed} skipped=${result.skipped}` +
      ` errors=${result.errors} nextCursor=${result.nextCursor}`,
    );
  } finally {
    result.durationMs = Date.now() - t0;
    await client.end();
  }

  return result;
}
