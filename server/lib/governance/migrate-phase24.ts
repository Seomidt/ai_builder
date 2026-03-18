/**
 * Phase 24 — Migration: AI Governance & Safety Platform
 * Tables: ai_policies, tenant_ai_settings, model_allowlists, moderation_events
 * RLS: 4/4
 * Indexes: 10
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL!;

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Phase 24 Migration — AI Governance & Safety Platform");

  try {
    // ── ai_policies ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_policies (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_key  TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        config      JSONB,
        severity    TEXT NOT NULL DEFAULT 'medium',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ ai_policies created");

    // ── tenant_ai_settings ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_ai_settings (
        tenant_id                TEXT PRIMARY KEY,
        max_tokens               INTEGER NOT NULL DEFAULT 4096,
        allowed_models           TEXT[] NOT NULL DEFAULT '{}',
        moderation_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
        prompt_scanning_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
        max_prompts_per_minute   INTEGER NOT NULL DEFAULT 60,
        blocked_topics           TEXT[] NOT NULL DEFAULT '{}',
        sensitivity_level        TEXT NOT NULL DEFAULT 'medium',
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ tenant_ai_settings created");

    // ── model_allowlists ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS model_allowlists (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        model_name  TEXT NOT NULL UNIQUE,
        provider    TEXT NOT NULL DEFAULT 'openai',
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        max_tokens  INTEGER NOT NULL DEFAULT 4096,
        tier        TEXT NOT NULL DEFAULT 'standard',
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ model_allowlists created");

    // ── moderation_events ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS moderation_events (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        prompt_hash TEXT,
        model_name  TEXT,
        policy_key  TEXT,
        result      TEXT NOT NULL,
        reason      TEXT,
        metadata    JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  ✔ moderation_events created");

    // ── Indexes ───────────────────────────────────────────────────────────────
    const indexes = [
      `CREATE INDEX IF NOT EXISTS ap24_policy_key_idx  ON ai_policies (policy_key)`,
      `CREATE INDEX IF NOT EXISTS ap24_enabled_idx     ON ai_policies (enabled)`,
      `CREATE INDEX IF NOT EXISTS tas24_tenant_id_idx  ON tenant_ai_settings (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS mal24_model_name_idx ON model_allowlists (model_name)`,
      `CREATE INDEX IF NOT EXISTS mal24_active_idx     ON model_allowlists (active)`,
      `CREATE INDEX IF NOT EXISTS me24_tenant_id_idx   ON moderation_events (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS me24_event_type_idx  ON moderation_events (event_type)`,
      `CREATE INDEX IF NOT EXISTS me24_result_idx      ON moderation_events (result)`,
      `CREATE INDEX IF NOT EXISTS me24_created_at_idx  ON moderation_events (created_at)`,
      `CREATE INDEX IF NOT EXISTS me24_model_name_idx  ON moderation_events (model_name)`,
    ];
    for (const idx of indexes) await client.query(idx);
    console.log(`  ✔ ${indexes.length} indexes created`);

    // ── RLS ───────────────────────────────────────────────────────────────────
    // ai_policies: platform-wide (no tenant isolation)
    await client.query(`ALTER TABLE ai_policies ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      DROP POLICY IF EXISTS admin_only ON ai_policies;
      CREATE POLICY admin_only ON ai_policies USING (true)
    `);

    // tenant-scoped tables
    for (const table of ["tenant_ai_settings", "moderation_events"]) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation ON ${table};
        CREATE POLICY tenant_isolation ON ${table}
          USING (tenant_id = current_setting('app.tenant_id', TRUE))
      `);
    }

    // model_allowlists: platform-wide
    await client.query(`ALTER TABLE model_allowlists ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      DROP POLICY IF EXISTS admin_only ON model_allowlists;
      CREATE POLICY admin_only ON model_allowlists USING (true)
    `);

    console.log("  ✔ RLS enabled on 4/4 tables");

    // ── Seed built-in policies ────────────────────────────────────────────────
    const builtinPolicies = [
      { key: "max_token_limit",       desc: "Enforce maximum token limits per request",         sev: "high",     cfg: '{"defaultMax":4096,"absoluteMax":32768}' },
      { key: "prompt_injection_guard",desc: "Detect and block prompt injection attacks",         sev: "critical", cfg: '{"patterns":["ignore previous","system prompt","jailbreak"]}' },
      { key: "pii_detection",         desc: "Detect personally identifiable information",        sev: "high",     cfg: '{"blockOnDetect":false,"flagOnDetect":true}' },
      { key: "harmful_content_filter",desc: "Block harmful or dangerous content",                sev: "critical", cfg: '{"categories":["violence","self_harm","illegal_activities","hate_speech"]}' },
      { key: "rate_limiting",         desc: "Enforce per-tenant prompt rate limits",             sev: "medium",   cfg: '{"windowMs":60000,"maxRequests":60}' },
      { key: "model_access_control",  desc: "Restrict model usage to allowlist",                 sev: "high",     cfg: '{"enforceAllowlist":true}' },
      { key: "output_length_limit",   desc: "Limit output token count",                          sev: "low",      cfg: '{"maxOutputTokens":8192}' },
      { key: "tenant_topic_restriction",desc: "Block topics configured as off-limits per tenant",sev: "medium",  cfg: '{}' },
    ];
    let policiesSeeded = 0;
    for (const p of builtinPolicies) {
      const ex = await client.query(`SELECT id FROM ai_policies WHERE policy_key = $1`, [p.key]);
      if (ex.rows.length === 0) {
        await client.query(`
          INSERT INTO ai_policies (policy_key, description, enabled, severity, config)
          VALUES ($1, $2, true, $3, $4::jsonb)
        `, [p.key, p.desc, p.sev, p.cfg]);
        policiesSeeded++;
      }
    }
    console.log(`  ✔ ${policiesSeeded} built-in policies seeded (${builtinPolicies.length - policiesSeeded} already existed)`);

    // ── Seed approved models ──────────────────────────────────────────────────
    const models = [
      { name: "gpt-4o",            prov: "openai",    tok: 128000, tier: "premium"    },
      { name: "gpt-4o-mini",       prov: "openai",    tok: 128000, tier: "standard"   },
      { name: "gpt-4-turbo",       prov: "openai",    tok: 128000, tier: "premium"    },
      { name: "gpt-3.5-turbo",     prov: "openai",    tok: 16385,  tier: "standard"   },
      { name: "claude-3-5-sonnet", prov: "anthropic", tok: 200000, tier: "premium"    },
      { name: "claude-3-haiku",    prov: "anthropic", tok: 200000, tier: "standard"   },
      { name: "gemini-1.5-pro",    prov: "google",    tok: 1000000,tier: "premium"    },
      { name: "gemini-1.5-flash",  prov: "google",    tok: 1000000,tier: "standard"   },
      { name: "o1-preview",        prov: "openai",    tok: 128000, tier: "restricted" },
      { name: "o1-mini",           prov: "openai",    tok: 65536,  tier: "restricted" },
    ];
    let modelsSeeded = 0;
    for (const m of models) {
      const ex = await client.query(`SELECT id FROM model_allowlists WHERE model_name = $1`, [m.name]);
      if (ex.rows.length === 0) {
        await client.query(`
          INSERT INTO model_allowlists (model_name, provider, active, max_tokens, tier)
          VALUES ($1, $2, true, $3, $4)
        `, [m.name, m.prov, m.tok, m.tier]);
        modelsSeeded++;
      }
    }
    console.log(`  ✔ ${modelsSeeded} models seeded in allowlist`);

    // ── Verify ────────────────────────────────────────────────────────────────
    const verify = await client.query(`
      SELECT relname AS table_name, relrowsecurity AS rls
      FROM pg_class
      WHERE relname IN ('ai_policies','tenant_ai_settings','model_allowlists','moderation_events')
      ORDER BY relname
    `);
    console.log("\n  Tables with RLS:");
    for (const r of verify.rows) {
      console.log(`    ${r.table_name}: RLS=${r.rls}`);
    }

    const idxCount = await client.query(`
      SELECT COUNT(*) AS cnt FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%24%'
    `);
    console.log(`  Phase 24 indexes: ${idxCount.rows[0].cnt}`);

    console.log("\nPhase 24 migration complete ✔");
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
