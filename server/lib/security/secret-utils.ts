/**
 * Phase 25 — Secret Utilities
 * Safe handling of secrets: masking, rotation, constant-time comparison.
 * Secrets must NEVER appear in logs or error messages.
 */

import crypto from "crypto";

// ── Secret masking ─────────────────────────────────────────────────────────────

/**
 * Mask a secret for safe display in logs/UI.
 * Shows first 4 + last 4 characters with **** in the middle.
 * Very short secrets are fully masked.
 */
export function maskSecret(secret: string): string {
  if (!secret) return "****";
  if (secret.length <= 8) return "****";
  if (secret.length <= 12) return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

/**
 * Mask an API key with prefix preservation.
 * e.g. "sk-proj-abc123..." → "sk-proj-****abc1"
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "****";
  // Detect common prefixes
  const prefixPatterns = [/^(sk-proj-|sk-|pk-|rk_live_|rk_test_|whsec_|pk_live_|pk_test_)/];
  for (const pattern of prefixPatterns) {
    const match = apiKey.match(pattern);
    if (match) {
      const prefix = match[1];
      const remainder = apiKey.slice(prefix.length);
      return `${prefix}****${remainder.slice(-4)}`;
    }
  }
  return maskSecret(apiKey);
}

/**
 * Mask a webhook signing secret.
 */
export function maskWebhookSecret(secret: string): string {
  if (!secret) return "****";
  return `****${secret.slice(-4)}`;
}

/**
 * Check if a string looks like it might be a secret (for log scrubbing).
 * Heuristic: long random-looking strings.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false;
  // High entropy: matches common secret patterns
  const secretPatterns = [
    /^(sk|pk|rk|whsec)[-_]/,           // API key prefixes
    /^[a-f0-9]{32,}$/,                  // Hex strings (tokens, hashes)
    /^[A-Za-z0-9+/]{43}=?$/,           // Base64 ~32 bytes
    /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  ];
  return secretPatterns.some(p => p.test(value));
}

/**
 * Scrub an object of all secret-looking values before logging.
 * Returns a safe copy.
 */
export function scrubSecretsFromObject(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    "secret", "password", "passwd", "token", "api_key", "apiKey", "api_secret",
    "signing_secret", "private_key", "privateKey", "access_token", "refresh_token",
    "client_secret", "webhook_secret", "stripe_key", "openai_key", "supabase_key",
    "authorization", "x-api-key", "bearer",
  ]);

  function scrub(val: unknown, key?: string): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") {
      if (key && SENSITIVE_KEYS.has(key.toLowerCase())) return "****";
      if (looksLikeSecret(val)) return maskSecret(val);
      return val;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, scrub(v, k)]),
      );
    }
    if (Array.isArray(val)) return val.map(v => scrub(v));
    return val;
  }

  return scrub(obj) as Record<string, unknown>;
}

// ── Constant-time comparison ───────────────────────────────────────────────────

/**
 * Compare two secrets in constant time to prevent timing attacks.
 * Returns true only if both strings are identical.
 */
export function compareSecretConstantTime(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    // Both buffers must be the same length for timingSafeEqual
    if (bufA.length !== bufB.length) {
      // Still compare to avoid short-circuit timing leak
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ── Secret rotation ────────────────────────────────────────────────────────────

export type SecretFormat = "hex" | "base64" | "urlsafe-base64" | "alphanumeric";

/**
 * Generate a new cryptographically secure secret.
 */
export function generateSecret(params?: {
  bytes?: number;
  format?: SecretFormat;
}): string {
  const bytes = params?.bytes ?? 32;
  const format = params?.format ?? "hex";
  const buf = crypto.randomBytes(bytes);
  switch (format) {
    case "hex":            return buf.toString("hex");
    case "base64":         return buf.toString("base64");
    case "urlsafe-base64": return buf.toString("base64url");
    case "alphanumeric": {
      // Phase 42 fix: modulo bias removed.
      // chars.length = 62, which does NOT evenly divide 256, so `b % 62` is biased.
      // Use crypto.randomInt(0, chars.length) which uses rejection sampling internally
      // and guarantees a uniform distribution over [0, chars.length).
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const result: string[] = [];
      for (let i = 0; i < bytes; i++) {
        result.push(chars[crypto.randomInt(0, chars.length)]);
      }
      return result.join("");
    }
  }
}

export interface SecretRotationResult {
  previousMasked: string;
  newSecret: string;
  newMasked: string;
  rotatedAt: string;
}

/**
 * Rotate a secret: generate a new one and return both masked versions.
 * The caller is responsible for storing the new secret securely.
 */
export function rotateSecret(currentSecret: string, options?: {
  bytes?: number;
  format?: SecretFormat;
}): SecretRotationResult {
  const newSecret = generateSecret(options);
  return {
    previousMasked: maskSecret(currentSecret),
    newSecret,
    newMasked: maskSecret(newSecret),
    rotatedAt: new Date().toISOString(),
  };
}

// ── HMAC signing utilities ─────────────────────────────────────────────────────

/**
 * Sign a message with HMAC-SHA256.
 */
export function hmacSign(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/**
 * Verify an HMAC-SHA256 signature in constant time.
 */
export function hmacVerify(secret: string, message: string, signature: string): boolean {
  const expected = hmacSign(secret, message);
  return compareSecretConstantTime(expected, signature);
}

// ── Secret strength validation ─────────────────────────────────────────────────

export interface SecretStrengthResult {
  strong: boolean;
  score: number;       // 0–100
  issues: string[];
}

/**
 * Validate the strength of a secret.
 */
export function validateSecretStrength(secret: string): SecretStrengthResult {
  const issues: string[] = [];
  let score = 100;

  if (secret.length < 16) { issues.push("Too short (min 16 chars)"); score -= 40; }
  else if (secret.length < 32) { issues.push("Weak length (prefer 32+ chars)"); score -= 15; }

  if (/^(.)\1+$/.test(secret)) { issues.push("All identical characters"); score -= 50; }
  if (/^[0-9]+$/.test(secret)) { issues.push("Numeric only"); score -= 30; }
  if (/^[a-z]+$/.test(secret) || /^[A-Z]+$/.test(secret)) {
    issues.push("Letters only, no mixed case or symbols"); score -= 20;
  }

  // Common weak secrets
  const weak = ["password", "secret", "12345678", "admin", "test", "changeme"];
  if (weak.some(w => secret.toLowerCase().includes(w))) {
    issues.push("Contains common weak phrase"); score -= 40;
  }

  return { strong: issues.length === 0 && score >= 70, score: Math.max(0, score), issues };
}
