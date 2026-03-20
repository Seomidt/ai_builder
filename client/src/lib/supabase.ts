import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public Supabase project values — same as returned by /api/auth/config.
// Hardcoded so the client is ready immediately at module load (no boot-blocking
// fetch needed). VITE_ build-time vars take precedence when set.
const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  "https://jneoimqidmkhikvusxak.supabase.co";

const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

const AUTH_OPTIONS = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "blissops_auth",
    detectSessionInUrl: true,
  },
} as const;

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  AUTH_OPTIONS,
);

/**
 * No-op kept for import compatibility.
 * Previously fetched /api/auth/config to initialise the client at boot time,
 * which blocked React render. Client is now initialised synchronously above
 * using baked-in public values (safe — anon key is already public).
 */
export async function initSupabaseFromConfig(): Promise<void> {
  // intentional no-op
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
