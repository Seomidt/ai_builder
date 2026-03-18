/**
 * migrate-phase5g.ts — Phase 5G
 * Raw SQL migration for Knowledge Asset Registry tables.
 *
 * Creates:
 *   1. knowledge_assets
 *   2. knowledge_asset_versions  (FK → knowledge_assets)
 *   3. knowledge_storage_objects
 *   4. knowledge_asset_processing_jobs (FK → knowledge_assets, knowledge_asset_versions)
 *   5. Deferred FK: knowledge_assets.current_version_id → knowledge_asset_versions.id
 *
 * Safety: each step is idempotent (IF NOT EXISTS / DO NOTHING patterns).
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  [5G] ${label}... `);
  try {
    await fn();
    console.log("OK");
  } catch (err: any) {
    if (/already exists/.test(err.message)) {
      console.log("already exists (OK)");
    } else {
      console.error(`FAILED: ${err.message}`);
      throw err;
    }
  }
}

async function main() {
  console.log("\n========================================");
  console.log("  migrate-phase5g.ts — Phase 5G");
  console.log("  Knowledge Asset Registry & Multimodal");
  console.log("========================================\n");

  // Step 1 — knowledge_assets
  await step("Create knowledge_assets", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_assets (
        id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id           TEXT NOT NULL,
        knowledge_base_id   TEXT NOT NULL,
        asset_type          TEXT NOT NULL,
        title               TEXT,
        source_type         TEXT NOT NULL,
        lifecycle_state     TEXT NOT NULL DEFAULT 'active',
        processing_state    TEXT NOT NULL DEFAULT 'pending',
        visibility_state    TEXT NOT NULL DEFAULT 'private',
        current_version_id  TEXT,
        checksum_sha256     TEXT,
        metadata            JSONB,
        created_by          TEXT,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT ka_asset_type_check CHECK (asset_type IN ('document','image','video','audio','email','webpage')),
        CONSTRAINT ka_source_type_check CHECK (source_type IN ('upload','url','manual','api','email_ingest')),
        CONSTRAINT ka_lifecycle_state_check CHECK (lifecycle_state IN ('active','suspended','archived','deleted')),
        CONSTRAINT ka_processing_state_check CHECK (processing_state IN ('pending','processing','ready','failed','reindex_required')),
        CONSTRAINT ka_visibility_state_check CHECK (visibility_state IN ('private','shared','internal'))
      )
    `);
  });

  await step("Index ka_tenant_kb_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ka_tenant_kb_created_idx
        ON knowledge_assets (tenant_id, knowledge_base_id, created_at)
    `);
  });

  await step("Index ka_tenant_type_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ka_tenant_type_created_idx
        ON knowledge_assets (tenant_id, asset_type, created_at)
    `);
  });

  await step("Index ka_tenant_lifecycle_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ka_tenant_lifecycle_idx
        ON knowledge_assets (tenant_id, lifecycle_state, created_at)
    `);
  });

  await step("Index ka_tenant_processing_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ka_tenant_processing_idx
        ON knowledge_assets (tenant_id, processing_state, created_at)
    `);
  });

  // Step 2 — knowledge_asset_versions
  await step("Create knowledge_asset_versions", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_asset_versions (
        id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        asset_id             TEXT NOT NULL REFERENCES knowledge_assets(id),
        version_number       INTEGER NOT NULL,
        storage_object_id    TEXT,
        parser_version       TEXT,
        processing_profile   TEXT,
        checksum_sha256      TEXT,
        size_bytes           BIGINT,
        mime_type            TEXT,
        metadata             JSONB,
        created_by           TEXT,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT kav_version_number_check CHECK (version_number > 0),
        CONSTRAINT kav_size_bytes_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
        CONSTRAINT kav_asset_version_uniq UNIQUE (asset_id, version_number)
      )
    `);
  });

  await step("Index kav_asset_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kav_asset_created_idx
        ON knowledge_asset_versions (asset_id, created_at)
    `);
  });

  await step("Index kav_storage_object_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kav_storage_object_idx
        ON knowledge_asset_versions (storage_object_id)
    `);
  });

  // Step 3 — Deferred FK: knowledge_assets.current_version_id → knowledge_asset_versions.id
  await step("Add FK knowledge_assets.current_version_id → knowledge_asset_versions.id", async () => {
    const existing = await db.execute(sql`
      SELECT 1 FROM pg_constraint
      WHERE conname = 'ka_current_version_id_fk'
      LIMIT 1
    `);
    const rows = (existing as any).rows ?? [];
    if (rows.length > 0) return;
    await db.execute(sql`
      ALTER TABLE knowledge_assets
        ADD CONSTRAINT ka_current_version_id_fk
          FOREIGN KEY (current_version_id)
          REFERENCES knowledge_asset_versions(id)
          DEFERRABLE INITIALLY DEFERRED
    `);
  });

  // Step 4 — asset_storage_objects (generic; distinct from Phase 5B knowledge_storage_objects)
  await step("Create asset_storage_objects", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS asset_storage_objects (
        id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id         TEXT NOT NULL,
        storage_provider  TEXT NOT NULL,
        bucket_name       TEXT NOT NULL,
        object_key        TEXT NOT NULL,
        storage_class     TEXT NOT NULL DEFAULT 'hot',
        size_bytes        BIGINT NOT NULL,
        mime_type         TEXT,
        checksum_sha256   TEXT,
        metadata          JSONB,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        archived_at       TIMESTAMP,
        deleted_at        TIMESTAMP,
        CONSTRAINT aso_size_bytes_check CHECK (size_bytes >= 0),
        CONSTRAINT aso_storage_provider_check CHECK (storage_provider IN ('r2','s3','supabase','local')),
        CONSTRAINT aso_storage_class_check CHECK (storage_class IN ('hot','cold','archive','deleted')),
        CONSTRAINT aso_tenant_bucket_key_uniq UNIQUE (tenant_id, bucket_name, object_key)
      )
    `);
  });

  await step("Index aso_tenant_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS aso_tenant_created_idx
        ON asset_storage_objects (tenant_id, created_at)
    `);
  });

  await step("Index aso_tenant_checksum_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS aso_tenant_checksum_idx
        ON asset_storage_objects (tenant_id, checksum_sha256)
    `);
  });

  await step("Index aso_tenant_class_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS aso_tenant_class_created_idx
        ON asset_storage_objects (tenant_id, storage_class, created_at)
    `);
  });

  // Step 5 — knowledge_asset_processing_jobs
  await step("Create knowledge_asset_processing_jobs", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_asset_processing_jobs (
        id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id         TEXT NOT NULL,
        asset_id          TEXT NOT NULL REFERENCES knowledge_assets(id),
        asset_version_id  TEXT REFERENCES knowledge_asset_versions(id),
        job_type          TEXT NOT NULL,
        job_status        TEXT NOT NULL DEFAULT 'queued',
        attempt_number    INTEGER NOT NULL DEFAULT 1,
        error_message     TEXT,
        metadata          JSONB,
        started_at        TIMESTAMP,
        completed_at      TIMESTAMP,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT kapj_attempt_number_check CHECK (attempt_number > 0),
        CONSTRAINT kapj_job_type_check CHECK (job_type IN (
          'parse_document','ocr_image','caption_image','extract_video_metadata',
          'extract_audio','transcribe_audio','sample_video_frames','segment_video',
          'chunk_text','embed_text','embed_image','index_asset','reindex_asset','delete_index'
        )),
        CONSTRAINT kapj_job_status_check CHECK (job_status IN (
          'queued','started','completed','failed','skipped','cancelled'
        ))
      )
    `);
  });

  await step("Index kapj_tenant_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kapj_tenant_created_idx
        ON knowledge_asset_processing_jobs (tenant_id, created_at)
    `);
  });

  await step("Index kapj_asset_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kapj_asset_created_idx
        ON knowledge_asset_processing_jobs (asset_id, created_at)
    `);
  });

  await step("Index kapj_status_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kapj_status_created_idx
        ON knowledge_asset_processing_jobs (job_status, created_at)
    `);
  });

  await step("Index kapj_type_created_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kapj_type_created_idx
        ON knowledge_asset_processing_jobs (job_type, created_at)
    `);
  });

  console.log("\n========================================");
  console.log("  Phase 5G migration complete.");
  console.log("  Tables: knowledge_assets, knowledge_asset_versions,");
  console.log("          asset_storage_objects, knowledge_asset_processing_jobs");
  console.log("  Deferred FK: knowledge_assets.current_version_id");
  console.log("========================================\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
