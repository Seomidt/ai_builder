/**
 * Phase 25 — Payload Limits
 * Enforces maximum payload sizes for different request types.
 * Rejection returns 413 Payload Too Large.
 */

// ── Size constants ─────────────────────────────────────────────────────────────

export const PAYLOAD_LIMITS = {
  JSON_BODY:        1 * 1024 * 1024,   // 1 MB  — general API payloads
  FILE_UPLOAD:     10 * 1024 * 1024,   // 10 MB — file uploads
  AI_PROMPT:       32 * 1024,          // 32 KB — AI prompt input
  AI_CONTEXT:     128 * 1024,          // 128 KB — AI context window
  WEBHOOK_PAYLOAD:  1 * 1024 * 1024,   // 1 MB  — outbound webhook payloads
  IMAGE_UPLOAD:     5 * 1024 * 1024,   // 5 MB  — image uploads
  EVALUATION_INPUT: 64 * 1024,         // 64 KB — evaluation input
  CSV_UPLOAD:      20 * 1024 * 1024,   // 20 MB — CSV/data files
  MAX_HEADERS:      8 * 1024,          // 8 KB  — total request headers
  MAX_URL_LENGTH:   2048,              // 2048 chars — URL length
} as const;

export type PayloadType = keyof typeof PAYLOAD_LIMITS;

// ── Validation result ──────────────────────────────────────────────────────────

export interface PayloadCheckResult {
  allowed: boolean;
  sizeBytes: number;
  limitBytes: number;
  type: PayloadType;
  httpStatus: 200 | 413;
  message?: string;
}

// ── Size computation ───────────────────────────────────────────────────────────

/**
 * Get the byte size of a string in UTF-8.
 */
export function getStringByteSize(str: string): number {
  return Buffer.byteLength(str, "utf8");
}

/**
 * Get the byte size of a JSON-serializable object.
 */
export function getObjectByteSize(obj: unknown): number {
  return getStringByteSize(JSON.stringify(obj));
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Check functions ────────────────────────────────────────────────────────────

/**
 * Check if a payload is within the limit for a given type.
 */
export function checkPayloadSize(sizeBytes: number, type: PayloadType): PayloadCheckResult {
  const limitBytes = PAYLOAD_LIMITS[type];
  const allowed = sizeBytes <= limitBytes;
  return {
    allowed,
    sizeBytes,
    limitBytes,
    type,
    httpStatus: allowed ? 200 : 413,
    message: allowed
      ? undefined
      : `Payload too large: ${formatBytes(sizeBytes)} exceeds ${type} limit of ${formatBytes(limitBytes)}`,
  };
}

/**
 * Check a string payload.
 */
export function checkStringPayload(str: string, type: PayloadType): PayloadCheckResult {
  return checkPayloadSize(getStringByteSize(str), type);
}

/**
 * Check an object payload.
 */
export function checkObjectPayload(obj: unknown, type: PayloadType): PayloadCheckResult {
  return checkPayloadSize(getObjectByteSize(obj), type);
}

/**
 * Check an AI prompt string.
 */
export function checkAiPrompt(prompt: string): PayloadCheckResult {
  return checkStringPayload(prompt, "AI_PROMPT");
}

/**
 * Check a webhook payload object.
 */
export function checkWebhookPayload(payload: unknown): PayloadCheckResult {
  return checkObjectPayload(payload, "WEBHOOK_PAYLOAD");
}

/**
 * Check a file upload size.
 */
export function checkFileUpload(sizeBytes: number, type: "FILE_UPLOAD" | "IMAGE_UPLOAD" | "CSV_UPLOAD" = "FILE_UPLOAD"): PayloadCheckResult {
  return checkPayloadSize(sizeBytes, type);
}

// ── URL validation ─────────────────────────────────────────────────────────────

/**
 * Check if a URL length is within limits.
 */
export function checkUrlLength(url: string): { allowed: boolean; length: number; limit: number } {
  const length = url.length;
  const limit = PAYLOAD_LIMITS.MAX_URL_LENGTH;
  return { allowed: length <= limit, length, limit };
}

// ── Multi-part validation ──────────────────────────────────────────────────────

export interface MultiPayloadCheck {
  overall: boolean;
  results: PayloadCheckResult[];
  violations: PayloadCheckResult[];
}

/**
 * Check multiple payloads at once.
 */
export function checkMultiplePayloads(checks: Array<{ value: string | unknown; type: PayloadType }>): MultiPayloadCheck {
  const results = checks.map(({ value, type }) => {
    if (typeof value === "string") return checkStringPayload(value, type);
    return checkObjectPayload(value, type);
  });
  const violations = results.filter(r => !r.allowed);
  return { overall: violations.length === 0, results, violations };
}

// ── Custom limit builder ───────────────────────────────────────────────────────

/**
 * Create a custom payload limit check for non-standard types.
 */
export function checkCustomLimit(sizeBytes: number, limitBytes: number, label: string): {
  allowed: boolean;
  sizeBytes: number;
  limitBytes: number;
  label: string;
  message?: string;
} {
  const allowed = sizeBytes <= limitBytes;
  return {
    allowed,
    sizeBytes,
    limitBytes,
    label,
    message: allowed
      ? undefined
      : `${label} too large: ${formatBytes(sizeBytes)} exceeds limit of ${formatBytes(limitBytes)}`,
  };
}
