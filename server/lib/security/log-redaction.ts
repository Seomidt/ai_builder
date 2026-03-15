/**
 * Phase 13.2 — Log Redaction
 *
 * Redacts sensitive fields from objects before logging.
 * Used in request logging, error logging, and security event logging.
 *
 * INV-SEC-H7: Security events must never log secrets.
 * INV-SEC-H8: Structured error payloads must not leak stack traces.
 */

// ── Sensitive field names (case-insensitive matching) ─────────────────────────

const SENSITIVE_FIELD_PATTERNS: RegExp[] = [
  /^password$/i,
  /^token$/i,
  /^access_token$/i,
  /^refresh_token$/i,
  /^secret$/i,
  /^apikey$/i,
  /^api_key$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set_cookie$/i,
  /^private_key$/i,
  /^client_secret$/i,
  /^credentials$/i,
  /^ssn$/i,
];

const REDACTED_VALUE = "[REDACTED]";

// ── redactSensitiveFields ─────────────────────────────────────────────────────

/**
 * Returns a new object with sensitive field values replaced by [REDACTED].
 * Operates recursively on nested objects and arrays.
 * Does NOT mutate the input.
 */
export function redactSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  maxDepth = 8,
): T {
  return redactValue(obj, 0, maxDepth) as T;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

function redactValue(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, maxDepth));
  }

  // Preserve Error instances — their properties are non-enumerable and
  // Object.entries() would lose them. Return a plain representation.
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? REDACTED_VALUE : redactValue(v, depth + 1, maxDepth);
    }
    return result;
  }

  return value;
}

// ── safeJsonForLogs ───────────────────────────────────────────────────────────

/**
 * Serialize an object for log output with sensitive fields redacted.
 * Never includes stack traces.
 */
export function safeJsonForLogs(value: unknown): string {
  try {
    if (value === null || value === undefined) return String(value);

    const target =
      typeof value === "object"
        ? redactSensitiveFields(value as Record<string, unknown>)
        : value;

    return JSON.stringify(target, (_, v) => {
      // Strip Error stack traces
      if (v instanceof Error) {
        return { message: v.message, name: v.name };
      }
      return v;
    });
  } catch {
    return "[log serialization error]";
  }
}

// ── explainRedaction ──────────────────────────────────────────────────────────

export interface RedactionExplanation {
  redactedFields: string[];
  redactedValue: string;
  caseInsensitive: boolean;
  recursive: boolean;
  stackTracesRemoved: boolean;
  note: string;
}

/**
 * Read-only explanation of redaction behavior.
 * INV-SEC-H10: Explain helpers must not perform unexpected writes.
 */
export function explainRedaction(): RedactionExplanation {
  return {
    redactedFields: [
      "password", "token", "access_token", "refresh_token",
      "secret", "apiKey", "api_key", "authorization",
      "cookie", "set_cookie", "private_key", "client_secret",
      "credentials", "ssn",
    ],
    redactedValue: REDACTED_VALUE,
    caseInsensitive: true,
    recursive: true,
    stackTracesRemoved: true,
    note: "Redaction applies to all log output, security events, and error responses.",
  };
}
