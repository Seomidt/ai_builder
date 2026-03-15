/**
 * Phase 17 — Runtime Bounds (GitHub/CodeQL Remediation)
 * INV-EVAL8: Bounded timer and runtime behavior.
 *
 * CodeQL Finding 9.1: Resource exhaustion via user-controlled timeout values.
 *
 * Fix strategy:
 * - Clamp all user-supplied timeout/iteration values to explicit bounded constants.
 * - Never let user-controlled numeric values drive unbounded timers.
 * - All clamp operations are explicit and documented.
 *
 * False-positive note (INV-EVAL10):
 * - Some CodeQL findings may flag numeric operations that are already clamped
 *   upstream (e.g., in Phase 12.1 runtime hardening). Those are documented here
 *   as false positives with justification. No unsafe workaround code is added.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum allowed timeout in milliseconds for any user-influenced timer. */
export const MAX_TIMEOUT_MS = 30_000; // 30 seconds

/** Minimum allowed timeout in milliseconds. */
export const MIN_TIMEOUT_MS = 100; // 100ms

/** Maximum allowed orphan-job timeout in minutes (admin route param). */
export const MAX_ORPHAN_TIMEOUT_MINUTES = 1440; // 24 hours

/** Minimum allowed orphan-job timeout in minutes. */
export const MIN_ORPHAN_TIMEOUT_MINUTES = 1;

/** Maximum steps per iteration budget for any agent-controlled loop. */
export const MAX_ITERATION_BUDGET = 100;

/** Minimum steps allowed in an iteration budget. */
export const MIN_ITERATION_BUDGET = 1;

/** Maximum eval benchmark cases per run (resource exhaustion guard). */
export const MAX_EVAL_CASES_PER_RUN = 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Clamp a user-supplied timeout (ms) to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
 * INV-EVAL8: No timer may use unbounded user-provided values.
 *
 * @param valueMs - Raw user-supplied value (may be NaN, negative, or excessive).
 * @returns Clamped value guaranteed within safe bounds.
 */
export function clampTimeout(valueMs: unknown): number {
  const n = typeof valueMs === "number" ? valueMs : Number(valueMs);
  if (isNaN(n) || n === Infinity) return MAX_TIMEOUT_MS;
  if (n === -Infinity || n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(n));
}

/**
 * Clamp a user-supplied orphan-job timeout (minutes) to [MIN, MAX].
 * Used in admin route that accepts timeoutMinutes query param.
 */
export function clampOrphanTimeoutMinutes(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return 60; // default 60 minutes
  return Math.min(MAX_ORPHAN_TIMEOUT_MINUTES, Math.max(MIN_ORPHAN_TIMEOUT_MINUTES, Math.floor(n)));
}

/**
 * Clamp a user-supplied iteration budget to [MIN_ITERATION_BUDGET, MAX_ITERATION_BUDGET].
 * INV-EVAL8: Loop iteration counts from user input must be bounded.
 *
 * @param value - Raw user-supplied iteration count.
 * @returns Clamped iteration budget.
 */
export function clampIterationBudget(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return 10; // safe default
  return Math.min(MAX_ITERATION_BUDGET, Math.max(MIN_ITERATION_BUDGET, Math.floor(n)));
}

/**
 * Clamp eval case count to prevent resource exhaustion in benchmark runner.
 */
export function clampEvalCaseCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return MAX_EVAL_CASES_PER_RUN;
  return Math.min(MAX_EVAL_CASES_PER_RUN, Math.max(0, Math.floor(n)));
}

/**
 * Explain runtime bounds — read-only, no side effects.
 * Provides audit-trail documentation of all active limits.
 * INV-EVAL8: All bounds are explicit and traceable.
 */
export function explainRuntimeBounds(): {
  maxTimeoutMs: number;
  minTimeoutMs: number;
  maxOrphanTimeoutMinutes: number;
  maxIterationBudget: number;
  maxEvalCasesPerRun: number;
  invariant: string;
  codeqlRemediation: string;
  falsePositiveNote: string;
} {
  return {
    maxTimeoutMs: MAX_TIMEOUT_MS,
    minTimeoutMs: MIN_TIMEOUT_MS,
    maxOrphanTimeoutMinutes: MAX_ORPHAN_TIMEOUT_MINUTES,
    maxIterationBudget: MAX_ITERATION_BUDGET,
    maxEvalCasesPerRun: MAX_EVAL_CASES_PER_RUN,
    invariant: "INV-EVAL8: No timer or loop may use unbounded user-provided values.",
    codeqlRemediation:
      "CodeQL Finding 9.1 (resource-exhaustion): All user-supplied timeout/iteration values are now clamped via clampTimeout(), clampIterationBudget(), and clampOrphanTimeoutMinutes() before use.",
    falsePositiveNote:
      "INV-EVAL10: If CodeQL reports findings on already-clamped values (e.g., Phase 12.1 runtime hardening paths), these are false positives. No unsafe workaround code has been added. Justification: the clamping already happens upstream at the boundary of the call site.",
  };
}
