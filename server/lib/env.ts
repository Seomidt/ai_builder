/**
 * Reads an env var. Logs a warning at boot if missing — does NOT throw.
 * Individual consumers (supabase.ts, openai-client.ts) throw at call-time
 * when the var is actually needed, giving a clear error per failing request
 * rather than crashing the entire serverless function on cold-start.
 */
function get(name: string): string {
  const val = process.env[name] ?? "";
  if (!val) {
    console.warn(`[env] WARNING: ${name} is not set`);
  }
  return val;
}

export const env = {
  SUPABASE_URL:              get("SUPABASE_URL"),
  SUPABASE_ANON_KEY:         get("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: get("SUPABASE_SERVICE_ROLE_KEY"),
  OPENAI_API_KEY:            get("OPENAI_API_KEY"),
  APP_ENV:                   process.env.APP_ENV ?? "development",
};

// Log production safety check — no throw, just warn
if (env.APP_ENV === "production" && env.OPENAI_API_KEY && !env.OPENAI_API_KEY.startsWith("sk-")) {
  console.warn("[env] WARNING: OPENAI_API_KEY does not start with 'sk-'");
}
