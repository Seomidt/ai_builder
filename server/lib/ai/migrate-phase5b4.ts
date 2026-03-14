/**
 * Phase 5B.4 — Email / HTML / Imported Content Ingestion
 * Raw SQL migration — adds columns/constraints/indexes for import parse/chunk pipeline.
 *
 * Run: npx tsx server/lib/ai/migrate-phase5b4.ts
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Phase 5B.4 migration: starting…");

  // ─── knowledge_document_versions: 12 import columns ───────────────────────
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      ADD COLUMN IF NOT EXISTS import_content_type text,
      ADD COLUMN IF NOT EXISTS import_parse_status text,
      ADD COLUMN IF NOT EXISTS import_parse_started_at timestamp,
      ADD COLUMN IF NOT EXISTS import_parse_completed_at timestamp,
      ADD COLUMN IF NOT EXISTS import_parser_name text,
      ADD COLUMN IF NOT EXISTS import_parser_version text,
      ADD COLUMN IF NOT EXISTS import_text_checksum text,
      ADD COLUMN IF NOT EXISTS import_message_count integer,
      ADD COLUMN IF NOT EXISTS import_section_count integer,
      ADD COLUMN IF NOT EXISTS import_link_count integer,
      ADD COLUMN IF NOT EXISTS import_failure_reason text,
      ADD COLUMN IF NOT EXISTS source_language_code text
  `);
  console.log("  kdv: 12 import columns added");

  // ─── knowledge_document_versions: CHECK constraints ────────────────────────
  for (const [name, sql_] of [
    ["kdv_import_content_type_check", `import_content_type IS NULL OR import_content_type IN ('email','html','imported_text')`],
    ["kdv_import_parse_status_check", `import_parse_status IS NULL OR import_parse_status IN ('pending','running','completed','failed')`],
    ["kdv_import_message_count_check", `import_message_count IS NULL OR import_message_count >= 0`],
    ["kdv_import_section_count_check", `import_section_count IS NULL OR import_section_count >= 0`],
    ["kdv_import_link_count_check",    `import_link_count IS NULL OR import_link_count >= 0`],
  ] as const) {
    await db.execute(sql.raw(`
      DO $$ BEGIN
        ALTER TABLE knowledge_document_versions ADD CONSTRAINT ${name} CHECK (${sql_});
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `));
  }
  console.log("  kdv: 5 CHECK constraints added");

  // ─── knowledge_document_versions: import parse index ──────────────────────
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS kdv_tenant_import_parse_status_idx
      ON knowledge_document_versions (tenant_id, import_parse_status, created_at)
  `);
  console.log("  kdv: import parse status index added");

  // ─── knowledge_chunks: 11 import chunk columns ─────────────────────────────
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN IF NOT EXISTS email_chunk boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS html_chunk boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS import_chunk_strategy text,
      ADD COLUMN IF NOT EXISTS import_chunk_version text,
      ADD COLUMN IF NOT EXISTS message_index integer,
      ADD COLUMN IF NOT EXISTS thread_position integer,
      ADD COLUMN IF NOT EXISTS section_label text,
      ADD COLUMN IF NOT EXISTS source_url text,
      ADD COLUMN IF NOT EXISTS sender_label text,
      ADD COLUMN IF NOT EXISTS sent_at timestamp,
      ADD COLUMN IF NOT EXISTS quoted_content_included boolean
  `);
  console.log("  kc: 11 import chunk columns added");

  // ─── knowledge_chunks: CHECK constraints ─────────────────────────────────
  for (const [name, sql_] of [
    ["kc_message_index_check",   `message_index IS NULL OR message_index >= 0`],
    ["kc_thread_position_check", `thread_position IS NULL OR thread_position >= 0`],
  ] as const) {
    await db.execute(sql.raw(`
      DO $$ BEGIN
        ALTER TABLE knowledge_chunks ADD CONSTRAINT ${name} CHECK (${sql_});
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `));
  }
  console.log("  kc: 2 CHECK constraints added");

  // ─── knowledge_chunks: indexes ────────────────────────────────────────────
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_kchk_email_chunk
      ON knowledge_chunks (tenant_id, knowledge_document_version_id, email_chunk, chunk_active)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_kchk_html_chunk
      ON knowledge_chunks (tenant_id, knowledge_document_version_id, html_chunk, chunk_active)
  `);
  console.log("  kc: email_chunk + html_chunk indexes added");

  // ─── knowledge_processing_jobs: 2 import processor columns ───────────────
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD COLUMN IF NOT EXISTS import_processor_name text,
      ADD COLUMN IF NOT EXISTS import_processor_version text
  `);
  console.log("  kpj: 2 import processor columns added");

  // ─── knowledge_processing_jobs: drop + recreate job_type CHECK ────────────
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs DROP CONSTRAINT IF EXISTS kpj_job_type_check
  `);
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs ADD CONSTRAINT kpj_job_type_check
      CHECK (job_type IN (
        'upload_verify','parse','chunk','embed','index','reindex','delete_index',
        'lifecycle_sync','extract_text','structured_parse','structured_chunk',
        'ocr_parse','ocr_chunk','transcript_parse','transcript_chunk',
        'import_parse','import_chunk'
      ))
  `);
  console.log("  kpj: job_type CHECK updated with import_parse + import_chunk");

  console.log("Phase 5B.4 migration: COMPLETE");
}

main().catch((err) => {
  console.error("Phase 5B.4 migration failed:", err);
  process.exit(1);
});
