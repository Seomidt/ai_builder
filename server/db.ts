import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getConnectionString(): string {
  const cs = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      "No database connection string found. Set SUPABASE_DB_POOL_URL or DATABASE_URL.",
    );
  }
  return cs;
}

function initPool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = getConnectionString();
  const isSupabase = !!process.env.SUPABASE_DB_POOL_URL;
  _pool = new Pool({
    connectionString,
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
    // ── Connection pool tuning ──────────────────────────────────────────────
    // max: 5 — Supabase PgBouncer transaction mode works best with few clients.
    //           Default 10 can exhaust the pooler's server_pool_size.
    max: 5,
    // connectionTimeoutMillis: 10s — fail fast instead of hanging indefinitely
    // (default is 0 = no timeout, which causes 30s+ hangs on cold DB connections).
    connectionTimeoutMillis: 10_000,
    // idleTimeoutMillis: 60s — keep connections alive longer to survive brief
    // idle periods (default 10s closes them too aggressively for Supabase).
    idleTimeoutMillis: 60_000,
  });
  return _pool;
}

// Pre-warm the DB connection pool immediately at module import time.
// This fires a lightweight SELECT 1 as soon as the pool is created.
// Goal: have at least one live connection ready before the first user request arrives.
// Does NOT block the server from starting — warmup runs in background.
// On Vercel cold starts: warms up during Lambda initialisation so the first
// user request finds a live connection instead of waiting for TCP+SSL+auth.
export async function warmupPool(): Promise<void> {
  const t0 = Date.now();
  try {
    await initPool().query("SELECT 1");
    console.log(`[db] pool warmed up in ${Date.now() - t0}ms`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db] pool warmup failed (${Date.now() - t0}ms): ${msg}`);
  }
}

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_t, prop) {
    return (initPool() as any)[prop];
  },
});

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_t, prop) {
    if (!_db) {
      _db = drizzle(initPool(), { schema });
    }
    return (_db as any)[prop];
  },
});

export const dbProvider = process.env.SUPABASE_DB_POOL_URL ? "supabase" : "replit";
