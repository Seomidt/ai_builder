/**
 * Phase 22 — DB Migration
 * Stripe Billing Integration
 *
 * Run: npx tsx server/lib/stripe/migrate-phase22.ts
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL required");

const ok  = (msg: string) => console.log(`  ✔ ${msg}`);
const sec = (msg: string) => console.log(`\n── ${msg} ──`);

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  ok("Connected to Supabase Postgres");

  // ── stripe_customers ──────────────────────────────────────────────────────
  sec("stripe_customers");
  await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_customers (
      id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id           TEXT NOT NULL UNIQUE,
      stripe_customer_id  TEXT NOT NULL UNIQUE,
      email               TEXT,
      metadata            JSONB,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("stripe_customers ready");

  // ── stripe_subscriptions ──────────────────────────────────────────────────
  sec("stripe_subscriptions");
  await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_subscriptions (
      id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                TEXT NOT NULL,
      stripe_subscription_id   TEXT NOT NULL UNIQUE,
      stripe_customer_id       TEXT NOT NULL,
      plan_key                 TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'active',
      current_period_start     TIMESTAMP,
      current_period_end       TIMESTAMP,
      cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
      canceled_at              TIMESTAMP,
      metadata                 JSONB,
      created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("stripe_subscriptions ready");

  // ── stripe_invoices ───────────────────────────────────────────────────────
  sec("stripe_invoices");
  await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_invoices (
      id                     VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      stripe_invoice_id      TEXT NOT NULL UNIQUE,
      tenant_id              TEXT NOT NULL,
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      amount                 INTEGER NOT NULL DEFAULT 0,
      currency               TEXT NOT NULL DEFAULT 'usd',
      status                 TEXT NOT NULL DEFAULT 'draft',
      payment_attempts       INTEGER NOT NULL DEFAULT 0,
      last_payment_error     TEXT,
      issued_at              TIMESTAMP,
      paid_at                TIMESTAMP,
      metadata               JSONB,
      created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("stripe_invoices ready");

  // ── stripe_webhook_events (idempotency log) ───────────────────────────────
  sec("stripe_webhook_events");
  await client.query(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      stripe_event_id  TEXT NOT NULL UNIQUE,
      event_type       TEXT NOT NULL,
      tenant_id        TEXT,
      status           TEXT NOT NULL DEFAULT 'processed',
      processed_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      error            TEXT
    )
  `);
  ok("stripe_webhook_events ready");

  // ── Indexes ───────────────────────────────────────────────────────────────
  sec("Indexes");
  const indexes = [
    "CREATE INDEX IF NOT EXISTS sc22_tenant_id_idx    ON stripe_customers (tenant_id)",
    "CREATE INDEX IF NOT EXISTS sc22_stripe_cid_idx   ON stripe_customers (stripe_customer_id)",
    "CREATE INDEX IF NOT EXISTS ss22_tenant_id_idx    ON stripe_subscriptions (tenant_id)",
    "CREATE INDEX IF NOT EXISTS ss22_stripe_sub_id_idx ON stripe_subscriptions (stripe_subscription_id)",
    "CREATE INDEX IF NOT EXISTS ss22_status_idx       ON stripe_subscriptions (status)",
    "CREATE INDEX IF NOT EXISTS si22_tenant_id_idx    ON stripe_invoices (tenant_id)",
    "CREATE INDEX IF NOT EXISTS si22_stripe_inv_id_idx ON stripe_invoices (stripe_invoice_id)",
    "CREATE INDEX IF NOT EXISTS si22_status_idx       ON stripe_invoices (status)",
    "CREATE INDEX IF NOT EXISTS swe22_event_id_idx    ON stripe_webhook_events (stripe_event_id)",
    "CREATE INDEX IF NOT EXISTS swe22_tenant_type_idx ON stripe_webhook_events (tenant_id, event_type)",
  ];
  for (const sql of indexes) {
    await client.query(sql);
    ok(`Index: ${sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1]}`);
  }

  // ── RLS ──────────────────────────────────────────────────────────────────
  sec("Enabling RLS");
  const rlsTables = ["stripe_customers", "stripe_subscriptions", "stripe_invoices", "stripe_webhook_events"];
  for (const t of rlsTables) {
    await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    ok(`RLS enabled: ${t}`);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  sec("Verification");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
    ORDER BY table_name
  `);
  ok(`Tables verified: ${tableCheck.rows.length}/4`);
  tableCheck.rows.forEach((r: Record<string, unknown>) => ok(`  - ${r.table_name}`));

  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
  `);
  ok(`Indexes: ${idxCheck.rows[0].cnt} found`);

  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
      AND rowsecurity = true
  `);
  ok(`RLS enabled (${rlsCheck.rows[0].cnt}/4 tables)`);

  await client.end();
  console.log("\n✔ Phase 22 migration complete");
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
