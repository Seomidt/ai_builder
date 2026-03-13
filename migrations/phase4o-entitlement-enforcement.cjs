"use strict";
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.SUPABASE_DB_POOL_URL });

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Extend ai_billing_usage ───────────────────────────────────────────
    await client.query(`
      ALTER TABLE ai_billing_usage
        ADD COLUMN IF NOT EXISTS entitlement_treatment text NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS included_amount_usd    numeric(14,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS overage_amount_usd     numeric(14,8) NOT NULL DEFAULT 0
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ai_billing_usage_entitlement_treatment_check'
        ) THEN
          ALTER TABLE ai_billing_usage
            ADD CONSTRAINT ai_billing_usage_entitlement_treatment_check
            CHECK (entitlement_treatment IN ('standard','included','partial_included','overage','blocked'));
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_billing_usage_included_amount_check') THEN
          ALTER TABLE ai_billing_usage ADD CONSTRAINT ai_billing_usage_included_amount_check CHECK (included_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_billing_usage_overage_amount_check') THEN
          ALTER TABLE ai_billing_usage ADD CONSTRAINT ai_billing_usage_overage_amount_check CHECK (overage_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ai_billing_usage_entitlement_treatment_idx
        ON ai_billing_usage (entitlement_treatment, created_at)
    `);
    console.log("✓ ai_billing_usage extended (entitlement_treatment, included_amount_usd, overage_amount_usd)");

    // ── 2. Extend storage_billing_usage ──────────────────────────────────────
    // NOTE: included_usage_amount already exists (pricing column). Phase 4O adds:
    //   entitlement_treatment, ent_included_usage_amount, ent_overage_usage_amount,
    //   included_amount_usd, overage_amount_usd
    await client.query(`
      ALTER TABLE storage_billing_usage
        ADD COLUMN IF NOT EXISTS entitlement_treatment      text NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS ent_included_usage_amount  numeric(18,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ent_overage_usage_amount   numeric(18,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS included_amount_usd        numeric(14,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS overage_amount_usd         numeric(14,8) NOT NULL DEFAULT 0
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'storage_billing_entitlement_treatment_check'
        ) THEN
          ALTER TABLE storage_billing_usage
            ADD CONSTRAINT storage_billing_entitlement_treatment_check
            CHECK (entitlement_treatment IN ('standard','included','partial_included','overage','blocked'));
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS storage_billing_entitlement_treatment_idx
        ON storage_billing_usage (entitlement_treatment, created_at)
    `);
    console.log("✓ storage_billing_usage extended (entitlement_treatment + 4 allowance fields)");

    // ── 3. Extend billing_period_tenant_snapshots ────────────────────────────
    await client.query(`
      ALTER TABLE billing_period_tenant_snapshots
        ADD COLUMN IF NOT EXISTS ai_included_amount_usd      numeric(14,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ai_overage_amount_usd       numeric(14,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS storage_included_amount_usd numeric(14,8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS storage_overage_amount_usd  numeric(14,8) NOT NULL DEFAULT 0
    `);
    console.log("✓ billing_period_tenant_snapshots extended (ai/storage included/overage amounts)");

    // ── 4. Create tenant_ai_allowance_usage ──────────────────────────────────
    // Matches schema.ts exactly — no FK constraints; tenant_id/billing_period_id are plain text
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_ai_allowance_usage (
        id                       varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                text NOT NULL,
        billing_period_id        text,
        source_billing_usage_id  varchar NOT NULL,
        included_amount_usd      numeric(14,8) NOT NULL DEFAULT 0,
        overage_amount_usd       numeric(14,8) NOT NULL DEFAULT 0,
        pricing_version          text,
        created_at               timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'taau_included_check') THEN
          ALTER TABLE tenant_ai_allowance_usage ADD CONSTRAINT taau_included_check CHECK (included_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'taau_overage_check') THEN
          ALTER TABLE tenant_ai_allowance_usage ADD CONSTRAINT taau_overage_check CHECK (overage_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS taau_source_billing_usage_id_unique ON tenant_ai_allowance_usage (source_billing_usage_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS taau_tenant_created_idx ON tenant_ai_allowance_usage (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS taau_billing_period_idx ON tenant_ai_allowance_usage (billing_period_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS taau_tenant_period_created_idx ON tenant_ai_allowance_usage (tenant_id, billing_period_id, created_at)`);
    console.log("✓ tenant_ai_allowance_usage created");

    // ── 5. Create tenant_storage_allowance_usage ─────────────────────────────
    // Matches schema.ts exactly — no FK constraints; tenant_id/billing_period_id are plain text
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_storage_allowance_usage (
        id                               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                        text NOT NULL,
        billing_period_id                text,
        source_storage_billing_usage_id  varchar NOT NULL,
        included_usage_amount            numeric(18,8) NOT NULL DEFAULT 0,
        overage_usage_amount             numeric(18,8) NOT NULL DEFAULT 0,
        included_amount_usd              numeric(14,8) NOT NULL DEFAULT 0,
        overage_amount_usd               numeric(14,8) NOT NULL DEFAULT 0,
        pricing_version                  text,
        created_at                       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tsau_included_usage_check') THEN
          ALTER TABLE tenant_storage_allowance_usage ADD CONSTRAINT tsau_included_usage_check CHECK (included_usage_amount >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tsau_overage_usage_check') THEN
          ALTER TABLE tenant_storage_allowance_usage ADD CONSTRAINT tsau_overage_usage_check CHECK (overage_usage_amount >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tsau_included_usd_check') THEN
          ALTER TABLE tenant_storage_allowance_usage ADD CONSTRAINT tsau_included_usd_check CHECK (included_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tsau_overage_usd_check') THEN
          ALTER TABLE tenant_storage_allowance_usage ADD CONSTRAINT tsau_overage_usd_check CHECK (overage_amount_usd >= 0);
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tsau_source_storage_billing_usage_id_unique ON tenant_storage_allowance_usage (source_storage_billing_usage_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tsau_tenant_created_idx ON tenant_storage_allowance_usage (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tsau_billing_period_idx ON tenant_storage_allowance_usage (billing_period_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tsau_tenant_period_created_idx ON tenant_storage_allowance_usage (tenant_id, billing_period_id, created_at)`);
    console.log("✓ tenant_storage_allowance_usage created");

    await client.query("COMMIT");
    console.log("\n✓ Phase 4O migration completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("✗ Migration failed, rolled back:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
