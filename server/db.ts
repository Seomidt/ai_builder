import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

const connectionString = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("No database connection string found. Set SUPABASE_DB_POOL_URL or DATABASE_URL.");
}

const isSupabase = !!process.env.SUPABASE_DB_POOL_URL;

export const pool = new Pool({
  connectionString,
  ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
});

export const db = drizzle(pool, { schema });

export const dbProvider = isSupabase ? "supabase" : "replit";
