/**
 * Phase 10 Migration — Knowledge Ingestion Platform
 * 5 new tables:
 *   knowledge_sources, ingestion_documents, ingestion_chunks,
 *   ingestion_embeddings, knowledge_index_entries
 * Idempotent — safe to re-run.
 * Does NOT alter any existing Phase 5 knowledge tables.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  const TABLES = ["knowledge_sources","ingestion_documents","ingestion_chunks","ingestion_embeddings","knowledge_index_entries"];

  try {
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [TABLES],
    );
    console.log(`\nExisting Phase 10 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // ── 1. knowledge_sources ──────────────────────────────────────────────────
    console.log("\n── Creating knowledge_sources...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.knowledge_sources (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id    text NOT NULL,
        source_type  text NOT NULL
                     CHECK (source_type IN ('file_upload','web_crawl','api_ingestion','manual')),
        name         text NOT NULL,
        status       text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('pending','active','syncing','error','disabled')),
        last_sync_at timestamp,
        metadata     jsonb,
        created_at   timestamp NOT NULL DEFAULT now(),
        updated_at   timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_sources_tenant_id_idx ON public.knowledge_sources (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_sources_status_idx ON public.knowledge_sources (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_sources_tenant_status_created_idx ON public.knowledge_sources (tenant_id, status, created_at)`);
    console.log("  ✔ knowledge_sources — table + 3 indexes");

    const ksV = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_sources' ORDER BY column_name`);
    console.log(`  ✔ columns (${ksV.rows.length}): ${ksV.rows.map((r) => r.column_name).join(", ")}`);

    const ksCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.knowledge_sources'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${ksCk.rows.length}): ${ksCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 2. ingestion_documents ────────────────────────────────────────────────
    console.log("\n── Creating ingestion_documents...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ingestion_documents (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL,
        source_id       text NOT NULL,
        title           text NOT NULL,
        document_status text NOT NULL DEFAULT 'pending'
                        CHECK (document_status IN ('pending','processing','chunked','embedded','indexed','failed','archived')),
        checksum        text,
        content_type    text,
        metadata        jsonb,
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_documents_tenant_id_idx ON public.ingestion_documents (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_documents_source_id_idx ON public.ingestion_documents (source_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_documents_status_idx ON public.ingestion_documents (document_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_documents_tenant_source_created_idx ON public.ingestion_documents (tenant_id, source_id, created_at)`);
    console.log("  ✔ ingestion_documents — table + 4 indexes");

    const idCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ingestion_documents'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${idCk.rows.length}): ${idCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 3. ingestion_chunks ───────────────────────────────────────────────────
    console.log("\n── Creating ingestion_chunks...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ingestion_chunks (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL,
        document_id      text NOT NULL,
        chunk_index      integer NOT NULL,
        content          text NOT NULL,
        token_count      integer,
        embedding_status text NOT NULL DEFAULT 'pending'
                         CHECK (embedding_status IN ('pending','generating','completed','failed')),
        metadata         jsonb,
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_chunks_tenant_id_idx ON public.ingestion_chunks (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_chunks_document_id_idx ON public.ingestion_chunks (document_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_chunks_tenant_doc_idx_idx ON public.ingestion_chunks (tenant_id, document_id, chunk_index)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_chunks_embedding_status_idx ON public.ingestion_chunks (embedding_status)`);
    console.log("  ✔ ingestion_chunks — table + 4 indexes");

    const icCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ingestion_chunks'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${icCk.rows.length}): ${icCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 4. ingestion_embeddings ───────────────────────────────────────────────
    console.log("\n── Creating ingestion_embeddings...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ingestion_embeddings (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL,
        chunk_id         text NOT NULL,
        embedding_model  text NOT NULL,
        embedding_status text NOT NULL DEFAULT 'pending'
                         CHECK (embedding_status IN ('pending','generating','completed','failed')),
        dimensions       integer,
        vector_reference text,
        error_message    text,
        metadata         jsonb,
        created_at       timestamp NOT NULL DEFAULT now(),
        updated_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_embeddings_tenant_id_idx ON public.ingestion_embeddings (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_embeddings_chunk_id_idx ON public.ingestion_embeddings (chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ingestion_embeddings_status_created_idx ON public.ingestion_embeddings (embedding_status, created_at)`);
    console.log("  ✔ ingestion_embeddings — table + 3 indexes");

    const ieCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ingestion_embeddings'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${ieCk.rows.length}): ${ieCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 5. knowledge_index_entries ────────────────────────────────────────────
    console.log("\n── Creating knowledge_index_entries...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.knowledge_index_entries (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL,
        chunk_id        text NOT NULL,
        document_id     text NOT NULL,
        source_id       text NOT NULL,
        vector_indexed  boolean NOT NULL DEFAULT false,
        lexical_indexed boolean NOT NULL DEFAULT false,
        indexed_at      timestamp,
        metadata        jsonb,
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_index_entries_chunk_id_unique ON public.knowledge_index_entries (chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_index_entries_tenant_id_idx ON public.knowledge_index_entries (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_index_entries_chunk_id_idx ON public.knowledge_index_entries (chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_index_entries_document_id_idx ON public.knowledge_index_entries (document_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_index_entries_source_id_idx ON public.knowledge_index_entries (source_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS knowledge_index_entries_tenant_indexed_idx ON public.knowledge_index_entries (tenant_id, vector_indexed, lexical_indexed)`);
    console.log("  ✔ knowledge_index_entries — table + 6 indexes (1 unique)");

    // ── 6. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    for (const t of TABLES) {
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    console.log(`  ✔ RLS enabled on all 5 Phase 10 tables`);

    // Tenant isolation policies
    const RLS_MAP: Record<string, string> = {
      knowledge_sources: "tenant_id",
      ingestion_documents: "tenant_id",
      ingestion_chunks: "tenant_id",
      ingestion_embeddings: "tenant_id",
      knowledge_index_entries: "tenant_id",
    };

    for (const [table, col] of Object.entries(RLS_MAP)) {
      const pName = `${table.replace(/_/g, "")}_tenant_isolation`;
      const exists = await client.query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = $2`, [table, pName]);
      if (exists.rows.length === 0) {
        await client.query(`
          CREATE POLICY "${pName}" ON public.${table}
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND ${col}::text = current_setting('app.current_tenant_id', true)
          )
        `);
        console.log(`  ✔ ${table} RLS policy created`);
      } else {
        console.log(`  ✔ ${table} RLS policy already exists`);
      }
    }

    // ── 7. Verification ───────────────────────────────────────────────────────
    console.log("\n── Verification...");

    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [TABLES],
    );
    console.log(`✔ Tables verified (${tableR.rows.length}/5): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [TABLES],
    );
    console.log(`✔ RLS verified (${rlsR.rows.length}/5): ${rlsR.rows.map((r) => r.tablename).join(", ")}`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY indexname`,
      [TABLES],
    );
    console.log(`✔ Phase 10 indexes (${idxR.rows.length}): ${idxR.rows.map((r) => r.indexname).join(", ")}`);

    // Round-trip test
    const tid = `migrate-test-p10-${Date.now()}`;
    const srcRow = await client.query(
      `INSERT INTO public.knowledge_sources (tenant_id, source_type, name) VALUES ($1, 'file_upload', 'Test Source') RETURNING id`,
      [tid],
    );
    const srcId = srcRow.rows[0].id;
    const docRow = await client.query(
      `INSERT INTO public.ingestion_documents (tenant_id, source_id, title) VALUES ($1, $2, 'Test Doc') RETURNING id`,
      [tid, srcId],
    );
    const docId = docRow.rows[0].id;
    const chkRow = await client.query(
      `INSERT INTO public.ingestion_chunks (tenant_id, document_id, chunk_index, content) VALUES ($1, $2, 0, 'test chunk') RETURNING id`,
      [tid, docId],
    );
    const chkId = chkRow.rows[0].id;
    const embRow = await client.query(
      `INSERT INTO public.ingestion_embeddings (tenant_id, chunk_id, embedding_model) VALUES ($1, $2, 'text-embedding-3-small') RETURNING id`,
      [tid, chkId],
    );
    const idxRow = await client.query(
      `INSERT INTO public.knowledge_index_entries (tenant_id, chunk_id, document_id, source_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tid, chkId, docId, srcId],
    );
    console.log(`✔ Round-trip: src=${srcId.slice(0,8)}… doc=${docId.slice(0,8)}… chunk=${chkId.slice(0,8)}… emb=${embRow.rows[0].id.slice(0,8)}… idx=${idxRow.rows[0].id.slice(0,8)}…`);

    // Cleanup test rows
    await client.query(`DELETE FROM public.knowledge_index_entries WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.ingestion_embeddings WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.ingestion_chunks WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.ingestion_documents WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.knowledge_sources WHERE tenant_id = $1`, [tid]);
    console.log("✔ Test rows cleaned up");

    // Verify existing Phase 5 knowledge tables untouched
    const p5Tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('knowledge_bases','knowledge_documents','knowledge_chunks','knowledge_embeddings') ORDER BY table_name`,
    );
    console.log(`✔ Phase 5 tables intact (${p5Tables.rows.length}): ${p5Tables.rows.map((r) => r.table_name).join(", ")}`);

    console.log("\n✔ Phase 10 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
