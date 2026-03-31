/**
 * ssl-config.ts — Centralized SSL configuration for Supabase connections.
 *
 * SOC2 / ISO 27001 compliance:
 *   - Uses Supabase CA certificate (prod-ca-2021.crt) when available
 *   - Falls back to rejectUnauthorized: false with a warning if cert is missing
 *   - Never uses NODE_TLS_REJECT_UNAUTHORIZED=0 (process-wide override)
 */
import * as fs from "fs";
import * as path from "path";

let _sslConfig: { ca?: string; rejectUnauthorized: boolean } | null = null;

/**
 * Returns the SSL configuration for Supabase pg connections.
 * Loads the CA certificate once and caches it.
 */
export function getSupabaseSslConfig(): { ca?: string; rejectUnauthorized: boolean } {
  if (_sslConfig) return _sslConfig;

  try {
    // Try project root first, then common deployment paths
    const candidates = [
      path.resolve(process.cwd(), "prod-ca-2021.crt"),
      path.resolve(process.cwd(), "server", "prod-ca-2021.crt"),
      "/app/prod-ca-2021.crt",
    ];

    for (const certPath of candidates) {
      if (fs.existsSync(certPath)) {
        _sslConfig = {
          ca: fs.readFileSync(certPath).toString(),
          rejectUnauthorized: true,
        };
        console.log(`[SSL] Loaded Supabase CA certificate from ${certPath} (SOC2 compliant)`);
        return _sslConfig;
      }
    }

    // Fallback: certificate not found
    console.warn(
      "[SSL] prod-ca-2021.crt not found — falling back to rejectUnauthorized: false. " +
      "This is NOT SOC2 compliant. Add prod-ca-2021.crt to the project root.",
    );
    _sslConfig = { rejectUnauthorized: false };
    return _sslConfig;
  } catch (e) {
    console.warn("[SSL] Error loading CA certificate:", (e as Error).message);
    _sslConfig = { rejectUnauthorized: false };
    return _sslConfig;
  }
}
