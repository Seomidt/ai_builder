/**
 * Phase 42 — URL Allowlist Helper
 *
 * Fixes scanner finding: substring URL validation is unsafe.
 * Checks like `url.includes("openai.com")` can be bypassed with
 * crafted hostnames like `evil-openai.com.attacker.org`.
 *
 * This module provides:
 *   - parseUrlSafely()           : parse URL without throwing
 *   - hostnameMatchesAllowlist() : exact host or safe subdomain matching
 *   - isAllowedUrl()             : full URL allowlist check
 *
 * Rules:
 *   - Exact host match: `api.openai.com` matches `api.openai.com`
 *   - Subdomain match: `*.openai.com` matches `foo.openai.com` but NOT `evil-openai.com`
 *   - NO substring matching anywhere in the hostname
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedUrlResult {
  ok:        boolean;
  url:       URL | null;
  hostname:  string | null;
  protocol:  string | null;
  error?:    string;
}

export interface AllowlistEntry {
  /** Exact hostname, e.g. "api.openai.com"  */
  host?: string;
  /** Wildcard subdomain pattern, e.g. "*.supabase.co"  */
  subdomain?: string;
}

export type AllowlistSpec = Array<string | AllowlistEntry>;

// ── Canonical allowlists ──────────────────────────────────────────────────────

/** Supabase REST, Realtime, Auth APIs */
export const SUPABASE_ALLOWED_HOSTS: AllowlistSpec = [
  { subdomain: "*.supabase.co" },
  { subdomain: "*.supabase.com" },
];

/** OpenAI API */
export const OPENAI_ALLOWED_HOSTS: AllowlistSpec = [
  "api.openai.com",
];

/** Anthropic API */
export const ANTHROPIC_ALLOWED_HOSTS: AllowlistSpec = [
  "api.anthropic.com",
];

/** Stripe APIs */
export const STRIPE_ALLOWED_HOSTS: AllowlistSpec = [
  "api.stripe.com",
  "js.stripe.com",
  "hooks.stripe.com",
  { subdomain: "*.stripe.com" },
];

/** GitHub API */
export const GITHUB_ALLOWED_HOSTS: AllowlistSpec = [
  "api.github.com",
  "github.com",
  { subdomain: "*.github.com" },
];

/** Cloudflare R2 / Workers */
export const CLOUDFLARE_ALLOWED_HOSTS: AllowlistSpec = [
  { subdomain: "*.r2.cloudflarestorage.com" },
  { subdomain: "*.cloudflare.com" },
];

/** All platform-trusted external hosts */
export const PLATFORM_ALLOWED_HOSTS: AllowlistSpec = [
  ...SUPABASE_ALLOWED_HOSTS,
  ...OPENAI_ALLOWED_HOSTS,
  ...ANTHROPIC_ALLOWED_HOSTS,
  ...STRIPE_ALLOWED_HOSTS,
  ...GITHUB_ALLOWED_HOSTS,
  ...CLOUDFLARE_ALLOWED_HOSTS,
];

// ── Core utilities ─────────────────────────────────────────────────────────────

/**
 * Parse a URL string safely.
 * Returns { ok: false } instead of throwing on invalid input.
 */
export function parseUrlSafely(raw: string): ParsedUrlResult {
  if (!raw || typeof raw !== "string") {
    return { ok: false, url: null, hostname: null, protocol: null, error: "empty input" };
  }
  try {
    const url = new URL(raw);
    return { ok: true, url, hostname: url.hostname, protocol: url.protocol };
  } catch (e) {
    return { ok: false, url: null, hostname: null, protocol: null, error: "invalid URL" };
  }
}

/**
 * Normalize an allowlist entry to a concrete matcher.
 */
function normalizeEntry(entry: string | AllowlistEntry): { exact?: string; suffix?: string } {
  if (typeof entry === "string") {
    return { exact: entry.toLowerCase() };
  }
  if (entry.host) {
    return { exact: entry.host.toLowerCase() };
  }
  if (entry.subdomain) {
    // "*.openai.com" → suffix = ".openai.com"
    const pattern = entry.subdomain.toLowerCase();
    if (pattern.startsWith("*.")) {
      return { suffix: pattern.slice(1) }; // ".openai.com"
    }
    return { exact: pattern };
  }
  return {};
}

