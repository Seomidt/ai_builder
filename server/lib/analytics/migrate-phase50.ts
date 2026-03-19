/**
 * Phase 50 — Analytics Foundation
 * Database Migration
 *
 * Creates analytics_events and analytics_daily_rollups tables.
 * Uses a single pg.Client via SUPABASE_DB_POOL_URL.
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 */

import pg from "pg";

const { Client } = pg;

async function migrate(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  console.log("[migrate-phase50] Connected to database");

  try {
    await client.query("BEGIN");

    // ─── analytics_events ──────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id              text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id text,
        actor_user_id   text,
        client_id       text,
        event_name      text        NOT NULL,
        event_family    text        NOT NULL,
        source          text        NOT NULL,
        domain_role     text,
        locale          text,
        occurred_at     timestamptz NOT NULL DEFAULT now(),
        session_id      text,
        request_id      text,
        properties      jsonb       NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT ae50_source_check
          CHECK (source IN ('client', 'server', 'system')),
        CONSTRAINT ae50_domain_role_check
          CHECK (domain_role IS NULL OR domain_role IN ('public', 'app', 'admin')),
        CONSTRAINT ae50_family_check
          CHECK (event_family IN ('product', 'funnel', 'retention', 'billing', 'ai', 'ops'))
      );
    `);
    console.log("[migrate-phase50] analytics_events: OK");

    await client.query(`CREATE INDEX IF NOT EXISTS ae50_org_occurred_idx      ON analytics_events (organization_id, occurred_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae50_family_occurred_idx   ON analytics_events (event_family, occurred_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae50_name_occurred_idx     ON analytics_events (event_name, occurred_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae50_org_name_occurred_idx ON analytics_events (organization_id, event_name, occurred_at DESC);`);
    console.log("[migrate-phase50] analytics_events indexes: OK");

    // ─── Enable RLS ────────────────────────────────────────────────────────────

    await client.query(`ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;`);
    console.log("[migrate-phase50] analytics_events RLS: enabled (service_role_only)");

    // ─── analytics_daily_rollups ───────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
        id                  text   PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id     text,
        event_family        text   NOT NULL,
        event_name          text   NOT NULL,
        date                date   NOT NULL,
        event_count         bigint NOT NULL DEFAULT 0,
        unique_users        bigint NOT NULL DEFAULT 0,
        properties_summary  jsonb  NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT adr50_family_check
          CHECK (event_family IN ('product', 'funnel', 'retention', 'billing', 'ai', 'ops'))
      );
    `);
    console.log("[migrate-phase50] analytics_daily_rollups: OK");

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS adr50_uq_date_family_name
        ON analytics_daily_rollups (date, event_family, event_name)
        WHERE organization_id IS NULL;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS adr50_date_family_name_idx ON analytics_daily_rollups (date, event_family, event_name);`);
    await client.query(`CREATE INDEX IF NOT EXISTS adr50_org_date_name_idx    ON analytics_daily_rollups (organization_id, date, event_name);`);
    console.log("[migrate-phase50] analytics_daily_rollups indexes: OK");

    await client.query(`ALTER TABLE analytics_daily_rollups ENABLE ROW LEVEL SECURITY;`);
    console.log("[migrate-phase50] analytics_daily_rollups RLS: enabled (service_role_only)");

    await client.query("COMMIT");
    console.log("[migrate-phase50] Migration committed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate-phase50] Migration failed — rolled back:", err);
    throw err;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
