import { createClient } from "@supabase/supabase-js";

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:   true,
    autoRefreshToken: true,
    storageKey:       "blissops_auth",
  },
});

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
