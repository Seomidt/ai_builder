-- ============================================================
-- PHASE 5Y.1 — Output Validation Layer
-- Adds validation fields to media processing tables
-- ============================================================

-- 1. Add validation fields to media_processing_jobs
ALTER TABLE media_processing_jobs
ADD COLUMN IF NOT EXISTS output_validated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS output_validation_status TEXT,
ADD COLUMN IF NOT EXISTS output_validation_code TEXT,
ADD COLUMN IF NOT EXISTS output_validation_metrics_jsonb JSONB;

-- 2. Add validation fields to media_processing_steps
ALTER TABLE media_processing_steps
ADD COLUMN IF NOT EXISTS output_validated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS output_validation_status TEXT,
ADD COLUMN IF NOT EXISTS output_validation_code TEXT,
ADD COLUMN IF NOT EXISTS output_validation_metrics_jsonb JSONB;

-- 3. Add validation fields to legacy chat_ocr_tasks (for backfill/protection)
ALTER TABLE chat_ocr_tasks
ADD COLUMN IF NOT EXISTS output_validated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS output_validation_status TEXT,
ADD COLUMN IF NOT EXISTS output_validation_code TEXT;

-- 4. Create index for finding unvalidated or failed jobs
CREATE INDEX IF NOT EXISTS idx_media_jobs_validation_status 
ON media_processing_jobs(output_validation_status) 
WHERE output_validation_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_ocr_validation_status 
ON chat_ocr_tasks(output_validation_status) 
WHERE output_validation_status IS NOT NULL;
