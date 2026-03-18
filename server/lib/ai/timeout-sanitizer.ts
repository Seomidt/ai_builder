/**
 * Phase 42 — Timeout Sanitization Helpers
 *
 * Task 4 fix: user-provided timeout values must never be used raw in setTimeout().
 * Clamping ensures no user input can create oversized timers or cause event-loop pressure.
 *
 * Design:
 *   - All timeout values entering the system from external sources go through sanitizeTimeoutMs()
 *   - Internal system timeouts use getEffectiveTimeoutMs() to apply project-wide SLA limits
 *   - clampTimeoutMs() is the core primitive used by both
 *
 * Limits:
 *   MIN_TIMEOUT_MS = 1_000   (1 second — sub-second AI calls are unrealistic)
 *   MAX_TIMEOUT_MS = 120_000 (2 minutes — platform AI SLA ceiling)
 *   DEFAULT_TIMEOUT_MS = 30_000 (30 seconds — matches AI_TIMEOUT_MS in config)
 *
 * Relationship to AI_TIMEOUT_MS (config.ts):
 *   AI_TIMEOUT_MS is the system constant used for direct provider calls.
 *   These helpers are used when a timeout value originates from an external
 *   source (API request body, webhook payload, user configuration, etc.).
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const MIN_TIMEOUT_MS     = 1_000;    // 1 second
export const MAX_TIMEOUT_MS     = 120_000;  // 2 minutes
export const DEFAULT_TIMEOUT_MS = 30_000;   // 30 seconds

// ── Core clamp ────────────────────────────────────────────────────────────────

/**
 * Clamp a numeric timeout to [min, max].
 * Returns the default if the input is not a finite positive number.
 */
export function clampTimeoutMs(
  value:      number,
  min:        number = MIN_TIMEOUT_MS,
  max:        number = MAX_TIMEOUT_MS,
  defaultVal: number = DEFAULT_TIMEOUT_MS,
): number {
  if (!Number.isFinite(value) || value <= 0) return defaultVal;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value); // integer ms only
}

// ── External input sanitization ───────────────────────────────────────────────

export interface SanitizeTimeoutOptions {
  min?:       number;
  max?:       number;
  default?:   number;
  logClamped?: boolean;
  label?:     string;   // identifier for log messages
}

export interface SanitizedTimeout {
  valueMs:   number;
  clamped:   boolean;
  original:  unknown;
  reason?:   string;
}

/**
 * Sanitize a timeout value from an external source (user input, request body, config).
 *
 * - Rejects non-numbers, NaN, Infinity, negative values → uses default
 * - Clamps to [min, max] bounds
 * - Logs when clamping occurs (if logClamped=true)
 * - Returns structured result for auditing
 *
 * NEVER pass sanitizeTimeoutMs() output directly to setTimeout() without
 * first awaiting the result — use the returned `.valueMs` field.
 */
export function sanitizeTimeoutMs(
  raw:     unknown,
  options: SanitizeTimeoutOptions = {},
): SanitizedTimeout {
  const {
    min        = MIN_TIMEOUT_MS,
    max        = MAX_TIMEOUT_MS,
    default: defaultVal = DEFAULT_TIMEOUT_MS,
    logClamped = false,
    label      = "timeout",
  } = options;

  // Type + validity check
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    if (logClamped) {
      console.warn(
        `[timeout-sanitizer] ${label}: invalid value ${JSON.stringify(raw)}, using default ${defaultVal}ms`,
      );
    }
    return { valueMs: defaultVal, clamped: true, original: raw, reason: "invalid_type_or_value" };
  }

  const rounded = Math.floor(raw);

  // Zero / sub-minimum
  if (rounded < min) {
    if (logClamped) {
      console.warn(`[timeout-sanitizer] ${label}: ${rounded}ms below minimum ${min}ms, clamped to ${min}ms`);
    }
    return { valueMs: min, clamped: true, original: raw, reason: "below_minimum" };
  }

  // Oversized
  if (rounded > max) {
    if (logClamped) {
      console.warn(`[timeout-sanitizer] ${label}: ${rounded}ms exceeds maximum ${max}ms, clamped to ${max}ms`);
    }
    return { valueMs: max, clamped: true, original: raw, reason: "above_maximum" };
  }

  return { valueMs: rounded, clamped: false, original: raw };
}

// ── Effective timeout resolver ────────────────────────────────────────────────

/**
 * Resolve the effective timeout for an operation.
 *
 * Combines a user-requested timeout (optional, from external source) with
 * the system ceiling, always producing a safe bounded value.
 *
 * Usage:
 *   const timeoutMs = getEffectiveTimeoutMs(req.body.timeoutMs);
 *   const timerId = setTimeout(() => controller.abort(), timeoutMs);
 */
export function getEffectiveTimeoutMs(
  requested?: unknown,
  options:    SanitizeTimeoutOptions = {},
): number {
  if (requested === undefined || requested === null) {
    return options.default ?? DEFAULT_TIMEOUT_MS;
  }
  return sanitizeTimeoutMs(requested, options).valueMs;
}

// ── Timer lifecycle helper ────────────────────────────────────────────────────

/**
 * Create a safe, bounded AbortController timeout.
 *
 * Returns the controller and a cleanup function. The cleanup function MUST
 * be called in all exit paths (success, error, finally) to prevent timer leaks.
 *
 * Usage:
 *   const { controller, cleanup } = createAbortTimeout(requestedMs);
 *   try {
 *     const result = await fetch(url, { signal: controller.signal });
 *     return result;
 *   } finally {
 *     cleanup(); // always called — prevents timer leak
 *   }
 */
export function createAbortTimeout(
  requestedMs?: unknown,
  options?:     SanitizeTimeoutOptions,
): {
  controller: AbortController;
  cleanup:    () => void;
  timeoutMs:  number;
} {
  const timeoutMs  = getEffectiveTimeoutMs(requestedMs, options);
  const controller = new AbortController();
  const timerId    = setTimeout(() => controller.abort(), timeoutMs);

  return {
    controller,
    timeoutMs,
    cleanup: () => clearTimeout(timerId),
  };
}
