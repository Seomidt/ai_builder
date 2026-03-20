/**
 * env.ts — Runtime environment variable access
 *
 * Uses JavaScript property getters so each access reads process.env at
 * call-time (not at module-load time). This is safe for serverless cold-starts
 * and allows env vars set after module initialisation to be picked up.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY have hardcoded fallbacks because they
 * are intentionally public values (the anon key is already returned by the
 * public /api/auth/config endpoint and is required in the browser bundle).
 * All other vars have no fallback and will warn if missing.
 */

const SUPABASE_URL_DEFAULT = "https://jneoimqidmkhikvusxak.supabase.co";
const SUPABASE_ANON_KEY_DEFAULT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

function warn(name: string): void {
  console.warn(`[env] WARNING: ${name} is not set`);
}

export const env = {
  get SUPABASE_URL(): string {
    return process.env.SUPABASE_URL || SUPABASE_URL_DEFAULT;
  },
  get SUPABASE_ANON_KEY(): string {
    return process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY_DEFAULT;
  },
  get SUPABASE_SERVICE_ROLE_KEY(): string {
    const v = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!v) warn("SUPABASE_SERVICE_ROLE_KEY");
    return v;
  },
  get OPENAI_API_KEY(): string {
    const v = process.env.OPENAI_API_KEY ?? "";
    if (!v) warn("OPENAI_API_KEY");
    return v;
  },
  get APP_ENV(): string {
    return process.env.APP_ENV ?? "development";
  },
};
