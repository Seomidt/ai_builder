/**
 * refinement-policy.ts — Fine-grained refinement policy for OCR-based documents.
 *
 * PHASE 5Z.6 — Replaces gen1/gen2/gen3 bucket model with a hash-based
 * refinementGenKey. Refinement is triggered when the key changes AND a
 * meaningful delta is detected (delta_chars, coverage, status change).
 *
 * Fine-grained key: hash(sortedChunkIds + charCount + coveragePct/10 + status)
 *
 * Trigger conditions (any one sufficient):
 *   delta_chars    > DELTA_CHARS_THRESHOLD (500)
 *   coverage delta >= DELTA_COVERAGE_THRESHOLD (10%)
 *   status changed to "completed"
 *   prevKey is null (first answer)
 *
 * Backwards-compatible: computeRefinementGeneration() retained for legacy callers.
 * evaluateRefinementPolicy() now uses the fine-grained key internally.
 */

import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RefinementAction =
  | "start_first_answer"
  | "refine_answer"
  | "finalize_answer"
  | "no_action"
  | "not_ready";

export interface OcrJobRefinementState {
  status:          "pending" | "running" | "completed" | "failed" | "dead_letter";
  stage:           string | null;
  charCount:       number;
  pageCount:       number;
  /** Sorted chunk IDs from retrieved context (empty if not yet chunked). */
  chunkIds?:       string[];
  /** Coverage percentage 0–100 (how much of the doc has been surfaced). */
  coveragePercent?: number;
}

