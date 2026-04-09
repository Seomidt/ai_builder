/**
 * Migration: Chat Asset Phase 1
 * - Makes knowledge_documents.knowledge_base_id nullable
 * - Adds 9 new columns for asset scope/origin/retention
 * - Adds tenant_storage_settings table
 * - Adds new indexes and CHECK constraints
 */

import pg from "pg";

const url = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
if (!url) throw new Error("No database URL found.");

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  console.log("Connected to database.");

  try {
    await client.query("BEGIN");

    // 1. Make knowledge_base_id nullable
    console.log("1. Making knowledge_base_id nullable...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ALTER COLUMN knowledge_base_id DROP NOT NULL
    `);

    // 2. Add asset_scope
    console.log("2. Adding asset_scope...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS asset_scope text NOT NULL DEFAULT 'persistent_storage'
    `);

    // 3. Add asset_origin
    console.log("3. Adding asset_origin...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS asset_origin text NOT NULL DEFAULT 'storage_upload'
    `);

    // 4. Add chat_thread_id
    console.log("4. Adding chat_thread_id...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS chat_thread_id text
    `);

    // 5. Add file_hash
    console.log("5. Adding file_hash...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS file_hash text
    `);

    // 6. Add is_pinned
    console.log("6. Adding is_pinned...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false
    `);

    // 7. Add promoted_to_storage_at
    console.log("7. Adding promoted_to_storage_at...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS promoted_to_storage_at timestamp
    `);

    // 8. Add retention_mode
    console.log("8. Adding retention_mode...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS retention_mode text
    `);

    // 9. Add retention_expires_at
    console.log("9. Adding retention_expires_at...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS retention_expires_at timestamp
    `);

    // 10. Add last_accessed_at
    console.log("10. Adding last_accessed_at...");
    await client.query(`
      ALTER TABLE knowledge_documents
        ADD COLUMN IF NOT EXISTS last_accessed_at timestamp
    `);

    // 11. Add CHECK constraints (only if they don't exist)
    console.log("11. Adding CHECK constraints...");
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
          WHERE constraint_name = 'kd_asset_scope_check'
        ) THEN
          ALTER TABLE knowledge_documents
            ADD CONSTRAINT kd_asset_scope_check
            CHECK (asset_scope IN ('temporary_chat','persistent_storage'));
        END IF;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
          WHERE constraint_name = 'kd_asset_origin_check'
        ) THEN
          ALTER TABLE knowledge_documents
            ADD CONSTRAINT kd_asset_origin_check
            CHECK (asset_origin IN ('chat_upload','storage_upload','imported'));
        END IF;
      END $$
    `);

    // 12. Add indexes
    console.log("12. Adding indexes...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS kd_tenant_scope_idx
        ON knowledge_documents (tenant_id, asset_scope, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS kd_tenant_file_hash_idx
        ON knowledge_documents (tenant_id, file_hash)
        WHERE file_hash IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS kd_chat_thread_idx
        ON knowledge_documents (chat_thread_id)
        WHERE chat_thread_id IS NOT NULL
    `);

    // 13. Create tenant_storage_settings
    console.log("13. Creating tenant_storage_settings...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_storage_settings (
        id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             varchar NOT NULL UNIQUE,
        default_retention_mode text NOT NULL DEFAULT 'days',
        default_retention_days integer DEFAULT 30,
        allow_forever_storage  boolean NOT NULL DEFAULT false,
        max_storage_bytes      bigint,
        created_at             timestamp NOT NULL DEFAULT NOW(),
        updated_at             timestamp NOT NULL DEFAULT NOW(),
        CONSTRAINT tss_retention_mode_check CHECK (default_retention_mode IN ('session','days','forever'))
      )
    `);

    await client.query("COMMIT");
    console.log("\n✓ Migration completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed — rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
