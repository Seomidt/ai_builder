import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;
let _configPromise: Promise<{ supabaseUrl: string; supabaseAnonKey: string }> | null = null;

async function loadConfig(): Promise<{ supabaseUrl: string; supabaseAnonKey: string }> {
  if (!_configPromise) {
    _configPromise = fetch("/api/auth/config").then((r) => r.json());
  }
  return _configPromise;
}

export async function getSupabase(): Promise<SupabaseClient> {
  if (_client) return _client;
  const { supabaseUrl, supabaseAnonKey } = await loadConfig();
  _client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession:   true,
      autoRefreshToken: true,
      storageKey:       "blissops_auth",
    },
  });
  return _client;
}

export async function getSessionToken(): Promise<string | null> {
  try {
    const client = await getSupabase();
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  const client = await getSupabase();
  await client.auth.signOut();
}
