/**
 * ── DB Module — NON-RUNTIME (auth middleware + background jobs only) ──────────
 *
 * This module exports a Drizzle ORM client backed by pg.Pool.
 *
 * RUNTIME ACCESS RULE (Phase DB-Hardening):
 *   DO NOT import `db` or `pool` in runtime request handlers or storage layers.
 *   Runtime data access must use createStorageForRequest(req) from storage.ts,
 *   which uses Supabase PostgREST (HTTP) — connectionless, serverless-safe.
 *
 * Permitted callers:
 *   • server/middleware/auth.ts — membership lookup (30s cache, NOT hot path)
 *   • server/lib/ai-governance/* — admin governance services (admin-only endpoints)
 *   • server/lib/ai-governance/migrate-phase16.ts — migration script (D: script)
 *   • server/lib/ai-governance/validate-phase16.ts — validation script (D: script)
 *   • server/services/run-executor.service.ts — async background job (C: internal)
 *   • server/repositories/* — used by run-executor and legacy DatabaseStorage only
 *   • server/scripts/* — one-time maintenance/migration scripts
 *
 * Forbidden callers:
 *   • Any runtime HTTP route handler
 *   • server/storage.ts (SupabaseStorage path)
 *   • Any new feature — use createStorageForRequest() instead
 *
 * No warmupPool(), no pool tuning hacks, no startup SELECT 1.
 * The auth middleware's membership lookup uses a 30-second in-memory cache
 * (memberCache) so the pg.Pool is only hit on first request per user per 30s.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import * as fs from "fs";
import * as path from "path";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getConnectionString(): string {
  // BLISSOPS_PG_URL is our private name — immune to Vercel's Supabase integration
  // overriding SUPABASE_DB_POOL_URL with the REST URL (https://).
  // Fallback chain: BLISSOPS_PG_URL → SUPABASE_DATABASE_URL → DATABASE_URL
  const cs =
    process.env.BLISSOPS_PG_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      "No database connection string found. Set BLISSOPS_PG_URL or DATABASE_URL.",
    );
  }
  return cs;
}

function initPool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = getConnectionString();
  const isSupabase =
    connectionString.includes("supabase.com") ||
    connectionString.includes("supabase.co");

  let sslConfig: any = false;
  if (isSupabase) {
    try {
      // Try to load the Supabase CA certificate for SOC2 compliance
      const certPath = path.resolve(process.cwd(), "prod-ca-2021.crt");
      sslConfig = {
        ca: fs.readFileSync(certPath).toString(),
        rejectUnauthorized: true,
      };
    } catch (e) {
      console.warn("[DB] Could not load prod-ca-2021.crt, falling back to rejectUnauthorized: false");
      sslConfig = { rejectUnauthorized: false };
    }
  }

  _pool = new Pool({
    connectionString,
    max: 3,
    ...(isSupabase ? { ssl: sslConfig } : {}),
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
