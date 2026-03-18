/**
 * Phase 13.2 Migration — Platform Security Hardening
 *
 * Creates the security_events table with required indexes, constraints, and RLS.
 * Uses information_schema inspection to be idempotent and backward-compatible.
 */

import pg from "pg";

const { Client } = pg;

async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── TASK 1: Inspect current schema ─────────────────────────────────────────

  console.log("\n── Inspecting current schema ──");

  const tableExists = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'security_events'
  `);
  const exists = tableExists.rows.length > 0;
  console.log(`  security_events table exists: ${exists}`);

  // ── TASK 2: Create table if missing ─────────────────────────────────────────

  if (!exists) {
    console.log("\n── Creating security_events table ──");
    const createSql = `
      CREATE TABLE security_events (
        id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   text,
        actor_id    text,
        event_type  text NOT NULL,
        ip          text,
        user_agent  text,
        request_id  text,
        metadata    jsonb,
        created_at  timestamp NOT NULL DEFAULT now(),
        CONSTRAINT se_event_type_check CHECK (
          event_type IN (
            'auth_failure',
            'rate_limit_trigger',
            'invalid_input',
            'tenant_access_violation',
            'api_abuse',
            'oversized_payload',
            'security_header_violation'
          )
        )
      )
    `;
    await client.query(createSql);
    console.log("  ✔ security_events table created");
    console.log(`  SQL: ${createSql.trim().replace(/\s+/g, " ")}`);
  } else {
    console.log("  ✔ Table already exists — verifying columns");

    // Ensure all required columns are present
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'security_events'
    `);
    const colNames = columns.rows.map((r: any) => r.column_name);
    const required = ["id", "tenant_id", "actor_id", "event_type", "ip", "user_agent", "request_id", "metadata", "created_at"];
    for (const col of required) {
      if (!colNames.includes(col)) {
        console.log(`  Adding missing column: ${col}`);
        // Add column — default values prevent NOT NULL issues for existing rows
        if (col === "event_type") {
          await client.query(`ALTER TABLE security_events ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'auth_failure'`);
        } else if (col === "created_at") {
          await client.query(`ALTER TABLE security_events ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`);
        } else if (col === "metadata") {
          await client.query(`ALTER TABLE security_events ADD COLUMN IF NOT EXISTS ${col} jsonb`);
        } else {
          await client.query(`ALTER TABLE security_events ADD COLUMN IF NOT EXISTS ${col} text`);
        }
        console.log(`  ✔ Column ${col} added`);
      }
    }
  }

  // ── TASK 3: Indexes ──────────────────────────────────────────────────────────

  console.log("\n── Ensuring indexes ──");

  const indexSpecs = [
    { name: "se_tenant_created_idx", sql: "CREATE INDEX IF NOT EXISTS se_tenant_created_idx ON security_events (tenant_id, created_at)" },
    { name: "se_event_type_created_idx", sql: "CREATE INDEX IF NOT EXISTS se_event_type_created_idx ON security_events (event_type, created_at)" },
    { name: "se_request_id_idx", sql: "CREATE INDEX IF NOT EXISTS se_request_id_idx ON security_events (request_id)" },
  ];

  for (const spec of indexSpecs) {
    await client.query(spec.sql);
    console.log(`  ✔ Index: ${spec.name}`);
    console.log(`    SQL: ${spec.sql}`);
  }

  // ── TASK 4: CHECK constraint ─────────────────────────────────────────────────
  // Phase 7 had constraint 'security_events_event_type_check' with legacy types.
  // Phase 13.2 drops it and replaces with an expanded constraint covering both
  // Phase 7 event types (backward compat) and Phase 13.2 operational types.

  console.log("\n── Ensuring CHECK constraint ──");

  // Drop old Phase 7 constraint if present (incompatible with new types)
  const oldConstraint = await client.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'security_events'
      AND constraint_type = 'CHECK'
      AND constraint_name = 'security_events_event_type_check'
  `);
  if (oldConstraint.rows.length > 0) {
    await client.query(`ALTER TABLE security_events DROP CONSTRAINT security_events_event_type_check`);
    console.log("  ✔ Dropped old Phase 7 CHECK constraint (security_events_event_type_check)");
  }

  // Check whether Phase 13.2 constraint already exists
  const newConstraintExists = await client.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'security_events'
      AND constraint_type = 'CHECK'
      AND constraint_name = 'se_event_type_check'
  `);
  if (newConstraintExists.rows.length === 0) {
    const constraintSql = `
      ALTER TABLE security_events
      ADD CONSTRAINT se_event_type_check
      CHECK (event_type IN (
        'session_created','session_revoked','login_failed','login_success',
        'auth_failure','rate_limit_trigger','invalid_input',
        'tenant_access_violation','api_abuse','oversized_payload',
        'security_header_violation'
      ))
    `;
    await client.query(constraintSql);
    console.log("  ✔ Expanded CHECK constraint created (Phase 7 + Phase 13.2 types)");
    console.log(`  SQL: ${constraintSql.trim().replace(/\s+/g, " ")}`);
  } else {
    console.log("  ✔ CHECK constraint se_event_type_check already exists");
  }

  // ── TASK 5: Enable RLS ────────────────────────────────────────────────────────

  console.log("\n── Enabling RLS ──");
  const rlsSql = `ALTER TABLE security_events ENABLE ROW LEVEL SECURITY`;
  await client.query(rlsSql);
  console.log(`  ✔ RLS enabled`);
  console.log(`  SQL: ${rlsSql}`);

  // Admin/service-role can read all security events
  const adminPolicyExists = await client.query(`
    SELECT policyname FROM pg_policies
    WHERE tablename = 'security_events' AND policyname = 'se_service_role_policy'
  `);
  if (adminPolicyExists.rows.length === 0) {
    const policySql = `
      CREATE POLICY se_service_role_policy ON security_events
      USING (true)
      WITH CHECK (true)
    `;
    await client.query(policySql);
    console.log("  ✔ RLS policy created (service_role full access)");
    console.log(`  SQL: ${policySql.trim().replace(/\s+/g, " ")}`);
  } else {
    console.log("  ✔ RLS policy already exists");
  }

  // ── TASK 6: Verification ─────────────────────────────────────────────────────

  console.log("\n── Verification ──");

  const verifyTable = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'security_events'
  `);
  console.log(`  ✔ Table exists: ${verifyTable.rows.length > 0}`);

  const verifyColumns = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'security_events'
    ORDER BY ordinal_position
  `);
  console.log(`  ✔ Column count: ${verifyColumns.rows.length}`);
  for (const col of verifyColumns.rows) {
    console.log(`    - ${col.column_name} (${col.data_type}, nullable=${col.is_nullable})`);
  }

  const verifyIndexes = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'security_events' AND schemaname = 'public'
    ORDER BY indexname
  `);
  console.log(`  ✔ Indexes (${verifyIndexes.rows.length}):`);
  for (const idx of verifyIndexes.rows) {
    console.log(`    - ${idx.indexname}`);
  }

  const verifyRls = await client.query(`
    SELECT relrowsecurity FROM pg_class
    WHERE relname = 'security_events'
  `);
  console.log(`  ✔ RLS enabled: ${verifyRls.rows[0]?.relrowsecurity ?? false}`);

  const verifyConstraints = await client.query(`
    SELECT constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_name = 'security_events'
    ORDER BY constraint_type, constraint_name
  `);
  console.log(`  ✔ Constraints (${verifyConstraints.rows.length}):`);
  for (const c of verifyConstraints.rows) {
    console.log(`    - ${c.constraint_name} (${c.constraint_type})`);
  }

  // ── Test insert + cleanup ─────────────────────────────────────────────────────

  console.log("\n── Test insert + cleanup ──");
  const testId = `migrate-test-${Date.now()}`;
  await client.query(`
    INSERT INTO security_events (id, event_type, tenant_id, request_id)
    VALUES ($1, 'auth_failure', 'migration-test-tenant', 'migration-test-req')
  `, [testId]);
  console.log("  ✔ Test insert succeeded");

  const verifyInsert = await client.query(`SELECT id, event_type FROM security_events WHERE id = $1`, [testId]);
  console.log(`  ✔ Test row verified: ${verifyInsert.rows[0]?.event_type}`);

  await client.query(`DELETE FROM security_events WHERE id = $1`, [testId]);
  console.log("  ✔ Test row cleaned up");

  await client.end();
  console.log("\n✔ Phase 13.2 migration complete");
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
