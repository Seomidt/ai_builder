/**
 * Phase 16 — AI Cost Governance: Database Migration
 *
 * Replaces legacy stub tables (from earlier branches) with Phase 16 schema.
 *
 * Legacy tables had incompatible schemas (tenant_id, different columns).
 * They are dropped and recreated. No production data is affected — these
 * tables contained only empty/stub data from development branches.
 *
 * Tables managed:
 *   tenant_ai_budgets          (was: tenant_id, monthly_budget_usd, soft/hard_limit_percent)
 *   tenant_ai_usage_snapshots  (was: tenant_id, period, tokens_in/out, cost_usd)
 *   ai_usage_alerts            (was: tenant_id, threshold_percent, usage_percent)
 *   ai_anomaly_events          (was: tenant_id, feature, route_key, etc.)
 *
 * Usage:
 *   npx tsx server/lib/ai-governance/migrate-phase16.ts
 */

import pg from "pg";
const { Client } = pg;

async function run(): Promise<void> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();

  console.log("Phase 16 Migration — AI Cost Governance");
  console.log("=========================================");
  console.log("Note: Replacing legacy stub tables from development branches.");

  try {

    // ── 0. Drop legacy tables (CASCADE drops dependent indexes/constraints) ──
    console.log("\n[0/5] Dropping legacy stub tables …");
    const drops = [
      "ai_anomaly_events",
      "ai_usage_alerts",
      "tenant_ai_usage_snapshots",
      "tenant_ai_budgets",
    ];
    for (const t of drops) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE;`);
      console.log(`  Dropped: ${t}`);
    }

    // ── 1. tenant_ai_budgets ──────────────────────────────────────────────────
    console.log("\n[1/4] Creating tenant_ai_budgets …");
    await client.query(`
      CREATE TABLE tenant_ai_budgets (
        id                   TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id      TEXT        NOT NULL,
        period_type          TEXT        NOT NULL DEFAULT 'monthly',
        budget_usd_cents     BIGINT      NOT NULL,
        warning_threshold_pct INTEGER    NOT NULL DEFAULT 80,
        hard_limit_pct       INTEGER     NOT NULL DEFAULT 100,
        is_active            BOOLEAN     NOT NULL DEFAULT true,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT tab16_period_check
          CHECK (period_type IN ('daily', 'weekly', 'monthly', 'annual')),
        CONSTRAINT tab16_threshold_check
          CHECK (warning_threshold_pct > 0
             AND hard_limit_pct        > 0
             AND warning_threshold_pct < hard_limit_pct),
        CONSTRAINT tab16_budget_positive
          CHECK (budget_usd_cents > 0)
      );
    `);
    await client.query(`CREATE INDEX tab16_org_idx ON tenant_ai_budgets (organization_id);`);
    await client.query(`CREATE UNIQUE INDEX tab16_org_period_uq ON tenant_ai_budgets (organization_id, period_type);`);
    console.log("  ✅ tenant_ai_budgets OK");

    // ── 2. tenant_ai_usage_snapshots ──────────────────────────────────────────
    console.log("\n[2/4] Creating tenant_ai_usage_snapshots …");
    await client.query(`
      CREATE TABLE tenant_ai_usage_snapshots (
        id                   TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id      TEXT        NOT NULL,
        period_start         TIMESTAMPTZ NOT NULL,
        period_end           TIMESTAMPTZ NOT NULL,
        period_type          TEXT        NOT NULL,
        total_tokens         BIGINT      NOT NULL DEFAULT 0,
        prompt_tokens        BIGINT      NOT NULL DEFAULT 0,
        completion_tokens    BIGINT      NOT NULL DEFAULT 0,
        total_cost_usd_cents BIGINT      NOT NULL DEFAULT 0,
        request_count        INTEGER     NOT NULL DEFAULT 0,
        failed_request_count INTEGER     NOT NULL DEFAULT 0,
        model_breakdown      JSONB       NOT NULL DEFAULT '{}'::jsonb,
        snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT taus16_period_check
          CHECK (period_end > period_start),
        CONSTRAINT taus16_period_type_check
          CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly')),
        CONSTRAINT taus16_tokens_check
          CHECK (total_tokens >= 0 AND prompt_tokens >= 0 AND completion_tokens >= 0),
        CONSTRAINT taus16_cost_check
          CHECK (total_cost_usd_cents >= 0)
      );
    `);
    await client.query(`CREATE INDEX taus16_org_period_idx ON tenant_ai_usage_snapshots (organization_id, period_start);`);
    await client.query(`CREATE INDEX taus16_type_start_idx ON tenant_ai_usage_snapshots (period_type, period_start);`);
    await client.query(`CREATE INDEX taus16_org_type_start_idx ON tenant_ai_usage_snapshots (organization_id, period_type, period_start);`);
    console.log("  ✅ tenant_ai_usage_snapshots OK");

    // ── 3. ai_usage_alerts ────────────────────────────────────────────────────
    console.log("\n[3/4] Creating ai_usage_alerts …");
    await client.query(`
      CREATE TABLE ai_usage_alerts (
        id                      TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id         TEXT        NOT NULL,
        alert_type              TEXT        NOT NULL,
        severity                TEXT        NOT NULL DEFAULT 'medium',
        status                  TEXT        NOT NULL DEFAULT 'open',
        title                   TEXT        NOT NULL,
        message                 TEXT        NOT NULL,
        threshold_pct           INTEGER,
        current_usage_usd_cents BIGINT,
        budget_usd_cents        BIGINT,
        linked_snapshot_id      TEXT,
        linked_anomaly_id       TEXT,
        metadata                JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_at         TIMESTAMPTZ,
        resolved_at             TIMESTAMPTZ,

        CONSTRAINT aua16_alert_type_check
          CHECK (alert_type IN ('budget_warning', 'budget_exceeded', 'anomaly', 'runaway')),
        CONSTRAINT aua16_severity_check
          CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        CONSTRAINT aua16_status_check
          CHECK (status IN ('open', 'acknowledged', 'resolved', 'suppressed'))
      );
    `);
    await client.query(`CREATE INDEX aua16_org_created_idx ON ai_usage_alerts (organization_id, created_at);`);
    await client.query(`CREATE INDEX aua16_status_severity_idx ON ai_usage_alerts (status, severity);`);
    await client.query(`CREATE INDEX aua16_org_status_idx ON ai_usage_alerts (organization_id, status);`);
    console.log("  ✅ ai_usage_alerts OK");

    // ── 4. ai_anomaly_events ──────────────────────────────────────────────────
    console.log("\n[4/4] Creating ai_anomaly_events …");
    await client.query(`
      CREATE TABLE ai_anomaly_events (
        id               TEXT           PRIMARY KEY DEFAULT gen_random_uuid()::text,
        organization_id  TEXT           NOT NULL,
        anomaly_type     TEXT           NOT NULL,
        detected_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        window_minutes   INTEGER        NOT NULL DEFAULT 60,
        baseline_value   NUMERIC(18,6)  NOT NULL,
        observed_value   NUMERIC(18,6)  NOT NULL,
        deviation_pct    NUMERIC(10,2)  NOT NULL,
        severity         TEXT           NOT NULL DEFAULT 'medium',
        is_confirmed     BOOLEAN        NOT NULL DEFAULT false,
        linked_alert_id  TEXT,
        metadata         JSONB          NOT NULL DEFAULT '{}'::jsonb,

        CONSTRAINT aae16_anomaly_type_check
          CHECK (anomaly_type IN ('cost_spike', 'token_spike', 'request_spike', 'model_drift', 'sudden_stop')),
        CONSTRAINT aae16_severity_check
          CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        CONSTRAINT aae16_deviation_check
          CHECK (deviation_pct >= 0)
      );
    `);
    await client.query(`CREATE INDEX aae16_org_detected_idx ON ai_anomaly_events (organization_id, detected_at);`);
    await client.query(`CREATE INDEX aae16_anomaly_type_idx ON ai_anomaly_events (anomaly_type, detected_at);`);
    await client.query(`CREATE INDEX aae16_org_type_idx ON ai_anomaly_events (organization_id, anomaly_type);`);
    console.log("  ✅ ai_anomaly_events OK");

    // ── 5. gov_anomaly_events ─────────────────────────────────────────────────
    // Used by AI-ops context-assembler and ops-summary (Phase 3+).
    // Created here to ensure it exists before the server queries it.
    console.log("\n[5/6] Creating gov_anomaly_events …");
    await client.query(`DROP TABLE IF EXISTS gov_anomaly_events CASCADE;`);
    await client.query(`
      CREATE TABLE gov_anomaly_events (
        id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id           TEXT        NOT NULL,
        event_type          TEXT        NOT NULL,
        usage_spike_percent NUMERIC(8,2),
        metadata            JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX gae_tenant_created_idx ON gov_anomaly_events (tenant_id, created_at);`);
    await client.query(`CREATE INDEX gae_tenant_type_idx    ON gov_anomaly_events (tenant_id, event_type);`);
    console.log("  ✅ gov_anomaly_events OK");

    // ── 6. RLS ────────────────────────────────────────────────────────────────
    console.log("\n[6/6] Enabling RLS …");
    const rlsTables = [
      "tenant_ai_budgets",
      "tenant_ai_usage_snapshots",
      "ai_usage_alerts",
      "ai_anomaly_events",
      "gov_anomaly_events",
    ];
    for (const t of rlsTables) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      console.log(`  ✅ RLS enabled: ${t}`);
    }

    console.log("\n========================================");
    console.log("✅ Phase 16 migration completed successfully");

  } finally {
    await client.end();
  }
}

run().catch((err: unknown) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
