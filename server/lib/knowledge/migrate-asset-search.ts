/**
 * migrate-asset-search.ts — SEARCH-INDEX Phase 1
 *
 * Idempotent migration that creates the knowledge_asset_search table and all
 * required indexes. Safe to re-run on every boot.
 *
 * Design decisions:
 *   • Asset-version-level indexing (one row per knowledge_document_version).
 *   • chunk_id is nullable — reserved for future chunk-level fan-out.
 *   • search_tsvector is a GENERATED ALWAYS AS STORED column so it auto-updates
 *     whenever text_content is written via UPSERT (zero maintenance overhead).
 *   • GIN index on search_tsvector for O(log N) full-text search.
 *   • UNIQUE (asset_version_id, COALESCE(chunk_id,'')) — idempotent upserts.
 *   • Two composite indexes support lifecycle-aware retrieval at scale.
 *
 * Table: knowledge_asset_search
 * Fields: id, tenant_id, asset_id, asset_version_id, chunk_id,
 *         document_type, asset_scope, knowledge_base_id,
 *         lifecycle_state, text_content, char_count, search_tsvector,
 *         language, indexing_status, indexed_at, created_at, updated_at
 *
 * Called from server/index.ts on boot (fire-and-forget, non-fatal).
 */

import pg from "pg";

let _migrationDone = false;

export async function runAssetSearchMigration(): Promise<void> {
  if (_migrationDone) return;

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    // ── 1. Ensure pg_trgm extension for similarity fallback ─────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    console.log("[asset-search-migration] pg_trgm: OK");

    // ── 2. Create knowledge_asset_search table ───────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.knowledge_asset_search (
        id                text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id         text        NOT NULL,
        asset_id          text        NOT NULL,
        asset_version_id  text        NOT NULL,
        chunk_id          text        DEFAULT NULL,
        document_type     text,
        asset_scope       text,
        knowledge_base_id text,
        lifecycle_state   text        NOT NULL DEFAULT 'active',
        text_content      text        NOT NULL,
        char_count        integer     GENERATED ALWAYS AS (char_length(text_content)) STORED,
        search_tsvector   tsvector    GENERATED ALWAYS AS (
                            to_tsvector('english', text_content)
                          ) STORED,
        language          text        DEFAULT 'english',
        indexing_status   text        NOT NULL DEFAULT 'pending'
                          CHECK (indexing_status IN ('pending','indexing','indexed','failed','superseded')),
        indexed_at        timestamp,
        created_at        timestamp   NOT NULL DEFAULT now(),
        updated_at        timestamp   NOT NULL DEFAULT now(),

        CONSTRAINT kas_lifecycle_check
          CHECK (lifecycle_state IN ('active','archived','deleted','purged'))
      )
    `);
    console.log("[asset-search-migration] table knowledge_asset_search: OK");

    // ── 3. Idempotent-upsert uniqueness: two partial indexes because Postgres
    //    treats NULL != NULL in plain UNIQUE constraints.
    //    asset-level rows (chunk_id IS NULL): one row per asset_version_id
    //    chunk-level rows (chunk_id IS NOT NULL): one row per version+chunk pair
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS kas_asset_version_asset_level_uniq
      ON public.knowledge_asset_search (asset_version_id)
      WHERE chunk_id IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS kas_asset_version_chunk_level_uniq
      ON public.knowledge_asset_search (asset_version_id, chunk_id)
      WHERE chunk_id IS NOT NULL
    `);
    console.log("[asset-search-migration] uniqueness indexes: OK");

    // ── 4. GIN index on generated tsvector (lexical full-text) ───────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS kas_search_tsvector_gin_idx
      ON public.knowledge_asset_search
      USING GIN (search_tsvector)
    `);
    console.log("[asset-search-migration] GIN tsvector index: OK");

    // ── 4. Tenant + lifecycle composite (primary retrieval filter gate) ───────
    await client.query(`
      CREATE INDEX IF NOT EXISTS kas_tenant_lifecycle_status_idx
      ON public.knowledge_asset_search (tenant_id, lifecycle_state, indexing_status)
    `);
    console.log("[asset-search-migration] tenant+lifecycle+status index: OK");

    // ── 5. Tenant + KB filter (knowledge-base-scoped search) ─────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS kas_tenant_kb_idx
      ON public.knowledge_asset_search (tenant_id, knowledge_base_id)
      WHERE knowledge_base_id IS NOT NULL
    `);
    console.log("[asset-search-migration] tenant+kb index: OK");

    // ── 6. Asset + version lookup (for reindex, cleanup, provenance) ─────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS kas_asset_version_idx
      ON public.knowledge_asset_search (asset_id, asset_version_id)
    `);
    console.log("[asset-search-migration] asset+version index: OK");

    // ── 7. Indexing queue index (worker polling) ──────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS kas_tenant_indexing_status_created_idx
      ON public.knowledge_asset_search (tenant_id, indexing_status, created_at)
    `);
    console.log("[asset-search-migration] indexing queue index: OK");

    _migrationDone = true;
    console.log("[asset-search-migration] complete");
  } catch (err) {
    console.error("[asset-search-migration] FAILED:", (err as Error).message);
  } finally {
    await client.end();
  }
}
