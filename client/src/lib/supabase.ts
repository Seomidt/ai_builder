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
 * Cross-subdomain cookie storage adapter for Supabase auth.
 *
 * Why cookies instead of localStorage:
 *   - localStorage is origin-scoped (blissops.com ≠ admin.blissops.com)
 *   - Cookies with domain=".blissops.com" are shared across all subdomains
 *   - This allows a single login to work on both blissops.com and admin.blissops.com
 *
 * Dev (localhost): no domain attr — cookie scoped to localhost only.
 * Prod (*.blissops.com): domain=".blissops.com" — shared across subdomains.
 *
 * Security:
 *   - SameSite=Lax — CSRF protection, allows redirects from external links
 *   - Secure flag applied on HTTPS (production)
 *   - HTTPOnly NOT used — Supabase JS must read the token client-side
 *   - 7-day max-age (matches Supabase session default)
 */
const cookieDomain = getAuthCookieDomain(
  typeof window !== "undefined" ? window.location.hostname : "",
);

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
      "samesite=lax",
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

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession:     true,
      autoRefreshToken:   true,
      storageKey:         "blissops_auth",
      detectSessionInUrl: true,
      storage:            cookieStorage,
    },
  },
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
