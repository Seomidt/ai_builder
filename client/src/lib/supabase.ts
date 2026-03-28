import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAuthCookieDomain } from "@/lib/runtime/domain";

// Public Supabase project values — same as returned by /api/auth/config.
// Hardcoded so the client is ready immediately at module load (no boot-blocking
// fetch needed). VITE_ build-time vars take precedence when set.
const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  "https://jneoimqidmkhikvusxak.supabase.co";

const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

/**
 * Hybrid auth storage adapter for Supabase.
 *
 * Strategy:
 *  - Production (*.blissops.com): cookies with domain=".blissops.com" so a
 *    single login works across app.blissops.com and admin.blissops.com.
 *  - Dev/preview (localhost, *.replit.dev, etc.): localStorage.
 *    Cookies with public-suffix domains (.replit.dev) are rejected by browsers,
 *    and cross-subdomain sharing is not needed in these environments.
 */

const hostname =
  typeof window !== "undefined" ? window.location.hostname : "";
const cookieDomain = getAuthCookieDomain(hostname);

// Use cookies only when we have a real blissops.com cross-subdomain domain.
// On localhost and Replit preview cookieDomain is "" — use localStorage instead.
const useLocalStorage =
  typeof window !== "undefined" &&
  (hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost") ||
    hostname.includes(".replit.dev") ||
    hostname.includes(".repl.co") ||
    hostname.includes(".replit.app") ||
    cookieDomain === "");

const isHttps =
  typeof window !== "undefined" && window.location.protocol === "https:";

const cookieStorage = {
  getItem(key: string): string | null {
    if (typeof document === "undefined") return null;
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${encodeURIComponent(key)}=`));
    return match
      ? decodeURIComponent(match.split("=").slice(1).join("="))
      : null;
  },

  setItem(key: string, value: string): void {
    if (typeof document === "undefined") return;
    const parts = [
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      "path=/",
      "max-age=604800",
      isHttps ? "samesite=none" : "samesite=lax",
    ];
    if (cookieDomain) parts.push(`domain=${cookieDomain}`);
    if (isHttps) parts.push("secure");
    document.cookie = parts.join("; ");
  },

  removeItem(key: string): void {
    if (typeof document === "undefined") return;
    const parts = [
      `${encodeURIComponent(key)}=`,
      "path=/",
      "max-age=0",
    ];
    if (cookieDomain) parts.push(`domain=${cookieDomain}`);
    document.cookie = parts.join("; ");
  },
};

// localStorage adapter — same interface as cookieStorage
const localStorageAdapter = {
  getItem(key: string): string | null {
    if (typeof window === "undefined") return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  removeItem(key: string): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const authStorage = useLocalStorage ? localStorageAdapter : cookieStorage;

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession:     true,
      autoRefreshToken:   true,
      storageKey:         "blissops_auth",
      detectSessionInUrl: true,
      storage:            authStorage,
    },
  },
);

/**
 * No-op kept for import compatibility.
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
