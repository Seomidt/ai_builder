/**
 * PHASE 5Z.7 one-time migration — run once, then delete.
 * Adds new columns to chat_ocr_tasks and creates chat_answer_requests.
 */
import { Client } from "pg";

async function migrate() {
  const url = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No DB URL set");

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 25000,
  });

  await client.connect();
  console.log("Connected to Supabase");

  const sqls: Array<[string, string]> = [
    ["add question_text", `ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS question_text text`],
    ["add partial_ready_written_at", `ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS partial_ready_written_at timestamptz`],
    ["add ocr_chat_trigger_attempted_at", `ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS ocr_chat_trigger_attempted_at timestamptz`],
    ["add ocr_chat_trigger_key", `ALTER TABLE chat_ocr_tasks ADD COLUMN IF NOT EXISTS ocr_chat_trigger_key text`],
    ["create chat_answer_requests", `
      CREATE TABLE IF NOT EXISTS chat_answer_requests (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       varchar NOT NULL,
        task_id         varchar NOT NULL,
        trigger_key     text NOT NULL,
        mode            text NOT NULL DEFAULT 'partial',
        status          text NOT NULL DEFAULT 'pending',
        trigger_reason  text,
        error_code      text,
        error_message   text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        started_at      timestamptz,
        completed_at    timestamptz
      )
    `],
    ["unique index car_task_trigger_uq", `CREATE UNIQUE INDEX IF NOT EXISTS car_task_trigger_uq ON chat_answer_requests(task_id, trigger_key)`],
    ["index car_tenant_idx",            `CREATE INDEX IF NOT EXISTS car_tenant_idx ON chat_answer_requests(tenant_id)`],
    ["index car_task_idx",              `CREATE INDEX IF NOT EXISTS car_task_idx   ON chat_answer_requests(task_id)`],
    ["index car_status_idx",            `CREATE INDEX IF NOT EXISTS car_status_idx ON chat_answer_requests(status)`],
  ];

  for (const [label, sql] of sqls) {
    process.stdout.write(`→ ${label} ... `);
    await client.query(sql);
    process.stdout.write("OK\n");
  }

  await client.end();
  console.log("\nMigration complete ✓");
}

migrate().catch((e: Error) => {
  console.error("Migration FAILED:", e.message);
  process.exit(1);
});
