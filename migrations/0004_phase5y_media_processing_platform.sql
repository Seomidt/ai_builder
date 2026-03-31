-- ============================================================
-- PHASE 5Y — Unified Media Processing Platform
-- Migration: 0004_phase5y_media_processing_platform.sql
--
-- Creates:
--   1. media_processing_jobs   — generalised job table (replaces chat_ocr_tasks for new work)
--   2. media_processing_steps  — step-level execution tracking
--   3. media_event_log         — append-only audit log for all job/step transitions
--
-- Backward compatibility:
--   chat_ocr_tasks is preserved unchanged. A view bridges old → new.
-- ============================================================

-- ── 1. Enum types ────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE media_type_enum AS ENUM ('pdf','image','audio','video','text');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pipeline_type_enum AS ENUM (
    'ocr','vision','transcription','parsing','embedding','multimodal_extract'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE media_job_status AS ENUM (
    'pending','processing','retryable_failed','completed','failed','dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE media_step_status AS ENUM (
    'pending','running','completed','failed','skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE failure_category_enum AS ENUM (
    'timeout','provider_transient','provider_permanent','network',
    'invalid_input','unsupported_media','rate_limited','storage',
    'db','internal','unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE step_type_enum AS ENUM (
    'preprocess','upload_media','extract_text','ocr','vision_caption',
    'transcribe_audio','extract_audio_track','extract_video_frames',
    'merge_multimodal_output','normalize_text','chunk_text',
    'persist_output','index_embeddings','finalize'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. media_processing_jobs ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media_processing_jobs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  document_id             UUID,
  knowledge_asset_id      UUID,
  asset_version_id        UUID,

  -- Media classification
  media_type              media_type_enum NOT NULL,
  pipeline_type           pipeline_type_enum NOT NULL,

  -- Job lifecycle
  status                  media_job_status NOT NULL DEFAULT 'pending',
  current_step            TEXT,
  attempt_count           INT NOT NULL DEFAULT 0,
  max_attempts            INT NOT NULL DEFAULT 3,
  fallback_depth          INT NOT NULL DEFAULT 0,

  -- Timestamps
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at              TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,
  dead_lettered_at        TIMESTAMPTZ,
  last_heartbeat_at       TIMESTAMPTZ,

  -- Worker tracking
  worker_id               TEXT,
  execution_trace_id      UUID DEFAULT gen_random_uuid(),

  -- Error tracking
  last_error_code         TEXT,
  last_error_message      TEXT,
  failure_category        failure_category_enum,
  retryable               BOOLEAN,
  next_retry_at           TIMESTAMPTZ,

  -- Storage references
  input_storage_ref       TEXT NOT NULL,  -- R2 key
  output_storage_ref      TEXT,           -- R2 key for output if applicable

  -- Cost tracking
  processing_cost_estimate NUMERIC(10,6) DEFAULT 0,
  processing_cost_actual   NUMERIC(10,6) DEFAULT 0,

  -- Output (for OCR/vision/transcription — normalized text)
  output_text             TEXT,
  output_char_count       INT,
  output_page_count       INT,
  output_chunk_count      INT,
  output_quality_score    NUMERIC(4,3),
  output_provider         TEXT,
  output_model            TEXT,

  -- Metadata
  filename                TEXT,
  content_type            TEXT,
  file_size_bytes         BIGINT,
  metadata_jsonb          JSONB DEFAULT '{}'::jsonb,

  CONSTRAINT mpj_tenant_check CHECK (tenant_id IS NOT NULL)
);

-- Indexes for media_processing_jobs
CREATE INDEX IF NOT EXISTS idx_mpj_tenant_status
  ON media_processing_jobs (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_mpj_status_retry
  ON media_processing_jobs (status, next_retry_at)
  WHERE status IN ('pending','retryable_failed');

CREATE INDEX IF NOT EXISTS idx_mpj_heartbeat
  ON media_processing_jobs (last_heartbeat_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_mpj_document
  ON media_processing_jobs (document_id)
  WHERE document_id IS NOT NULL;

-- ── 3. media_processing_steps ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media_processing_steps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  job_id              UUID NOT NULL REFERENCES media_processing_jobs(id) ON DELETE CASCADE,
  document_id         UUID,
  knowledge_asset_id  UUID,

  -- Step identity
  step_key            TEXT NOT NULL,  -- unique within job, e.g. "ocr_0", "transcribe_1"
  step_type           step_type_enum NOT NULL,
  step_order          INT NOT NULL DEFAULT 0,

  -- Step lifecycle
  status              media_step_status NOT NULL DEFAULT 'pending',
  attempt_count       INT NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  duration_ms         INT,

  -- Provider tracking
  provider            TEXT,
  model               TEXT,
  fallback_depth      INT DEFAULT 0,

  -- Error tracking
  last_error_code     TEXT,
  last_error_message  TEXT,
  failure_category    failure_category_enum,

  -- Storage refs
  input_ref           TEXT,
  output_ref          TEXT,

  -- Output
  output_text         TEXT,
  output_char_count   INT,

  -- Cost
  cost_estimate       NUMERIC(10,6) DEFAULT 0,
  cost_actual         NUMERIC(10,6) DEFAULT 0,

  -- Metadata
  metadata_jsonb      JSONB DEFAULT '{}'::jsonb,

  CONSTRAINT mps_unique_step_key UNIQUE (job_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_mps_job_id
  ON media_processing_steps (job_id);

CREATE INDEX IF NOT EXISTS idx_mps_tenant_status
  ON media_processing_steps (tenant_id, status);

-- ── 4. media_event_log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media_event_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Context
  tenant_id           UUID NOT NULL,
  job_id              UUID,
  step_id             UUID,
  document_id         UUID,
  knowledge_asset_id  UUID,

  -- Event classification
  event_type          TEXT NOT NULL,
  media_type          media_type_enum,
  pipeline_type       pipeline_type_enum,

  -- Provider/model
  provider            TEXT,
  model               TEXT,

  -- Attempt tracking
  attempt_count       INT,
  fallback_depth      INT DEFAULT 0,

  -- Trace
  worker_id           TEXT,
  execution_trace_id  UUID,

  -- Payload (SOC2: no document content)
  payload_jsonb       JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mel_tenant_job
  ON media_event_log (tenant_id, job_id);

CREATE INDEX IF NOT EXISTS idx_mel_event_type
  ON media_event_log (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mel_created_at
  ON media_event_log (created_at DESC);

-- ── 5. Compatibility view: chat_ocr_tasks → media_processing_jobs ────────────
-- Allows existing code to keep using chat_ocr_tasks while new code uses media_processing_jobs.
-- New OCR jobs created via media_processing_jobs will be visible here.

CREATE OR REPLACE VIEW v_ocr_jobs AS
SELECT
  id,
  tenant_id,
  document_id,
  filename,
  content_type,
  input_storage_ref AS r2_key,
  status::TEXT AS status,
  current_step AS stage,
  attempt_count,
  max_attempts,
  fallback_depth,
  created_at,
  updated_at,
  claimed_at,
  started_at,
  completed_at,
  failed_at,
  dead_lettered_at,
  last_heartbeat_at,
  worker_id,
  execution_trace_id,
  last_error_code,
  last_error_message,
  failure_category::TEXT AS failure_category,
  retryable,
  next_retry_at,
  output_text AS ocr_text,
  output_char_count AS char_count,
  output_page_count AS page_count,
  output_chunk_count AS chunk_count,
  output_quality_score AS quality_score,
  output_provider AS provider,
  output_model AS model,
  processing_cost_actual AS cost_actual,
  metadata_jsonb
FROM media_processing_jobs
WHERE pipeline_type IN ('ocr','vision','transcription','multimodal_extract');

-- ── 6. Row-level security (RLS) ───────────────────────────────────────────────

ALTER TABLE media_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_processing_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_event_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (worker uses service role key)
-- Application users can only see their own tenant's data
CREATE POLICY "tenant_isolation_mpj" ON media_processing_jobs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY "tenant_isolation_mps" ON media_processing_steps
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY "tenant_isolation_mel" ON media_event_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- ── 7. Updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mpj_updated_at ON media_processing_jobs;
CREATE TRIGGER trg_mpj_updated_at
  BEFORE UPDATE ON media_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
