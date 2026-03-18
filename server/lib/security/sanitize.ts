/**
 * Phase 13.2 — Input Sanitization
 *
 * Provides sanitization helpers using the `xss` library.
 * Sanitization is a complementary hardening layer — NOT a replacement for
 * Zod schema validation (which remains primary).
 *
 * Rules:
 * - sanitizeInput: strips XSS-risk HTML from string values
 * - sanitizeObject: recursively sanitizes string leaves in an object
 * - explainSanitization: read-only explain helper
 *
 * INV-SEC-H5: Sanitization must not replace validation and must remain non-destructive.
 */

import xss from "xss";

// ── XSS options ───────────────────────────────────────────────────────────────

/**
 * Strict options — strip ALL HTML tags and attributes.
 * Plain text semantics are preserved; only HTML markup is removed.
 */
const XSS_OPTIONS = {
  whiteList: {} as Record<string, string[]>,
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed"],
  allowCommentTag: false,
};

// ── sanitizeInput ─────────────────────────────────────────────────────────────

/**
 * Sanitize a single string value.
 * Returns the string with all HTML stripped.
 * Non-string values are returned as-is.
 */
export function sanitizeInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return xss(value, XSS_OPTIONS);
}

/**
 * Sanitize a string, asserting the output is a string.
 * Use when you know the input is a string.
 */
export function sanitizeString(value: string): string {
  return xss(value, XSS_OPTIONS);
}

// ── sanitizeObject ────────────────────────────────────────────────────────────

/**
 * Recursively sanitize all string leaves in a plain object or array.
 * Does not mutate the original — returns a new object.
 *
 * Depth limit prevents stack overflow on adversarial inputs.
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  maxDepth = 10,
): T {
  return sanitizeValue(obj, 0, maxDepth) as T;
}

function sanitizeValue(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return value;

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, maxDepth));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v, depth + 1, maxDepth);
    }
    return result;
  }

  // Primitives (number, boolean, null, undefined) — pass through unchanged
  return value;
}

// ── explainSanitization ───────────────────────────────────────────────────────

export interface SanitizationExplanation {
  library: string;
  mode: string;
  tagsStripped: boolean;
  attributesStripped: boolean;
  scriptBodyRemoved: boolean;
  plainTextPreserved: boolean;
  doubleEscapePrevented: boolean;
  replacesValidation: boolean;
  note: string;
}

/**
 * Read-only explain helper. Performs no side effects.
 * INV-SEC-H10: Explain helpers must not perform unexpected writes.
 */
export function explainSanitization(): SanitizationExplanation {
  return {
    library: "xss",
    mode: "strict — all HTML tags stripped",
    tagsStripped: true,
    attributesStripped: true,
    scriptBodyRemoved: true,
    plainTextPreserved: true,
    doubleEscapePrevented: true,
    replacesValidation: false,
    note: "Sanitization is a defense-in-depth layer. Zod validation remains primary.",
  };
}
