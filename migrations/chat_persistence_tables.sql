-- chat_conversation_attachments + chat_route_decisions: idempotent migration
-- Sikker at køre gentagne gange (IF NOT EXISTS / DO NOTHING).
-- Kør via Supabase SQL-editor eller psql mod produktionsdatabasen.
--
-- Disse tabeller manglede i produktion — årsag til nul rækker i:
--   • chat_conversation_attachments  (dokument-kontekst per samtale)
--   • chat_route_decisions           (audit log for routing-beslutninger)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. chat_conversation_attachments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_conversation_attachments (
  id               VARCHAR        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  TEXT           NOT NULL,
  tenant_id        TEXT           NOT NULL,
  filename         TEXT           NOT NULL,
  mime_type        TEXT           NOT NULL DEFAULT 'application/pdf',
  extracted_text   TEXT           NOT NULL,
  char_count       INTEGER        NOT NULL,
  status           TEXT           NOT NULL DEFAULT 'completed',
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Indekser (idempotente)
CREATE INDEX IF NOT EXISTS cca_conv_idx
  ON chat_conversation_attachments (conversation_id);

CREATE INDEX IF NOT EXISTS cca_tenant_conv_idx
  ON chat_conversation_attachments (tenant_id, conversation_id);

-- Check constraint (idempotent via DO-blok)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cca_status_check'
      AND conrelid = 'chat_conversation_attachments'::regclass
  ) THEN
    ALTER TABLE chat_conversation_attachments
      ADD CONSTRAINT cca_status_check CHECK (status IN ('completed', 'failed'));
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. chat_route_decisions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_route_decisions (
  id               VARCHAR        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT           NOT NULL,
  conversation_id  TEXT,
  user_id          TEXT           NOT NULL,
  route_type       TEXT           NOT NULL,
  attachment_ids   TEXT[],
  expert_ids       TEXT[],
  route_reason     TEXT           NOT NULL,
  expert_score     NUMERIC(6, 2),
  has_attachment   BOOLEAN        NOT NULL DEFAULT FALSE,
  has_experts      BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Indekser (idempotente)
CREATE INDEX IF NOT EXISTS crd_tenant_created_idx
  ON chat_route_decisions (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS crd_conv_idx
  ON chat_route_decisions (conversation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Verifikation — kør efter migration for at bekræfte success
-- ─────────────────────────────────────────────────────────────────────────────

-- Forventet output: begge tabeller vises med korrekte kolonner
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('chat_conversation_attachments', 'chat_route_decisions')
ORDER BY table_name, ordinal_position;
