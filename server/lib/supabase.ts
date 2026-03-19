import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Lazy singleton — created on first use, not at module load.
// This prevents cold-start crashes when SUPABASE_URL is not yet set.
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
// Returns a proxy that delegates to the lazy singleton.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    return (getSupabaseAdmin() as any)[prop];
  },
});

export const SUPABASE_URL = env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
