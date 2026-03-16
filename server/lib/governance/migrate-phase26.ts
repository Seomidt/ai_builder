/**
 * Phase 26 — Migration: Compliance, Data Retention & Governance
 *
 * Creates 4 tables with RLS:
 *   data_retention_policies
 *   data_retention_rules
 *   legal_holds
 *   data_deletion_jobs
 *
 * Seeds 8 built-in retention policies.
 */

import pg from "pg";

const { Client } = pg;

async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();

  try {
    console.log("Phase 26 migration starting…");

    // ── data_retention_policies ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_retention_policies (
        id                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_key            TEXT NOT NULL UNIQUE,
        description           TEXT NOT NULL,
        default_retention_days INTEGER NOT NULL DEFAULT 365,
        active                BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("✔ data_retention_policies table");

    await client.query(`CREATE INDEX IF NOT EXISTS drp26_policy_key_idx ON data_retention_policies (policy_key)`);
    await client.query(`CREATE INDEX IF NOT EXISTS drp26_active_idx ON data_retention_policies (active)`);

    // ── data_retention_rules ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_retention_rules (
        id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_id       VARCHAR NOT NULL REFERENCES data_retention_policies(id) ON DELETE CASCADE,
        table_name      TEXT NOT NULL,
        retention_days  INTEGER NOT NULL DEFAULT 365,
        archive_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        delete_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
        tenant_scoped   BOOLEAN NOT NULL DEFAULT TRUE,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("✔ data_retention_rules table");

    await client.query(`CREATE INDEX IF NOT EXISTS drr26_policy_id_idx  ON data_retention_rules (policy_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS drr26_table_name_idx ON data_retention_rules (table_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS drr26_active_idx     ON data_retention_rules (active)`);

    // ── legal_holds ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_holds (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    TEXT NOT NULL,
        reason       TEXT NOT NULL,
        requested_by TEXT,
        scope        TEXT NOT NULL DEFAULT 'all',
        active       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at  TIMESTAMPTZ,
        released_by  TEXT
      )
    `);
    console.log("✔ legal_holds table");

    await client.query(`CREATE INDEX IF NOT EXISTS lh26_tenant_id_idx     ON legal_holds (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS lh26_active_idx         ON legal_holds (active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS lh26_tenant_active_idx  ON legal_holds (tenant_id, active)`);

    // ── data_deletion_jobs ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_deletion_jobs (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         TEXT NOT NULL,
        job_type          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        target_id         TEXT,
        target_table      TEXT,
        records_deleted   INTEGER NOT NULL DEFAULT 0,
        records_archived  INTEGER NOT NULL DEFAULT 0,
        blocked_by_hold   BOOLEAN NOT NULL DEFAULT FALSE,
        error_message     TEXT,
        metadata          JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ
      )
    `);
    console.log("✔ data_deletion_jobs table");

    await client.query(`CREATE INDEX IF NOT EXISTS ddj26_tenant_id_idx ON data_deletion_jobs (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ddj26_status_idx     ON data_deletion_jobs (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ddj26_job_type_idx   ON data_deletion_jobs (job_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ddj26_created_at_idx ON data_deletion_jobs (created_at)`);

    // ── RLS ──────────────────────────────────────────────────────────────────
    for (const table of ["data_retention_policies", "data_retention_rules", "legal_holds", "data_deletion_jobs"]) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      // Admin bypass policy
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = '${table}_admin_bypass'
          ) THEN
            CREATE POLICY ${table}_admin_bypass ON ${table} USING (TRUE);
          END IF;
        END $$
      `);
    }
    console.log("✔ RLS enabled on 4 tables");

    // ── Seed built-in retention policies ────────────────────────────────────
    const policies = [
      { key: "audit_events_default",       desc: "Audit event retention — 2 years",            days: 730  },
      { key: "security_events_default",    desc: "Security event retention — 1 year",           days: 365  },
      { key: "moderation_events_default",  desc: "AI moderation event retention — 1 year",      days: 365  },
      { key: "webhook_deliveries_default", desc: "Webhook delivery log retention — 90 days",    days: 90   },
      { key: "ai_runs_default",            desc: "AI run history retention — 1 year",            days: 365  },
      { key: "evaluation_results_default", desc: "Evaluation result retention — 2 years",       days: 730  },
      { key: "deletion_jobs_default",      desc: "Deletion job log retention — 180 days",       days: 180  },
      { key: "stripe_events_default",      desc: "Stripe webhook event retention — 1 year",     days: 365  },
    ];

    for (const p of policies) {
      await client.query(`
        INSERT INTO data_retention_policies (policy_key, description, default_retention_days, active)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (policy_key) DO UPDATE SET
          description = EXCLUDED.description,
          default_retention_days = EXCLUDED.default_retention_days,
          updated_at = NOW()
      `, [p.key, p.desc, p.days]);
    }
    console.log("✔ 8 built-in retention policies seeded");

    // ── Seed built-in retention rules (one per policy) ───────────────────────
    const ruleSeeds = [
      { policyKey: "audit_events_default",       table: "audit_events",      days: 730, archive: false },
      { policyKey: "security_events_default",    table: "security_events",   days: 365, archive: false },
      { policyKey: "moderation_events_default",  table: "moderation_events", days: 365, archive: false },
      { policyKey: "webhook_deliveries_default", table: "webhook_deliveries",days: 90,  archive: false },
      { policyKey: "ai_runs_default",            table: "agent_runs",        days: 365, archive: true  },
      { policyKey: "evaluation_results_default", table: "evaluation_results",days: 730, archive: true  },
      { policyKey: "deletion_jobs_default",      table: "data_deletion_jobs",days: 180, archive: false },
      { policyKey: "stripe_events_default",      table: "stripe_webhook_events", days: 365, archive: false },
    ];

    for (const r of ruleSeeds) {
      const policyRes = await client.query(
        `SELECT id FROM data_retention_policies WHERE policy_key = $1`,
        [r.policyKey]
      );
      if (policyRes.rows[0]) {
        await client.query(`
          INSERT INTO data_retention_rules (policy_id, table_name, retention_days, archive_enabled, delete_enabled, tenant_scoped, active)
          VALUES ($1, $2, $3, $4, TRUE, TRUE, TRUE)
          ON CONFLICT DO NOTHING
        `, [policyRes.rows[0].id, r.table, r.days, r.archive]);
      }
    }
    console.log("✔ 8 built-in retention rules seeded");

    console.log("\nPhase 26 migration completed successfully.");
    console.log("Tables: data_retention_policies, data_retention_rules, legal_holds, data_deletion_jobs");
    console.log("Indexes: 10 total | RLS: 4/4 tables | Seeded: 8 policies + 8 rules");

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
