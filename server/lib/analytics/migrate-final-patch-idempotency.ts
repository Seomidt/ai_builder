/**
 * Final Patch — Analytics Idempotency Partial Index
 *
 * Replaces any existing unique index on analytics_events.idempotency_key
 * with the canonical PARTIAL UNIQUE INDEX:
 *   CREATE UNIQUE INDEX analytics_events_idem_idx
 *   ON analytics_events (idempotency_key)
 *   WHERE idempotency_key IS NOT NULL;
 *
 * This ensures:
 *  - duplicate idempotency_key values are rejected
 *  - NULL values are allowed multiple times
 *  - correct deduplication semantics
 */

import pg from "pg";

const { Client } = pg;

async function migrate(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  console.log("[migrate-final-patch-idem] Connected to database");

  try {
    await client.query("BEGIN");

    // Drop all prior idempotency indexes (full or partial) to start clean
    await client.query(`DROP INDEX IF EXISTS analytics_events_idempotency_key_idx;`);
    console.log("[migrate-final-patch-idem] Dropped analytics_events_idempotency_key_idx (if existed)");

    await client.query(`DROP INDEX IF EXISTS analytics_events_idem_idx;`);
    console.log("[migrate-final-patch-idem] Dropped analytics_events_idem_idx (if existed)");

    await client.query(`DROP INDEX IF EXISTS ae50_idempotency_key_uq;`);
    console.log("[migrate-final-patch-idem] Dropped ae50_idempotency_key_uq (if existed)");

    // Create canonical partial unique index per spec
    await client.query(`
      CREATE UNIQUE INDEX analytics_events_idem_idx
        ON analytics_events (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    console.log("[migrate-final-patch-idem] Created analytics_events_idem_idx (partial WHERE NOT NULL)");

    await client.query("COMMIT");
    console.log("[migrate-final-patch-idem] Migration committed successfully");

    // Verification
    const { rows } = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'analytics_events'
        AND indexname = 'analytics_events_idem_idx';
    `);

    if (rows.length === 0) {
      throw new Error("Verification failed: analytics_events_idem_idx not found after migration");
    }

    const def: string = rows[0].indexdef ?? "";
    const hasPartialClause = def.includes("idempotency_key IS NOT NULL");
    if (!hasPartialClause) {
      throw new Error(`Verification failed: index does not have WHERE clause. Got: ${def}`);
    }

    console.log("[migrate-final-patch-idem] Verification OK — partial index confirmed:");
    console.log("  indexname:", rows[0].indexname);
    console.log("  indexdef:", rows[0].indexdef);

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[migrate-final-patch-idem] Migration failed — rolled back:", err);
    throw err;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
