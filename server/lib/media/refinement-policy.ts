/**
 * refinement-policy.ts — Deterministic refinement policy for OCR-based documents.
 *
 * PHASE 5Z.5 — Decides when to start/refine/finalize answers for documents
 * processed via chat_ocr_tasks (upload/finalize → inline processor path).
 *
 * Separate from answer-improvement-policy.ts (which handles KB segment paths).
 * Pure function — no DB, no side effects.
 *
 * Refinement generation integers:
 *  0 = not started / no usable text
 *  1 = partial_ready (first page, early answer)
 *  2 = continuing with more pages (~25-75% done, refined answer)
 *  3 = completed (all pages done, final answer)
 *
 * Actions:
 *  - start_first_answer   — gen 0→1: first usable text arrived
 *  - refine_answer        — gen N→N+1: meaningfully more context
 *  - finalize_answer      — gen →3: job completed, no more improvements
 *  - no_action            — same generation or trivial update
 *  - not_ready            — no usable text yet
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RefinementAction =
  | "start_first_answer"
  | "refine_answer"
  | "finalize_answer"
  | "no_action"
  | "not_ready";

export interface OcrJobRefinementState {
  /** Current job status from chat_ocr_tasks. */
  status:    "pending" | "running" | "completed" | "failed" | "dead_letter";
  /** Current job stage from chat_ocr_tasks. */
  stage:     string | null;
  /** Characters extracted so far. */
  charCount: number;
  /** Pages processed so far. */
  pageCount: number;
}

export interface RefinementPolicyResult {
  action:               RefinementAction;
  refinementGeneration: number;
  reason:               string;
  shouldAutoTrigger:    boolean;
  supersedesPrevious:   boolean;
  answerCompleteness:   "partial" | "complete";
}

// ── Generation computation ─────────────────────────────────────────────────────

/**
 * Returns the refinement generation integer for a given OCR job state.
 * Deterministic: same state → same generation.
 */
export function computeRefinementGeneration(state: OcrJobRefinementState): number {
  if (state.status === "completed")                        return 3;
  if (state.stage  === "partial_ready")                    return 1;
  if (state.stage  === "continuing" && state.charCount > 0) return 2;
  if (state.stage  === "chunking" || state.stage === "storing") return 2;
  if (state.charCount > 0)                                 return 1;
  return 0;
}

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * Evaluates whether a new refinement run should be triggered.
 *
 * @param prevGeneration  Refinement generation of the last answer (0 if no answer yet)
 * @param currentState    Current OCR job state
 */
export function evaluateRefinementPolicy(
  prevGeneration: number,
  currentState:   OcrJobRefinementState,
): RefinementPolicyResult {
  const gen = computeRefinementGeneration(currentState);

  // ── Not ready ──────────────────────────────────────────────────────────────
  if (gen === 0 || (currentState.charCount === 0 && currentState.status !== "completed")) {
    return {
      action:               "not_ready",
      refinementGeneration: 0,
      reason:               "No usable text available yet",
      shouldAutoTrigger:    false,
      supersedesPrevious:   false,
      answerCompleteness:   "partial",
    };
  }

  // ── No change ─────────────────────────────────────────────────────────────
  if (gen === prevGeneration) {
    return {
      action:               "no_action",
      refinementGeneration: gen,
      reason:               `Refinement generation unchanged (${gen}) — no new context`,
      shouldAutoTrigger:    false,
      supersedesPrevious:   false,
      answerCompleteness:   gen === 3 ? "complete" : "partial",
    };
  }

  // ── First answer ──────────────────────────────────────────────────────────
  if (prevGeneration === 0 && gen >= 1) {
    return {
      action:               "start_first_answer",
      refinementGeneration: gen,
      reason:               `First usable OCR text available (gen=${gen}, chars=${currentState.charCount})`,
      shouldAutoTrigger:    true,
      supersedesPrevious:   false,
      answerCompleteness:   gen === 3 ? "complete" : "partial",
    };
  }

  // ── Final answer ──────────────────────────────────────────────────────────
  if (currentState.status === "completed" && gen === 3) {
    return {
      action:               "finalize_answer",
      refinementGeneration: 3,
      reason:               "OCR job completed — all pages processed, finalizing answer",
      shouldAutoTrigger:    true,
      supersedesPrevious:   true,
      answerCompleteness:   "complete",
    };
  }

  // ── Refinement ────────────────────────────────────────────────────────────
  if (gen > prevGeneration) {
    return {
      action:               "refine_answer",
      refinementGeneration: gen,
      reason:               `Context improved (gen ${prevGeneration}→${gen}, chars=${currentState.charCount}, pages=${currentState.pageCount})`,
      shouldAutoTrigger:    true,
      supersedesPrevious:   true,
      answerCompleteness:   "partial",
    };
  }

  // ── Default no-action ─────────────────────────────────────────────────────
  return {
    action:               "no_action",
    refinementGeneration: gen,
    reason:               `Regression or same generation (prev=${prevGeneration}, current=${gen})`,
    shouldAutoTrigger:    false,
    supersedesPrevious:   false,
    answerCompleteness:   "partial",
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Human-readable UX label for an action. */
export function refinementActionLabel(action: RefinementAction): string {
  switch (action) {
    case "start_first_answer":  return "Starter delsvar fra tilgængeligt indhold…";
    case "refine_answer":       return "Forbedrer svar med mere indhold…";
    case "finalize_answer":     return "Færdiggør komplet svar…";
    case "no_action":           return "Venter på mere indhold…";
    case "not_ready":           return "Endnu ikke klar til svar";
  }
}
