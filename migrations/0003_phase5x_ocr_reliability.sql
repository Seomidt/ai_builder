-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5X: OCR Reliability, Fallback, Timeout Enforcement & Dead-Letter Safety
-- Migration: 0003_phase5x_ocr_reliability.sql
--
-- Safe to run multiple times (all statements are idempotent).
-- Does NOT destroy existing rows or columns.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add new columns to chat_ocr_tasks (all nullable / with defaults) ───────

ALTER TABLE chat_ocr_tasks
  ADD COLUMN IF NOT EXISTS worker_id           TEXT,
  ADD COLUMN IF NOT EXISTS execution_trace_id  TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code     TEXT,
  ADD COLUMN IF NOT EXISTS last_error_message  TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_category    TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fallback_depth      INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata_jsonb      JSONB       NOT NULL DEFAULT '{}';

-- ── 2. Normalise status values ────────────────────────────────────────────────
-- Map legacy 'running' → 'processing' so the new state machine is consistent.
UPDATE chat_ocr_tasks
SET    status = 'processing'
WHERE  status = 'running';

-- Map legacy 'manus_processing' stage → 'ocr'
UPDATE chat_ocr_tasks
SET    stage = 'ocr'
WHERE  stage = 'manus_processing';

-- ── 3. Indexes for new query patterns ─────────────────────────────────────────

-- Reaper query: find stuck processing jobs by heartbeat age
CREATE INDEX IF NOT EXISTS cot_heartbeat_idx
  ON chat_ocr_tasks (status, last_heartbeat_at)
  WHERE status = 'processing';

-- Retry scheduling: find jobs ready for retry
CREATE INDEX IF NOT EXISTS cot_retry_idx
  ON chat_ocr_tasks (status, next_retry_at)
  WHERE status = 'retryable_failed';

-- Dead-letter index
CREATE INDEX IF NOT EXISTS cot_dead_letter_idx
  ON chat_ocr_tasks (status, dead_lettered_at)
  WHERE status = 'dead_letter';

-- ── 4. OCR execution event log (append-only audit trail) ──────────────────────

CREATE TABLE IF NOT EXISTS ocr_event_log (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           TEXT        NOT NULL,
  job_id              UUID        NOT NULL,
  document_id         TEXT,
  event_type          TEXT        NOT NULL,
  stage               TEXT,
  provider            TEXT,
  model               TEXT,
  attempt_count       INT,
  fallback_depth      INT,
  worker_id           TEXT,
  execution_trace_id  TEXT,
  payload_jsonb       JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for event log queries
CREATE INDEX IF NOT EXISTS oel_job_idx    ON ocr_event_log (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oel_tenant_idx ON ocr_event_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oel_event_idx  ON ocr_event_log (event_type, created_at DESC);

-- ── 5. RLS: event log is readable by service role only ────────────────────────
ALTER TABLE ocr_event_log ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (worker writes, admin reads)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ocr_event_log' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON ocr_event_log
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
