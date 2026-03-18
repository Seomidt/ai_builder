/**
 * Phase 38 — Secret Hygiene
 * Central helpers for detecting, redacting, and auditing secret handling.
 * Integrates with auth-audit, ops-audit, deploy-health, storage-audit, webhook logs.
 *
 * RULES:
 *  - NEVER log plaintext secrets
 *  - NEVER allow secrets to appear in log payloads
 *  - Classify secret-like values before any logging
 */

// ── Classification ────────────────────────────────────────────────────────────

export type SecretClass =
  | "api_key"
  | "bearer_token"
  | "jwt"
  | "session_id"
  | "signed_url"
  | "webhook_secret"
  | "mfa_secret"
  | "reset_token"
  | "hex_token"
  | "base64_token"
  | "unknown_secret"
  | "safe";

const SECRET_PATTERNS: Array<{ pattern: RegExp; cls: SecretClass }> = [
  { pattern: /^(sk|pk|rk|ak)[-_][a-zA-Z0-9_\-]{10,}$/,       cls: "api_key" },
  { pattern: /^(whsec_|hsec_)[a-zA-Z0-9+/=]{20,}$/,           cls: "webhook_secret" },
  { pattern: /^Bearer\s+/i,                                     cls: "bearer_token" },
  { pattern: /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, cls: "jwt" },
  { pattern: /^[a-f0-9]{32,128}$/,                             cls: "hex_token" },
  { pattern: /^[A-Za-z0-9+/]{43,}={0,2}$/,                    cls: "base64_token" },
  { pattern: /X-Amz-Signature=/,                               cls: "signed_url" },
  { pattern: /[?&]token=[a-zA-Z0-9_\-.]{20,}/,                cls: "reset_token" },
  { pattern: /^[A-Z2-7]{16,}$|^[A-Z2-7]{16,}={1,6}$/,        cls: "mfa_secret" }, // TOTP base32
];

export function classifySecretLikeValue(value: string): SecretClass {
  if (!value || typeof value !== "string") return "safe";
  if (value.length < 16) return "safe";

  for (const { pattern, cls } of SECRET_PATTERNS) {
    if (pattern.test(value)) return cls;
  }

  // High entropy heuristic — long mixed strings with no spaces
  const hasUpperLower = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasNumbers    = /[0-9]/.test(value);
  const hasSpecial    = /[_\-+/=]/.test(value);
  if (value.length >= 32 && hasUpperLower && hasNumbers && hasSpecial && !value.includes(" ")) {
    return "unknown_secret";
  }

  return "safe";
}

export function isSecretLike(value: string): boolean {
  return classifySecretLikeValue(value) !== "safe";
}

// ── Redaction ─────────────────────────────────────────────────────────────────

const REDACTED = "[REDACTED]";

/**
 * Redact a single secret value.
 * Returns a safe representation based on the secret class.
 */
export function redactSecret(value: string): string {
  if (!value) return REDACTED;
  const cls = classifySecretLikeValue(value);

  if (cls === "safe") return value;
  if (cls === "jwt") {
    // Show JWT header only (base64 decoded prefix)
    const parts = value.split(".");
    return `${parts[0]}.[REDACTED].[REDACTED]`;
  }
  if (cls === "signed_url") {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}?[REDACTED]`;
    } catch {
      return "[REDACTED-URL]";
    }
  }
  if (cls === "api_key" || cls === "webhook_secret") {
    return `${value.slice(0, 6)}****${value.slice(-4)}`;
  }

  return REDACTED;
}

// ── Env snapshot redaction ────────────────────────────────────────────────────

const SENSITIVE_KEY_PATTERNS = [
  /secret/i, /token/i, /key/i, /password/i, /passwd/i, /auth/i,
  /credential/i, /private/i, /webhook/i, /signing/i, /bearer/i,
  /access/i, /refresh/i, /client_secret/i, /mfa/i, /otp/i,
];

function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Returns a safe snapshot of process.env — all secret-like values redacted.
 * Safe to include in admin dashboards and evidence exports.
 */
export function redactEnvSnapshot(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (!val) { result[key] = "(unset)"; continue; }
    if (isSensitiveEnvKey(key) || isSecretLike(val)) {
      result[key] = REDACTED;
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── Log payload assertion ─────────────────────────────────────────────────────

export class PlaintextSecretError extends Error {
  readonly offendingKeys: string[];
  constructor(offendingKeys: string[]) {
    super(`Log payload contains plaintext secret-like values in keys: ${offendingKeys.join(", ")}`);
    this.name = "PlaintextSecretError";
    this.offendingKeys = offendingKeys;
  }
}

/**
 * Assert that a log payload contains no plaintext secrets.
 * Throws PlaintextSecretError if secrets are detected.
 * Use before writing to any audit log.
 */
export function assertNoPlaintextSecretsInLogPayload(
  payload: Record<string, unknown>,
  path = "",
): void {
  const offending: string[] = [];

  function scan(obj: unknown, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === "string") {
      const cls = classifySecretLikeValue(obj);
      if (cls !== "safe") offending.push(`${currentPath} (${cls})`);
      return;
    }
    if (typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const childPath = currentPath ? `${currentPath}.${k}` : k;
        if (isSensitiveEnvKey(k) && typeof v === "string" && v.length > 8) {
          offending.push(`${childPath} (sensitive-key)`);
        } else {
          scan(v, childPath);
        }
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => scan(item, `${currentPath}[${i}]`));
    }
  }

  scan(payload, path);

  if (offending.length > 0) throw new PlaintextSecretError(offending);
}

/**
 * Safe version — returns a redacted copy rather than throwing.
 * Use when you cannot control the payload structure.
 */
export function sanitizeLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  function sanitize(obj: unknown, key?: string): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") {
      if (key && isSensitiveEnvKey(key)) return REDACTED;
      return isSecretLike(obj) ? redactSecret(obj) : obj;
    }
    if (typeof obj === "object" && !Array.isArray(obj)) {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, sanitize(v, k)]),
      );
    }
    if (Array.isArray(obj)) return obj.map(v => sanitize(v));
    return obj;
  }
  return sanitize(payload) as Record<string, unknown>;
}
