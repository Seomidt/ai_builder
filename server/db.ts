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
  });
  return _pool;
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
