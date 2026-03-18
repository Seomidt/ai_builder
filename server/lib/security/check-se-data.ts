import pg from "pg";
const { Client } = pg;
async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  const r1 = await client.query("SELECT DISTINCT event_type, count(*)::int as n FROM security_events GROUP BY event_type ORDER BY n DESC");
  console.log("Existing event types:", JSON.stringify(r1.rows));
  const r2 = await client.query("SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'security_events' AND constraint_type = 'CHECK'");
  console.log("Existing CHECK constraints:", JSON.stringify(r2.rows));
  const r3 = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'security_events' ORDER BY ordinal_position");
  console.log("Columns:", r3.rows.map((r: any) => r.column_name).join(", "));
  await client.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
