/**
 * ssl-config.ts — Centralized SSL configuration for Supabase connections.
 *
 * SOC2 / ISO 27001 compliance:
 *   - Uses Supabase CA certificate (prod-ca-2021.crt) when available on disk
 *   - Falls back to the embedded certificate constant (bundled at build time)
 *   - Never uses NODE_TLS_REJECT_UNAUTHORIZED=0 (process-wide override)
 *
 * Why embedded fallback?
 *   Railway (and other container platforms) run `node dist/index.cjs` from a
 *   working directory that may differ from the project root.  esbuild bundles
 *   only JS — it does NOT copy .crt files into dist/.  The embedded constant
 *   ensures the CA cert is always available regardless of cwd or deploy layout.
 */
import * as fs from "fs";
import * as path from "path";

// Supabase Root 2021 CA — embedded so it is always available in the bundle.
// Source: https://supabase.com/docs/guides/database/connecting-to-postgres#ssl
const SUPABASE_CA_2021 = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

let _sslConfig: { ca?: string; rejectUnauthorized: boolean } | null = null;

/**
 * Returns the SSL configuration for Supabase pg connections.
 * Loads the CA certificate once and caches it.
 *
 * Priority:
 *   1. prod-ca-2021.crt file on disk (project root or /app)
 *   2. Embedded SUPABASE_CA_2021 constant (always available in bundle)
 */
export function getSupabaseSslConfig(): { ca?: string; rejectUnauthorized: boolean } {
  if (_sslConfig) return _sslConfig;

  // 1. Try to load from disk (local dev / Replit / Vercel with file present)
  try {
    const candidates = [
      path.resolve(process.cwd(), "prod-ca-2021.crt"),
      path.resolve(process.cwd(), "server", "prod-ca-2021.crt"),
      "/app/prod-ca-2021.crt",
      path.resolve(__dirname, "../../..", "prod-ca-2021.crt"),
      path.resolve(__dirname, "..", "prod-ca-2021.crt"),
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
  } catch (_e) {
    // Fall through to embedded cert
  }

  // 2. Fallback: use embedded certificate (Railway, Docker, any container deploy)
  console.log("[SSL] prod-ca-2021.crt not found on disk — using embedded Supabase Root 2021 CA (SOC2 compliant)");
  _sslConfig = {
    ca: SUPABASE_CA_2021,
    rejectUnauthorized: true,
  };
  return _sslConfig;
}
