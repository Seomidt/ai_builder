-- chat_ocr_tasks: komplet idempotent migration
-- Sikker at køre gentagne gange (IF NOT EXISTS / DO NOTHING).
-- Kør via Supabase SQL-editor eller psql.

-- ── Grundtabel (oprettes kun hvis den ikke eksisterer) ─────────────────────────
CREATE TABLE IF NOT EXISTS chat_ocr_tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  r2_key        TEXT        NOT NULL,
  filename      TEXT        NOT NULL,
  content_type  TEXT        NOT NULL DEFAULT 'application/pdf',
  status        TEXT        NOT NULL DEFAULT 'pending',
  attempt_count INT         NOT NULL DEFAULT 0,
  max_attempts  INT         NOT NULL DEFAULT 3,
  retry_count   INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Manglende kolonner (idempotent) ───────────────────────────────────────────
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS file_hash        TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS stage            TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS provider         TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS error_reason     TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS pages_processed  INT         NOT NULL DEFAULT 0;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS chunks_processed INT         NOT NULL DEFAULT 0;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS ocr_text         TEXT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS quality_score    NUMERIC(6,4);
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS char_count       INT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS page_count       INT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS chunk_count      INT;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS started_at       TIMESTAMPTZ;
ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ;

-- ── Indekser ──────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS cot_tenant_hash_uidx
  ON chat_ocr_tasks (tenant_id, file_hash)
  WHERE file_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS cot_running_tenant_idx
  ON chat_ocr_tasks (tenant_id, status)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS cot_cleanup_idx
  ON chat_ocr_tasks (status, created_at);

CREATE INDEX IF NOT EXISTS cot_pending_created_idx
  ON chat_ocr_tasks (created_at ASC)
  WHERE status IN ('pending', 'failed');

-- ── OCR-chunks tabel (bruges af storeChunks / storeOcrChunks) ────────────────
CREATE TABLE IF NOT EXISTS chat_ocr_chunks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID        NOT NULL REFERENCES chat_ocr_tasks(id) ON DELETE CASCADE,
  tenant_id   TEXT        NOT NULL,
  chunk_index INT         NOT NULL,
  content     TEXT        NOT NULL,
  page_ref    TEXT,
  embedding   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coc_task_idx    ON chat_ocr_chunks (task_id);
CREATE INDEX IF NOT EXISTS coc_tenant_idx  ON chat_ocr_chunks (tenant_id);

-- ── OCR-kostningslog (bruges af logOcrCost) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ocr_cost_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL,
  provider            TEXT        NOT NULL,
  model               TEXT        NOT NULL,
  feature             TEXT        NOT NULL,
  prompt_tokens       INT         NOT NULL DEFAULT 0,
  completion_tokens   INT         NOT NULL DEFAULT 0,
  estimated_cost_usd  NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms          INT         NOT NULL DEFAULT 0,
  status              TEXT        NOT NULL DEFAULT 'success',
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ocl_tenant_idx     ON ocr_cost_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ocl_provider_idx   ON ocr_cost_log (provider, model);
