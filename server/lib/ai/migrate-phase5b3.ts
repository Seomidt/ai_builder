/**
 * Phase 5B.3 — Audio/Video Ingestion Pipeline DB Migration
 *
 * Adds transcript + media columns to knowledge_document_versions,
 * transcript chunk columns to knowledge_chunks,
 * transcript processor columns to knowledge_processing_jobs,
 * updates job_type CHECK constraint, adds indexes.
 *
 * Run: npx tsx server/lib/ai/migrate-phase5b3.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function migrate() {
  console.log("Phase 5B.3 migration: starting…");

  // ── knowledge_document_versions — transcript + media columns ─────────────
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_status text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_started_at timestamptz`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_completed_at timestamptz`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_engine_name text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_engine_version text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_text_checksum text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_segment_count integer`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_speaker_count integer`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_language_code text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_average_confidence numeric`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS transcript_failure_reason text`);
  await db.execute(sql`ALTER TABLE knowledge_document_versions ADD COLUMN IF NOT EXISTS media_duration_ms bigint`);
  console.log("  kdv: 12 transcript/media columns added");

  // ── knowledge_document_versions — transcript CHECK constraints ────────────
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kdv_transcript_status_check') THEN
        ALTER TABLE knowledge_document_versions
          ADD CONSTRAINT kdv_transcript_status_check
          CHECK (transcript_status IS NULL OR transcript_status IN ('pending','running','completed','failed'));
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kdv_transcript_segment_count_check') THEN
        ALTER TABLE knowledge_document_versions
          ADD CONSTRAINT kdv_transcript_segment_count_check
          CHECK (transcript_segment_count IS NULL OR transcript_segment_count >= 0);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kdv_transcript_speaker_count_check') THEN
        ALTER TABLE knowledge_document_versions
          ADD CONSTRAINT kdv_transcript_speaker_count_check
          CHECK (transcript_speaker_count IS NULL OR transcript_speaker_count >= 0);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kdv_transcript_avg_confidence_check') THEN
        ALTER TABLE knowledge_document_versions
          ADD CONSTRAINT kdv_transcript_avg_confidence_check
          CHECK (transcript_average_confidence IS NULL OR (transcript_average_confidence >= 0 AND transcript_average_confidence <= 1));
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kdv_media_duration_ms_check') THEN
        ALTER TABLE knowledge_document_versions
          ADD CONSTRAINT kdv_media_duration_ms_check
          CHECK (media_duration_ms IS NULL OR media_duration_ms >= 0);
      END IF;
    END $$`);
  console.log("  kdv: 5 CHECK constraints added");

  // ── knowledge_chunks — transcript chunk columns ───────────────────────────
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS transcript_chunk boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS transcript_chunk_strategy text`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS transcript_chunk_version text`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS segment_start_ms bigint`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS segment_end_ms bigint`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS transcript_segment_index integer`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS speaker_label text`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS transcript_confidence numeric`);
  await db.execute(sql`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS source_track text`);
  console.log("  kc: 9 transcript chunk columns added");

  // ── knowledge_chunks — transcript CHECK constraints ───────────────────────
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kc_transcript_segment_idx_check') THEN
        ALTER TABLE knowledge_chunks
          ADD CONSTRAINT kc_transcript_segment_idx_check
          CHECK (transcript_segment_index IS NULL OR transcript_segment_index >= 0);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kc_segment_start_ms_check') THEN
        ALTER TABLE knowledge_chunks
          ADD CONSTRAINT kc_segment_start_ms_check
          CHECK (segment_start_ms IS NULL OR segment_start_ms >= 0);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kc_segment_end_ms_check') THEN
        ALTER TABLE knowledge_chunks
          ADD CONSTRAINT kc_segment_end_ms_check
          CHECK (segment_end_ms IS NULL OR segment_end_ms >= 0);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kc_segment_ms_range_check') THEN
        ALTER TABLE knowledge_chunks
          ADD CONSTRAINT kc_segment_ms_range_check
          CHECK (segment_end_ms IS NULL OR segment_start_ms IS NULL OR segment_end_ms >= segment_start_ms);
      END IF;
    END $$`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kc_transcript_confidence_check') THEN
        ALTER TABLE knowledge_chunks
          ADD CONSTRAINT kc_transcript_confidence_check
          CHECK (transcript_confidence IS NULL OR (transcript_confidence >= 0 AND transcript_confidence <= 1));
      END IF;
    END $$`);
  console.log("  kc: 5 CHECK constraints added");

  // ── knowledge_processing_jobs — transcript processor columns ─────────────
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs ADD COLUMN IF NOT EXISTS transcript_processor_name text`);
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs ADD COLUMN IF NOT EXISTS transcript_processor_version text`);
  console.log("  kpj: 2 transcript processor columns added");

  // ── knowledge_processing_jobs — update job_type CHECK constraint ─────────
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs DROP CONSTRAINT IF EXISTS kpj_job_type_check`);
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD CONSTRAINT kpj_job_type_check
      CHECK (job_type IN (
        'upload_verify','parse','chunk','embed','index','reindex',
        'delete_index','lifecycle_sync','extract_text',
        'structured_parse','structured_chunk',
        'ocr_parse','ocr_chunk',
        'transcript_parse','transcript_chunk'
      ))`);
  console.log("  kpj: job_type CHECK constraint updated with transcript_parse + transcript_chunk");

  // ── Indexes ──────────────────────────────────────────────────────────────
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kdv_tenant_transcript_status_idx ON knowledge_document_versions (tenant_id, transcript_status, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kchk_transcript_chunk ON knowledge_chunks (tenant_id, transcript_chunk) WHERE transcript_chunk = true`);
  console.log("  indexes: kdv_tenant_transcript_status_idx + idx_kchk_transcript_chunk created");

  console.log("Phase 5B.3 migration: COMPLETE");
  process.exit(0);
}

migrate().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
