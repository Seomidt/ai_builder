/**
 * ssl-config.ts — SSL configuration helper for Supabase/Postgres connections.
 */

export function getSupabaseSslConfig(): { rejectUnauthorized: boolean } | boolean {
  const url = (
    process.env.BLISSOPS_PG_URL ??
    process.env.SUPABASE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    ""
  );
  if (url.includes("supabase.co") || url.includes("pooler.supabase")) {
    return { rejectUnauthorized: false };
  }
  return false;
}
