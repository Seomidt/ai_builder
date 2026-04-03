-- Phase 5Z.1 — Segmented Ingestion Hardening
-- Idempotent. Safe to run on existing schemas.
-- Adds indexes and fields needed for:
--   • Aggregation integrity queries
--   • Chunk deduplication / supersession tracking
--   • Cost rollup queries
--   • Partial-readiness read paths

-- ── 1. knowledge_chunks: ensure supersession columns exist ───────────────────
-- These columns are used by supersedePreviousChunks() and chunk deduplication.
-- Already exist in the canonical schema — added here for environments that
-- may have older migrations.

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS replaced_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by_job_id TEXT;

-- ── 2. Aggregation read index ────────────────────────────────────────────────
-- Speeds up getDocumentAggregation() — scans jobs by (tenant, version).

CREATE INDEX IF NOT EXISTS kpj_tenant_version_status_idx
  ON knowledge_processing_jobs (tenant_id, knowledge_document_version_id, status);

-- ── 3. Active-chunk count index ──────────────────────────────────────────────
-- Speeds up the active-chunk COUNT(*) in aggregation.

CREATE INDEX IF NOT EXISTS kc_tenant_version_active_count_idx
  ON knowledge_chunks (tenant_id, knowledge_document_version_id)
  WHERE chunk_active = true;

-- ── 4. Supersession lookup index ─────────────────────────────────────────────
-- Speeds up finding chunks to supersede by replacedByJobId.

CREATE INDEX IF NOT EXISTS kc_replaced_by_job_idx
  ON knowledge_chunks (replaced_by_job_id)
  WHERE replaced_by_job_id IS NOT NULL;

-- ── 5. knowledge_processing_jobs: cost rollup fields ─────────────────────────
-- Tracks actual token counts where providers return them.
-- estimated_cost_usd already exists; these add clarity for 5Z.1 accounting.

ALTER TABLE knowledge_processing_jobs
  ADD COLUMN IF NOT EXISTS input_tokens_actual   INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens_actual  INTEGER,
  ADD COLUMN IF NOT EXISTS provider_call_count   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fallback_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms           INTEGER;

-- Populate duration_ms for existing completed rows (best-effort back-fill).
UPDATE knowledge_processing_jobs
SET duration_ms = EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
WHERE completed_at IS NOT NULL
  AND started_at   IS NOT NULL
  AND duration_ms  IS NULL;

-- ── 6. Guard constraints ──────────────────────────────────────────────────────

ALTER TABLE knowledge_processing_jobs
  DROP CONSTRAINT IF EXISTS kpj_provider_call_count_check;
ALTER TABLE knowledge_processing_jobs
  ADD  CONSTRAINT kpj_provider_call_count_check CHECK (provider_call_count >= 0);

ALTER TABLE knowledge_processing_jobs
  DROP CONSTRAINT IF EXISTS kpj_fallback_count_check;
ALTER TABLE knowledge_processing_jobs
  ADD  CONSTRAINT kpj_fallback_count_check CHECK (fallback_count >= 0);

ALTER TABLE knowledge_processing_jobs
  DROP CONSTRAINT IF EXISTS kpj_input_tokens_actual_check;
ALTER TABLE knowledge_processing_jobs
  ADD  CONSTRAINT kpj_input_tokens_actual_check
    CHECK (input_tokens_actual IS NULL OR input_tokens_actual >= 0);

ALTER TABLE knowledge_processing_jobs
  DROP CONSTRAINT IF EXISTS kpj_output_tokens_actual_check;
ALTER TABLE knowledge_processing_jobs
  ADD  CONSTRAINT kpj_output_tokens_actual_check
    CHECK (output_tokens_actual IS NULL OR output_tokens_actual >= 0);

-- ── 7. Deduplication safety: ensure stale active-chunk constraint exists ──────
-- The canonical schema already has this but older environments may not.
-- Unique partial index: only one active chunk per (version, key).

CREATE UNIQUE INDEX IF NOT EXISTS kc_version_chunk_key_active_unique
  ON knowledge_chunks (knowledge_document_version_id, chunk_key)
  WHERE chunk_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS kc_version_chunk_index_active_unique
  ON knowledge_chunks (knowledge_document_version_id, chunk_index)
  WHERE chunk_active = true;

-- ── 8. Verify migration success ───────────────────────────────────────────────
-- Run this SELECT after applying the migration to confirm all columns exist.
-- Expected: 4 rows

SELECT column_name
FROM information_schema.columns
WHERE table_name  = 'knowledge_processing_jobs'
  AND column_name IN (
    'input_tokens_actual',
    'output_tokens_actual',
    'provider_call_count',
    'fallback_count'
  )
ORDER BY column_name;
