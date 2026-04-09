/**
 * asset-search-index-worker.ts — SEARCH-INDEX Phase 6
 *
 * Background indexing worker for knowledge_asset_search.
 * Processes rows with indexing_status='pending' and indexes them by calling
 * indexAssetVersion() from asset-search-indexer.ts.
 *
 * Design:
 *   • Polls DB for pending rows (NOT a push queue — avoids coupling to event bus)
 *   • Processes one batch per interval; honours batchSize limit
 *   • Sets indexing_status='indexing' before processing (prevents double-work)
 *   • On success → indexing_status='indexed', indexed_at=NOW()
 *   • On failure → indexing_status='failed' (retryable via reset-to-pending)
 *   • Retries: failed rows are re-queued after RETRY_BACKOFF_MINUTES
 *
 * Observability:
 *   SEARCH_INDEX_CREATED / SEARCH_INDEX_UPDATED / INDEXING_FAILED per row
 *   Plus batch summary log on each tick.
 *
 * Integration:
 *   Called from server/index.ts startAssetSearchIndexWorker() on boot.
 *   Also triggered on-demand from POST /api/admin/asset-search/index-pending
 *   for operational control.
 */

import pg from "pg";
import { indexAssetVersion } from "../knowledge/asset-search-indexer.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const WORKER_INTERVAL_MS    = 30_000;  // 30 s polling interval
const BATCH_SIZE            = 50;      // rows per tick
const RETRY_BACKOFF_MINUTES = 10;      // re-queue failed rows after N minutes
let   _workerRunning        = false;

// ── processPendingBatch ───────────────────────────────────────────────────────
// Picks up pending rows, fetches their text from knowledge_document_versions,
// and calls indexAssetVersion() for each.
// Returns a summary { processed, indexed, failed }.

export async function processPendingBatch(params: {
  batchSize?: number;
  tenantId?:  string;
} = {}): Promise<{ processed: number; indexed: number; failed: number }> {
  const { batchSize = BATCH_SIZE, tenantId } = params;

  const client = getClient();
  const summary = { processed: 0, indexed: 0, failed: 0 };

  try {
    await client.connect();

    const tenantFilter = tenantId
      ? `AND kas.tenant_id = '${tenantId.replace(/'/g, "''")}'`
      : "";

    // ── 1. Claim a batch: set indexing_status='indexing' atomically ──────────
    const claimed = await client.query<{
      id: string; tenant_id: string; asset_id: string; asset_version_id: string;
      document_type: string | null; asset_scope: string | null; knowledge_base_id: string | null;
      lifecycle_state: string;
    }>(
      `UPDATE public.knowledge_asset_search
          SET indexing_status = 'indexing',
              updated_at      = NOW()
        WHERE id IN (
          SELECT id FROM public.knowledge_asset_search
           WHERE (
             indexing_status = 'pending'
             OR (
               indexing_status = 'failed'
               AND updated_at < NOW() - INTERVAL '${RETRY_BACKOFF_MINUTES} minutes'
             )
           )
           ${tenantFilter}
           AND lifecycle_state = 'active'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, asset_id, asset_version_id,
                  document_type, asset_scope, knowledge_base_id, lifecycle_state`,
      [batchSize],
    );

    if (!claimed.rowCount || claimed.rowCount === 0) return summary;

    summary.processed = claimed.rows.length;
    console.log(`[asset-search-worker] claimed ${summary.processed} rows for indexing`);

    // ── 2. For each claimed row, fetch text and index ─────────────────────────
    for (const row of claimed.rows) {
      try {
        // Fetch extracted_text from knowledge_document_versions
        const textResult = await client.query<{ extracted_text: string; extraction_source: string | null }>(
          `SELECT extracted_text, extraction_source
             FROM knowledge_document_versions
            WHERE id        = $1
              AND tenant_id = $2
              AND extracted_text        IS NOT NULL
              AND extracted_text_status = 'ready'
            LIMIT 1`,
          [row.asset_version_id, row.tenant_id],
        );

        if (!textResult.rowCount || textResult.rowCount === 0) {
          // Version has no ready text — mark failed so we don't loop forever
          await client.query(
            `UPDATE public.knowledge_asset_search
                SET indexing_status = 'failed', updated_at = NOW()
              WHERE id = $1`,
            [row.id],
          );
          console.warn(`[asset-search-worker] INDEXING_FAILED id=${row.id} — no ready text in version`);
          summary.failed++;
          continue;
        }

        const textContent = textResult.rows[0]!.extracted_text;

        const result = await indexAssetVersion({
          tenantId:        row.tenant_id,
          assetId:         row.asset_id,
          assetVersionId:  row.asset_version_id,
          textContent,
          documentType:    row.document_type    ?? undefined,
          assetScope:      row.asset_scope      ?? undefined,
          knowledgeBaseId: row.knowledge_base_id ?? undefined,
          lifecycleState:  row.lifecycle_state,
        });

        if (result.ok) {
          summary.indexed++;
        } else {
          // indexAssetVersion already updated the row on CONFLICT — mark failed
          await client.query(
            `UPDATE public.knowledge_asset_search
                SET indexing_status = 'failed', updated_at = NOW()
              WHERE id = $1`,
            [row.id],
          );
          summary.failed++;
        }
      } catch (rowErr) {
        await client.query(
          `UPDATE public.knowledge_asset_search
              SET indexing_status = 'failed', updated_at = NOW()
            WHERE id = $1`,
          [row.id],
        ).catch(() => {});
        console.error(`[asset-search-worker] INDEXING_FAILED row.id=${row.id}: ${(rowErr as Error).message}`);
        summary.failed++;
      }
    }

    console.log(
      `[asset-search-worker] tick done — processed=${summary.processed}` +
      ` indexed=${summary.indexed} failed=${summary.failed}`,
    );
  } finally {
    await client.end();
  }

  return summary;
}

// ── resetFailedRows ───────────────────────────────────────────────────────────
// Admin utility: re-queue failed rows so the worker retries them.

export async function resetFailedRows(params: {
  tenantId?: string;
  limit?:    number;
} = {}): Promise<{ rowsReset: number }> {
  const { tenantId, limit = 500 } = params;
  const client = getClient();

  try {
    await client.connect();
    const tenantFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

    const result = await client.query(
      `UPDATE public.knowledge_asset_search
          SET indexing_status = 'pending', updated_at = NOW()
        WHERE indexing_status = 'failed'
          AND lifecycle_state = 'active'
          ${tenantFilter}
        LIMIT ${limit}`,
    );

    return { rowsReset: result.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

// ── startAssetSearchIndexWorker ───────────────────────────────────────────────
// Start the background polling worker. Idempotent — second call is a no-op.

export function startAssetSearchIndexWorker(): void {
  if (_workerRunning) return;
  _workerRunning = true;

  const tick = async () => {
    if (!_workerRunning) return;
    try {
      await processPendingBatch({ batchSize: BATCH_SIZE });
    } catch (err) {
      console.error(`[asset-search-worker] unhandled error: ${(err as Error).message}`);
    } finally {
      if (_workerRunning) setTimeout(tick, WORKER_INTERVAL_MS);
    }
  };

  setTimeout(tick, 5_000); // first tick 5 s after boot
  console.log("[asset-search-worker] started — polling every", WORKER_INTERVAL_MS / 1000, "s");
}

export function stopAssetSearchIndexWorker(): void {
  _workerRunning = false;
}
