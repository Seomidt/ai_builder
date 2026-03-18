/**
 * Phase 5B.2 DB migration — run once
 * npx tsx server/lib/ai/migrate-phase5b2.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

async function run() {
  console.log("Running Phase 5B.2 migration...");

  // 1. Add OCR parse metadata columns to knowledge_document_versions
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      ADD COLUMN IF NOT EXISTS ocr_status text,
      ADD COLUMN IF NOT EXISTS ocr_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS ocr_completed_at timestamptz,
      ADD COLUMN IF NOT EXISTS ocr_engine_name text,
      ADD COLUMN IF NOT EXISTS ocr_engine_version text,
      ADD COLUMN IF NOT EXISTS ocr_text_checksum text,
      ADD COLUMN IF NOT EXISTS ocr_block_count integer,
      ADD COLUMN IF NOT EXISTS ocr_line_count integer,
      ADD COLUMN IF NOT EXISTS ocr_average_confidence numeric,
      ADD COLUMN IF NOT EXISTS ocr_failure_reason text
  `);
  console.log("✓ knowledge_document_versions: 10 OCR columns added");

  // 2. CHECK constraints on knowledge_document_versions
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      DROP CONSTRAINT IF EXISTS kdv_ocr_status_check,
      DROP CONSTRAINT IF EXISTS kdv_ocr_block_count_check,
      DROP CONSTRAINT IF EXISTS kdv_ocr_line_count_check,
      DROP CONSTRAINT IF EXISTS kdv_ocr_avg_confidence_check
  `);
  await db.execute(sql`
    ALTER TABLE knowledge_document_versions
      ADD CONSTRAINT kdv_ocr_status_check
        CHECK (ocr_status IS NULL OR ocr_status IN ('pending','running','completed','failed')),
      ADD CONSTRAINT kdv_ocr_block_count_check
        CHECK (ocr_block_count IS NULL OR ocr_block_count >= 0),
      ADD CONSTRAINT kdv_ocr_line_count_check
        CHECK (ocr_line_count IS NULL OR ocr_line_count >= 0),
      ADD CONSTRAINT kdv_ocr_avg_confidence_check
        CHECK (ocr_average_confidence IS NULL OR (ocr_average_confidence >= 0 AND ocr_average_confidence <= 1))
  `);
  console.log("✓ knowledge_document_versions: 4 OCR CHECK constraints added");

  // 3. Index on ocr_status
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS kdv_tenant_ocr_status_idx
      ON knowledge_document_versions (tenant_id, ocr_status, created_at)
  `);
  console.log("✓ knowledge_document_versions: ocr_status index added");

  // 4. Add OCR chunk columns to knowledge_chunks
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN IF NOT EXISTS image_chunk boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS image_chunk_strategy text,
      ADD COLUMN IF NOT EXISTS image_chunk_version text,
      ADD COLUMN IF NOT EXISTS image_region_index integer,
      ADD COLUMN IF NOT EXISTS bbox_left numeric,
      ADD COLUMN IF NOT EXISTS bbox_top numeric,
      ADD COLUMN IF NOT EXISTS bbox_width numeric,
      ADD COLUMN IF NOT EXISTS bbox_height numeric,
      ADD COLUMN IF NOT EXISTS ocr_confidence numeric,
      ADD COLUMN IF NOT EXISTS source_page_number integer
  `);
  console.log("✓ knowledge_chunks: 10 OCR image chunk columns added");

  // 5. CHECK constraints on knowledge_chunks
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      DROP CONSTRAINT IF EXISTS kc_image_region_idx_check,
      DROP CONSTRAINT IF EXISTS kc_source_page_check,
      DROP CONSTRAINT IF EXISTS kc_bbox_left_check,
      DROP CONSTRAINT IF EXISTS kc_bbox_top_check,
      DROP CONSTRAINT IF EXISTS kc_bbox_width_check,
      DROP CONSTRAINT IF EXISTS kc_bbox_height_check,
      DROP CONSTRAINT IF EXISTS kc_ocr_confidence_check
  `);
  await db.execute(sql`
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT kc_image_region_idx_check CHECK (image_region_index IS NULL OR image_region_index >= 0),
      ADD CONSTRAINT kc_source_page_check CHECK (source_page_number IS NULL OR source_page_number >= 0),
      ADD CONSTRAINT kc_bbox_left_check CHECK (bbox_left IS NULL OR bbox_left >= 0),
      ADD CONSTRAINT kc_bbox_top_check CHECK (bbox_top IS NULL OR bbox_top >= 0),
      ADD CONSTRAINT kc_bbox_width_check CHECK (bbox_width IS NULL OR bbox_width >= 0),
      ADD CONSTRAINT kc_bbox_height_check CHECK (bbox_height IS NULL OR bbox_height >= 0),
      ADD CONSTRAINT kc_ocr_confidence_check CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1))
  `);
  console.log("✓ knowledge_chunks: 7 OCR CHECK constraints added");

  // 6. Index for image chunk lookup
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_kchk_image_chunk
      ON knowledge_chunks (knowledge_document_version_id, image_region_index)
      WHERE image_chunk = true
  `);
  console.log("✓ knowledge_chunks: image_chunk index added");

  // 7. Add OCR processor columns to knowledge_processing_jobs
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD COLUMN IF NOT EXISTS ocr_processor_name text,
      ADD COLUMN IF NOT EXISTS ocr_processor_version text
  `);
  console.log("✓ knowledge_processing_jobs: 2 OCR processor columns added");

  // 8. Update job_type CHECK to include ocr_parse and ocr_chunk
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs DROP CONSTRAINT IF EXISTS kpj_job_type_check`);
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD CONSTRAINT kpj_job_type_check
        CHECK (job_type IN ('upload_verify','parse','chunk','embed','index','reindex','delete_index','lifecycle_sync','extract_text','structured_parse','structured_chunk','ocr_parse','ocr_chunk'))
  `);
  console.log("✓ knowledge_processing_jobs: job_type CHECK updated with ocr_parse + ocr_chunk");

  console.log("\nPhase 5B.2 migration COMPLETE");
  process.exit(0);
}

run().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
