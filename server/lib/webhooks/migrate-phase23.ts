/**
 * Phase 23 — Migration: Webhook & Integration Platform
 * Tables: webhook_endpoints, webhook_subscriptions, webhook_deliveries
 * RLS: 3/3
 * Indexes: 8
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL!;

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Phase 23 Migration — Webhook & Integration Platform");

  try {
    // ── webhook_endpoints ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL,
        url         TEXT NOT NULL,
        secret      TEXT NOT NULL,
        description TEXT,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        max_retries INTEGER NOT NULL DEFAULT 3,
        timeout_ms  INTEGER NOT NULL DEFAULT 10000,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ webhook_endpoints created");

    // ── webhook_subscriptions ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id VARCHAR NOT NULL,
        tenant_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ webhook_subscriptions created");

    // ── webhook_deliveries ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id         VARCHAR NOT NULL,
        tenant_id           TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        payload             JSONB NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        attempts            INTEGER NOT NULL DEFAULT 0,
        max_attempts        INTEGER NOT NULL DEFAULT 3,
        last_attempt_at     TIMESTAMPTZ,
        next_retry_at       TIMESTAMPTZ,
        delivered_at        TIMESTAMPTZ,
        http_status_code    INTEGER,
        last_error          TEXT,
        delivery_latency_ms INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ webhook_deliveries created");

    // ── Indexes ────────────────────────────────────────────────────────────────
    const indexes = [
      `CREATE INDEX IF NOT EXISTS we23_tenant_id_idx     ON webhook_endpoints (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS we23_active_idx        ON webhook_endpoints (tenant_id, active)`,
      `CREATE INDEX IF NOT EXISTS ws23_endpoint_id_idx   ON webhook_subscriptions (endpoint_id)`,
      `CREATE INDEX IF NOT EXISTS ws23_tenant_event_idx  ON webhook_subscriptions (tenant_id, event_type)`,
      `CREATE INDEX IF NOT EXISTS wd23_endpoint_id_idx   ON webhook_deliveries (endpoint_id)`,
      `CREATE INDEX IF NOT EXISTS wd23_tenant_status_idx ON webhook_deliveries (tenant_id, status)`,
      `CREATE INDEX IF NOT EXISTS wd23_event_type_idx    ON webhook_deliveries (event_type)`,
      `CREATE INDEX IF NOT EXISTS wd23_next_retry_idx    ON webhook_deliveries (next_retry_at)`,
    ];
    for (const idx of indexes) {
      await client.query(idx);
    }
    console.log(`  ✔ ${indexes.length} indexes created`);

    // ── RLS: Enable and add policies ───────────────────────────────────────────
    for (const table of ["webhook_endpoints", "webhook_subscriptions", "webhook_deliveries"]) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation ON ${table};
        CREATE POLICY tenant_isolation ON ${table}
          USING (tenant_id = current_setting('app.tenant_id', TRUE))
      `);
    }
    console.log("  ✔ RLS enabled on 3/3 tables");

    // ── Verify ─────────────────────────────────────────────────────────────────
    const verify = await client.query(`
      SELECT relname AS table_name, relrowsecurity AS row_security
      FROM pg_class
      WHERE relname IN ('webhook_endpoints','webhook_subscriptions','webhook_deliveries')
      ORDER BY relname
    `);
    console.log("\n  Tables created with RLS:");
    for (const row of verify.rows) {
      console.log(`    ${row.table_name}: RLS=${row.row_security}`);
    }

    const idxCount = await client.query(`
      SELECT COUNT(*) AS cnt FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE '%23%'
    `);
    console.log(`  Total Phase 23 indexes: ${idxCount.rows[0].cnt}`);

    console.log("\nPhase 23 migration complete ✔");
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
