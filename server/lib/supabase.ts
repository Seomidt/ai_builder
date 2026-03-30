import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.ts";

// ── Admin client (service_role) ───────────────────────────────────────────────
// Lazy singleton — created on first use, not at module load.
// Use ONLY for:
//   • Auth middleware (getUser, membership lookups)
//   • Admin endpoints protected by platform_admin guard
//   • Server-side writes where tenant org is already validated by Express auth
// NEVER use for tenant-facing reads — use createServerSupabaseClient() instead.

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  if (!env.SUPABASE_URL) throw new Error("Missing env: SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");
  _admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

// Legacy synchronous export for backwards compatibility with existing callers.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    return (getSupabaseAdmin() as any)[prop];
  },
});

// ── Runtime user-scoped client ────────────────────────────────────────────────
// Creates a per-request Supabase client bound to the caller's JWT.
// PostgREST forwards the JWT → Postgres sets auth.uid() → RLS policies apply.
// Use for ALL tenant-facing data reads. Never use service_role for reads.
//
// Runtime rule: no pg.Pool, no TCP connections, no warmup.
// HTTP/PostgREST is connectionless — safe for serverless cold starts.

export function createServerSupabaseClient(accessToken: string): SupabaseClient {
  if (!env.SUPABASE_URL) throw new Error("Missing env: SUPABASE_URL");
  if (!env.SUPABASE_ANON_KEY) throw new Error("Missing env: SUPABASE_ANON_KEY");
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export const SUPABASE_URL = env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