/**
 * Check whether a hostname matches an allowlist.
 *
 * Matching rules:
 *   - Exact: `api.openai.com` === `api.openai.com`
 *   - Subdomain: `*.openai.com` matches `foo.openai.com` if the hostname
 *     ends with `.openai.com` AND the TLD+domain is an exact suffix match
 *   - NEVER uses substring matching (no `includes`)
 *
 * Attack vectors rejected:
 *   - `evil-openai.com`       (exact match fails, no suffix match)
 *   - `evil.openai.com.bad`   (suffix `.openai.com` not at end of `evil.openai.com.bad`)
 *   - `evilopenai.com`        (exact mismatch)
 */
export function hostnameMatchesAllowlist(
  hostname: string,
  allowlist: AllowlistSpec,
): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();

  for (const entry of allowlist) {
    const { exact, suffix } = normalizeEntry(entry);

    if (exact && h === exact) return true;

    if (suffix) {
      // hostname must end with exactly the suffix AND have content before it
      // e.g. suffix = ".openai.com", hostname must be "foo.openai.com" (not just ".openai.com")
      if (h.endsWith(suffix) && h.length > suffix.length) {
        // Ensure the character before the suffix is not part of an attacker prefix
        // "evil-openai.com" ends with "i.com" not ".openai.com" → safe
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether a full URL string is allowed against a host allowlist.
 *
 * Additional protocol enforcement: only HTTPS is allowed for external services.
 *
 * @param url       Raw URL string from user input or config
 * @param allowlist Allowlist spec (strings or AllowlistEntry objects)
 * @param options   Additional validation options
 */
export function isAllowedUrl(
  url:       string,
  allowlist: AllowlistSpec,
  options:   {
    requireHttps?:  boolean; // default true
    allowLocalhost?: boolean; // default false
  } = {},
): { allowed: boolean; reason?: string } {
  const { requireHttps = true, allowLocalhost = false } = options;

  const parsed = parseUrlSafely(url);
  if (!parsed.ok || !parsed.url) {
    return { allowed: false, reason: "invalid URL" };
  }

  const { url: parsedUrl, hostname } = parsed;

  // Protocol check
  if (requireHttps && parsedUrl.protocol !== "https:") {
    return { allowed: false, reason: `protocol '${parsedUrl.protocol}' not allowed — HTTPS required` };
  }

  // Localhost check
  if (!allowLocalhost) {
    const localPatterns = [/^localhost$/i, /^127\.\d+\.\d+\.\d+$/, /^::1$/];
    if (localPatterns.some(p => p.test(hostname!))) {
      return { allowed: false, reason: "localhost/loopback not allowed" };
    }
  }

  // Hostname allowlist check — exact/subdomain only, never substring
  const hostAllowed = hostnameMatchesAllowlist(hostname!, allowlist);
  if (!hostAllowed) {
    return { allowed: false, reason: `hostname '${hostname}' not in allowlist` };
  }

  return { allowed: true };
}

/**
 * Convenience: validate a connect-src target against the platform allowlist.
 */
export function isAllowedConnectTarget(url: string): { allowed: boolean; reason?: string } {
  return isAllowedUrl(url, PLATFORM_ALLOWED_HOSTS, { requireHttps: true });
}

/**
 * Convenience: validate that a URL is a legitimate OpenAI API endpoint.
 */
export function isAllowedOpenAiUrl(url: string): boolean {
  return isAllowedUrl(url, OPENAI_ALLOWED_HOSTS).allowed;
}

/**
 * Convenience: validate that a URL is a legitimate Stripe endpoint.
 */
export function isAllowedStripeUrl(url: string): boolean {
  return isAllowedUrl(url, STRIPE_ALLOWED_HOSTS).allowed;
}
