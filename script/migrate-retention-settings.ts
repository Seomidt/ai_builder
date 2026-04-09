/**
 * Migration: Retention Settings Phase 6
 * - Migrates tenant_storage_settings.default_retention_mode from
 *   ('session'|'days'|'forever') → ('days_30'|'days_90'|'forever')
 * - Drops old check constraint, migrates existing rows, adds new constraint
 * - Removes default_retention_days column (now baked into mode)
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

    // 1. Drop old check constraint (idempotent via DO block)
    console.log("1. Dropping old tss_retention_mode_check constraint...");
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'tss_retention_mode_check'
            AND table_name = 'tenant_storage_settings'
        ) THEN
          ALTER TABLE tenant_storage_settings
            DROP CONSTRAINT tss_retention_mode_check;
        END IF;
      END $$
    `);

    // 2. Migrate existing rows: session → days_30, days → days_30
    console.log("2. Migrating existing retention mode values...");
    await client.query(`
      UPDATE tenant_storage_settings
      SET default_retention_mode = 'days_30'
      WHERE default_retention_mode IN ('session', 'days')
    `);

    // 3. Update column default
    console.log("3. Updating column default to days_30...");
    await client.query(`
      ALTER TABLE tenant_storage_settings
        ALTER COLUMN default_retention_mode SET DEFAULT 'days_30'
    `);

    // 4. Add new check constraint
    console.log("4. Adding new tss_retention_mode_check constraint...");
    await client.query(`
      ALTER TABLE tenant_storage_settings
        ADD CONSTRAINT tss_retention_mode_check
        CHECK (default_retention_mode IN ('days_30','days_90','forever'))
    `);

    // 5. Set allow_forever_storage default to true (backwards compat)
    console.log("5. Setting allow_forever_storage default to true...");
    await client.query(`
      ALTER TABLE tenant_storage_settings
        ALTER COLUMN allow_forever_storage SET DEFAULT true
    `);

    await client.query("COMMIT");
    console.log("\n✓ Retention settings migration completed successfully.");
    console.log("  default_retention_mode now accepts: days_30 | days_90 | forever");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed — rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
