/**
 * Phase 5B.1 DB migration — run once
 * npx tsx server/lib/ai/migrate-phase5b1.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

async function run() {
  console.log("Running Phase 5B.1 migration...");

  // 1. Add structured parse metadata columns to knowledge_document_versions
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      ADD COLUMN IF NOT EXISTS structured_parse_status text,
      ADD COLUMN IF NOT EXISTS structured_parse_job_id text,
      ADD COLUMN IF NOT EXISTS structured_parse_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS structured_parse_completed_at timestamptz,
      ADD COLUMN IF NOT EXISTS structured_parse_failed_at timestamptz,
      ADD COLUMN IF NOT EXISTS structured_parse_error text,
      ADD COLUMN IF NOT EXISTS sheet_count integer,
      ADD COLUMN IF NOT EXISTS row_count integer,
      ADD COLUMN IF NOT EXISTS column_count integer,
      ADD COLUMN IF NOT EXISTS raw_structured_content text,
      ADD COLUMN IF NOT EXISTS structured_content_checksum text,
      ADD COLUMN IF NOT EXISTS structured_parse_options jsonb
  `);
  console.log("✓ knowledge_document_versions: 12 structured columns added");

  // 2. Add CHECK constraints on knowledge_document_versions
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      DROP CONSTRAINT IF EXISTS kdv_struct_parse_status_check,
      DROP CONSTRAINT IF EXISTS kdv_struct_sheet_count_check,
      DROP CONSTRAINT IF EXISTS kdv_struct_row_count_check,
      DROP CONSTRAINT IF EXISTS kdv_struct_col_count_check
  `);
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      ADD CONSTRAINT kdv_struct_parse_status_check
        CHECK (structured_parse_status IS NULL OR structured_parse_status IN ('pending','running','completed','failed')),
      ADD CONSTRAINT kdv_struct_sheet_count_check
        CHECK (sheet_count IS NULL OR sheet_count >= 0),
      ADD CONSTRAINT kdv_struct_row_count_check
        CHECK (row_count IS NULL OR row_count >= 0),
      ADD CONSTRAINT kdv_struct_col_count_check
        CHECK (column_count IS NULL OR column_count >= 0)
  `);
  console.log("✓ knowledge_document_versions: 4 CHECK constraints added");

  // 3. Add index on structured_parse_status
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS kdv_tenant_struct_parse_status_idx
      ON knowledge_document_versions (tenant_id, structured_parse_status, created_at)
  `);
  console.log("✓ knowledge_document_versions: structured_parse_status index added");

  // 4. Add structured processor columns to knowledge_processing_jobs
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD COLUMN IF NOT EXISTS structured_processor_name text,
      ADD COLUMN IF NOT EXISTS structured_processor_version text
  `);
  console.log("✓ knowledge_processing_jobs: 2 structured columns added");

  // 5. Update job_type CHECK constraint to include structured_parse + structured_chunk
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs DROP CONSTRAINT IF EXISTS kpj_job_type_check`);
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD CONSTRAINT kpj_job_type_check
        CHECK (job_type IN ('upload_verify','parse','chunk','embed','index','reindex','delete_index','lifecycle_sync','extract_text','structured_parse','structured_chunk'))
  `);
  console.log("✓ knowledge_processing_jobs: job_type CHECK updated");

  // 6. Add table chunk columns to knowledge_chunks
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN IF NOT EXISTS table_chunk boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS sheet_name text,
      ADD COLUMN IF NOT EXISTS row_start integer,
      ADD COLUMN IF NOT EXISTS row_end integer,
      ADD COLUMN IF NOT EXISTS table_chunk_key text,
      ADD COLUMN IF NOT EXISTS table_chunk_hash text,
      ADD COLUMN IF NOT EXISTS table_chunk_strategy text,
      ADD COLUMN IF NOT EXISTS table_chunk_strategy_version text,
      ADD COLUMN IF NOT EXISTS replaced_by_job_id text
  `);
  console.log("✓ knowledge_chunks: 9 structured table chunk columns added");

  // 7. CHECK constraints on knowledge_chunks
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      DROP CONSTRAINT IF EXISTS kc_row_start_check,
      DROP CONSTRAINT IF EXISTS kc_row_end_check,
      DROP CONSTRAINT IF EXISTS kc_row_range_check
  `);
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT kc_row_start_check CHECK (row_start IS NULL OR row_start >= 0),
      ADD CONSTRAINT kc_row_end_check CHECK (row_end IS NULL OR row_end >= 0),
      ADD CONSTRAINT kc_row_range_check CHECK (row_end IS NULL OR row_start IS NULL OR row_end >= row_start)
  `);
  console.log("✓ knowledge_chunks: 3 row range CHECK constraints added");

  // 8. Index for deterministic table_chunk_key lookup
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_kchk_table_chunk_key
      ON knowledge_chunks (table_chunk_key) WHERE table_chunk_key IS NOT NULL
  `);
  console.log("✓ knowledge_chunks: table_chunk_key index added");

  console.log("\nPhase 5B.1 migration COMPLETE");
  process.exit(0);
}

run().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
