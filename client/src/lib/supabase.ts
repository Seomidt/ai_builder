import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const AUTH_OPTIONS = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "blissops_auth",
    detectSessionInUrl: true,
  },
} as const;

// Mutable holder — replaced by initSupabaseFromConfig() before React renders
let _instance: SupabaseClient = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? "https://placeholder.supabase.co",
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? "placeholder-key",
  AUTH_OPTIONS,
);

// Proxy that always forwards to the current _instance.
// Safe because initSupabaseFromConfig() runs before React renders (see main.tsx).
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (_instance as any)[prop];
  },
});

/**
 * Fetches Supabase URL + anon key from /api/auth/config and reinitialises
 * the client. Called once in main.tsx with top-level await BEFORE React renders,
 * so the real client is always in place when any component first uses `supabase`.
 *
 * If VITE_ build-time vars are already set (local dev or correctly configured
 * Vercel project), this is a no-op and returns immediately.
 */
export async function initSupabaseFromConfig(): Promise<void> {
  const buildUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const buildKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (buildUrl && buildKey) {
    return;
  }

  try {
    const res = await fetch("/api/auth/config");
    if (!res.ok) throw new Error(`/api/auth/config returned ${res.status}`);
    const { supabaseUrl, supabaseAnonKey } = (await res.json()) as {
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    if (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes("placeholder")) {
      _instance = createClient(supabaseUrl, supabaseAnonKey, AUTH_OPTIONS);
      console.info("[supabase] Client initialised from /api/auth/config");
    } else {
      console.error("[supabase] /api/auth/config returned empty or placeholder values");
    }
  } catch (err) {
    console.error("[supabase] Failed to fetch config — auth will not work:", err);
  }
}

export async function getSessionToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