export interface RefinementPolicyResult {
  action:               RefinementAction;
  /** Stable hash key — changes when context meaningfully changes. */
  refinementGenKey:     string;
  /** Legacy integer (1–3) kept for backwards compatibility with cached responses. */
  refinementGeneration: number;
  reason:               string;
  triggerReason:        string;
  shouldAutoTrigger:    boolean;
  supersedesPrevious:   boolean;
  answerCompleteness:   "partial" | "complete";
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const DELTA_CHARS_THRESHOLD    = 500;
const DELTA_COVERAGE_THRESHOLD = 10;   // percentage points

// ── Fine-grained key ──────────────────────────────────────────────────────────

/**
 * Returns a stable hash that changes when context meaningfully changes.
 * Coverage is rounded to the nearest 10% bucket to avoid micro-trigger churn.
 */
export function computeFineGrainedRefinementKey(
  chunkIds:        string[],
  charCount:       number,
  coveragePercent: number,
  status:          string,
): string {
  const coverageBucket = Math.floor(Math.min(100, Math.max(0, coveragePercent)) / 10) * 10;
  const payload = [
    [...chunkIds].sort().join(","),
    String(charCount),
    String(coverageBucket),
    status,
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Determine whether a new refinement run should be triggered given
 * the change from previous to current context.
 */
export function shouldTriggerRefinement(opts: {
  prevKey:             string | null;
  prevCharCount:       number;
  prevCoveragePercent: number;
  currentKey:          string;
  currentCharCount:    number;
  currentCoveragePercent: number;
  currentStatus:       string;
}): { trigger: boolean; reason: string } {
  const {
    prevKey, prevCharCount, prevCoveragePercent,
    currentKey, currentCharCount, currentCoveragePercent, currentStatus,
  } = opts;

  if (!prevKey) return { trigger: true, reason: "no_previous_answer" };
  if (prevKey === currentKey) return { trigger: false, reason: "no_context_change" };

  const deltaChars    = currentCharCount    - prevCharCount;
  const deltaCoverage = currentCoveragePercent - prevCoveragePercent;

  const reasons: string[] = [];
  if (deltaChars >= DELTA_CHARS_THRESHOLD)    reasons.push(`delta_chars=${deltaChars}`);
  if (deltaCoverage >= DELTA_COVERAGE_THRESHOLD) reasons.push(`coverage_up=${deltaCoverage.toFixed(0)}%`);
  if (currentStatus === "completed")           reasons.push("status_completed");

  if (reasons.length > 0) return { trigger: true, reason: reasons.join(", ") };

  return { trigger: false, reason: "trivial_change_below_threshold" };
}

// ── Legacy generation integer (backwards compat) ───────────────────────────────

/**
 * Returns legacy gen integer (0–3) for callers that still use it.
 * Retained for backwards compatibility with answer-cache and live-answer-refinement.
 */
export function computeRefinementGeneration(state: OcrJobRefinementState): number {
  if (state.status === "completed")                         return 3;
  if (state.stage  === "partial_ready")                     return 1;
  if (state.stage  === "continuing" && state.charCount > 0) return 2;
  if (state.stage  === "chunking" || state.stage === "storing") return 2;
  if (state.charCount > 0)                                  return 1;
  return 0;
}

// ── Main policy evaluator ─────────────────────────────────────────────────────

/**
 * Evaluates whether a new refinement run should be triggered.
 *
 * @param prevGenKey      Fine-grained key of the last answer (null if no answer yet)
 * @param prevGeneration  Legacy integer of the last answer (0 if no answer yet)
 * @param prevCharCount   Char count when previous answer was generated
 * @param prevCoverage    Coverage % when previous answer was generated
 * @param currentState    Current OCR job state
 */
export function evaluateRefinementPolicy(
  prevGenKey:      string | null,
  prevGeneration:  number,
  prevCharCount:   number,
  prevCoverage:    number,
  currentState:    OcrJobRefinementState,
): RefinementPolicyResult {
  const gen = computeRefinementGeneration(currentState);
  const currentKey = computeFineGrainedRefinementKey(
    currentState.chunkIds    ?? [],
    currentState.charCount,
    currentState.coveragePercent ?? 0,
    currentState.status,
  );

  // ── Not ready ──────────────────────────────────────────────────────────────
  if (gen === 0 || (currentState.charCount === 0 && currentState.status !== "completed")) {
    return {
      action:               "not_ready",
      refinementGenKey:     currentKey,
      refinementGeneration: 0,
      reason:               "No usable text available yet",
      triggerReason:        "not_ready",
      shouldAutoTrigger:    false,
      supersedesPrevious:   false,
      answerCompleteness:   "partial",
    };
  }

  const { trigger, reason: triggerReason } = shouldTriggerRefinement({
    prevKey:             prevGenKey,
    prevCharCount,
    prevCoveragePercent: prevCoverage,
    currentKey,
    currentCharCount:    currentState.charCount,
    currentCoveragePercent: currentState.coveragePercent ?? 0,
    currentStatus:       currentState.status,
  });

  // ── No change ─────────────────────────────────────────────────────────────
  if (!trigger) {
    return {
      action:               "no_action",
      refinementGenKey:     currentKey,
      refinementGeneration: gen,
      reason:               `Refinement key unchanged or delta below threshold`,
      triggerReason,
      shouldAutoTrigger:    false,
      supersedesPrevious:   false,
      answerCompleteness:   gen === 3 ? "complete" : "partial",
    };
  }

  // ── First answer ──────────────────────────────────────────────────────────
  if (!prevGenKey) {
    return {
      action:               "start_first_answer",
      refinementGenKey:     currentKey,
      refinementGeneration: gen,
      reason:               `First usable OCR text available (chars=${currentState.charCount})`,
      triggerReason:        "no_previous_answer",
      shouldAutoTrigger:    true,
      supersedesPrevious:   false,
      answerCompleteness:   gen === 3 ? "complete" : "partial",
    };
  }

  // ── Final answer ──────────────────────────────────────────────────────────
  if (currentState.status === "completed") {
    return {
      action:               "finalize_answer",
      refinementGenKey:     currentKey,
      refinementGeneration: 3,
      reason:               "OCR job completed — all pages processed, finalizing answer",
      triggerReason,
      shouldAutoTrigger:    true,
      supersedesPrevious:   true,
      answerCompleteness:   "complete",
    };
  }

  // ── Refinement ────────────────────────────────────────────────────────────
  return {
    action:               "refine_answer",
    refinementGenKey:     currentKey,
    refinementGeneration: gen,
    reason:               `Context improved — ${triggerReason} (chars=${currentState.charCount}, pages=${currentState.pageCount})`,
    triggerReason,
    shouldAutoTrigger:    true,
    supersedesPrevious:   true,
    answerCompleteness:   "partial",
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function refinementActionLabel(action: RefinementAction): string {
  switch (action) {
    case "start_first_answer":  return "Starter delsvar fra tilgængeligt indhold…";
    case "refine_answer":       return "Forbedrer svar med mere indhold…";
    case "finalize_answer":     return "Færdiggør komplet svar…";
    case "no_action":           return "Venter på mere indhold…";
    case "not_ready":           return "Endnu ikke klar til svar";
  }
}
