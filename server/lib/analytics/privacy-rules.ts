/**
 * Phase 50 — Analytics Foundation
 * Analytics Payload Privacy Rules
 *
 * Enforces strict payload constraints for all analytics events.
 * No raw user content, secrets, or PII-adjacent data may pass through.
 */

// ─── Forbidden payload keys (exact match) ─────────────────────────────────────

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "raw_prompt",
  "ai_response",
  "raw_response",
  "response_text",
  "message_content",
  "note_text",
  "checkin_text",
  "checkin_content",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "api_key",
  "private_key",
  "card_number",
  "cvv",
  "pan",
  "payment_method_raw",
  "full_card",
  "document_content",
  "file_content",
  "signed_url",
  "presigned_url",
  "s3_url",
  "r2_url",
  "object_key",
  "raw_notes",
  "private_doc",
]);

// ─── Forbidden key patterns (substring match on lowercase key) ────────────────

const FORBIDDEN_PATTERNS = [
  "secret",
  "password",
  "token",
  "private",
  "raw_",
  "_raw",
  "credential",
  "auth_code",
];

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (FORBIDDEN_KEYS.has(lower)) return true;
  return FORBIDDEN_PATTERNS.some((p) => lower.includes(p));
}

// ─── Allowed primitive value types ───────────────────────────────────────────

function isSafeValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return true;
  if (typeof value === "string") return value.length <= 500;
  return false;
}

// ─── sanitizeAnalyticsPayload ─────────────────────────────────────────────────

/**
 * Removes forbidden keys from a payload object.
 * Recursively descends into nested objects (one level only for safety).
 * Returns a new sanitized object — never mutates input.
 */
export function sanitizeAnalyticsPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isForbiddenKey(key)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = sanitizeAnalyticsPayload(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else if (Array.isArray(value)) {
      result[key] = value.filter(isSafeValue).slice(0, 50);
    } else if (isSafeValue(value)) {
      result[key] = value;
    }
  }
  return result;
}

// ─── assertAnalyticsPayloadAllowed ───────────────────────────────────────────

/**
 * Throws if the payload contains explicitly forbidden keys.
 * Use in tests and strict ingestion paths.
 */
export function assertAnalyticsPayloadAllowed(
  payload: Record<string, unknown>,
): void {
  const violations: string[] = [];
  for (const key of Object.keys(payload)) {
    if (isForbiddenKey(key)) {
      violations.push(key);
    }
    const value = payload[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const nested of Object.keys(value as Record<string, unknown>)) {
        if (isForbiddenKey(nested)) violations.push(`${key}.${nested}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Analytics payload contains forbidden fields: ${violations.join(", ")}`,
    );
  }
}

// ─── redactAnalyticsPayload ───────────────────────────────────────────────────

/**
 * Replaces forbidden key values with "[REDACTED]" instead of removing them.
 * Useful for audit logging where key presence must still be visible.
 */
export function redactAnalyticsPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isForbiddenKey(key)) {
      result[key] = "[REDACTED]";
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = redactAnalyticsPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Exported helpers ─────────────────────────────────────────────────────────

export { isForbiddenKey };

export const FORBIDDEN_ANALYTICS_KEYS = Array.from(FORBIDDEN_KEYS);
