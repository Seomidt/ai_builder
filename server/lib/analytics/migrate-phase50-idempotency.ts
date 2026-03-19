/**
 * Final Hardening Closeout — Analytics Idempotency Migration
 *
 * Adds idempotency_key column + unique index to analytics_events.
 * Safe to run multiple times (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 */

import pg from "pg";

const { Client } = pg;

async function migrate(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  console.log("[migrate-idempotency] Connected to database");

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE analytics_events
        ADD COLUMN IF NOT EXISTS idempotency_key text;
    `);
    console.log("[migrate-idempotency] idempotency_key column: OK");

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ae50_idempotency_key_uq
        ON analytics_events (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    console.log("[migrate-idempotency] unique index on idempotency_key: OK");

    await client.query("COMMIT");
    console.log("[migrate-idempotency] Migration committed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate-idempotency] Migration failed — rolled back:", err);
    throw err;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
