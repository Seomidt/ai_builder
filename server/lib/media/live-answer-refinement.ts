/**
 * live-answer-refinement.ts — Live answer refinement lifecycle engine.
 *
 * PHASE 5Z.5 — Manages the state machine for progressive answer improvement
 * as OCR processing completes page by page.
 *
 * Lifecycle:
 *   no_answer → first_partial_answer → refined_partial_answer → finalized_complete_answer
 *
 * Rules:
 *  - Each state transition requires a meaningful context improvement (refinement gen bump)
 *  - Duplicate refinement runs for same generation are rejected
 *  - Final answer supersedes all previous partial answers
 *  - Tenant-scoped: each session key is tenant-isolated
 *  - Pure state transitions — no DB writes (callers handle persistence)
 */

import {
  evaluateRefinementPolicy,
  computeRefinementGeneration,
  type OcrJobRefinementState,
  type RefinementAction,
  type RefinementPolicyResult,
} from "./refinement-policy.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnswerLifecycleState =
  | "no_answer"
  | "first_partial_answer"
  | "refined_partial_answer"
  | "finalized_complete_answer";

export interface RefinementSession {
  /** Tenant-scoped session key: tenantId + ':' + taskId + ':' + userId */
  sessionKey:            string;
  /** Current lifecycle state. */
  lifecycleState:        AnswerLifecycleState;
  /** Last emitted refinement generation (0 = none). */
  lastGeneration:        number;
  /** ISO timestamp of last refinement. */
  lastRefinedAt:         string | null;
  /** Number of refinement runs completed. */
  refinementCount:       number;
  /** ISO timestamp of first partial answer. */
  firstAnswerAt:         string | null;
  /** ISO timestamp of final answer. */
  finalAnswerAt:         string | null;
}

export interface RefinementTransition {
  /** The policy decision. */
  policy:              RefinementPolicyResult;
  /** Previous lifecycle state. */
  previousState:       AnswerLifecycleState;
  /** New lifecycle state after transition. */
  newState:            AnswerLifecycleState;
  /** Whether a new answer should be generated. */
  shouldGenerateAnswer: boolean;
  /** The generation number that was superseded (null if none). */
  supersedesGeneration: number | null;
  /** Observability metrics for this transition. */
  metrics: {
    action:               RefinementAction;
    refinementGeneration: number;
    refinementCount:      number;
    ts:                   string;
  };
}

// ── Module-level session store (per-process, bounded) ────────────────────────

const _sessions = new Map<string, RefinementSession>();
const MAX_SESSIONS = 1000;

// ── Session management ────────────────────────────────────────────────────────

/**
 * Returns or creates a refinement session for the given key.
 * Key format: `${tenantId}:${taskId}:${userId}`
 */
export function getOrCreateSession(sessionKey: string): RefinementSession {
  const existing = _sessions.get(sessionKey);
  if (existing) return existing;

  const session: RefinementSession = {
    sessionKey,
    lifecycleState:  "no_answer",
    lastGeneration:  0,
    lastRefinedAt:   null,
    refinementCount: 0,
    firstAnswerAt:   null,
    finalAnswerAt:   null,
  };
  _sessions.set(sessionKey, session);

  // Prune if over capacity
  if (_sessions.size > MAX_SESSIONS) {
    const oldest = [..._sessions.entries()]
      .filter(([, v]) => v.lastRefinedAt !== null)
      .sort((a, b) => (a[1].lastRefinedAt ?? "").localeCompare(b[1].lastRefinedAt ?? ""))
      .slice(0, 100)
      .map(([k]) => k);
    oldest.forEach(k => _sessions.delete(k));
  }

  return session;
}

/** Explicitly remove a session (e.g. after final answer is delivered). */
export function clearSession(sessionKey: string): void {
  _sessions.delete(sessionKey);
}

// ── Transition engine ─────────────────────────────────────────────────────────

/**
 * Evaluates the next lifecycle transition for a session given the current OCR state.
 * Mutates the session in-place if the transition is valid.
 *
 * Returns the transition result including whether a new answer should be generated.
 * Does NOT generate the answer itself — caller is responsible.
 */
export function evaluateRefinementTransition(
  session:      RefinementSession,
  currentState: OcrJobRefinementState,
): RefinementTransition {
  const policy       = evaluateRefinementPolicy(session.lastGeneration, currentState);
  const previousState = session.lifecycleState;
  const now          = new Date().toISOString();

  // ── Guard: no-op states ────────────────────────────────────────────────────
  if (policy.action === "no_action" || policy.action === "not_ready") {
    return {
      policy,
      previousState,
      newState:             previousState,
      shouldGenerateAnswer: false,
      supersedesGeneration: null,
      metrics: {
        action:               policy.action,
        refinementGeneration: policy.refinementGeneration,
        refinementCount:      session.refinementCount,
        ts:                   now,
      },
    };
  }

  // ── Compute new lifecycle state ────────────────────────────────────────────
  let newState: AnswerLifecycleState;
  switch (policy.action) {
    case "start_first_answer":  newState = "first_partial_answer";      break;
    case "refine_answer":       newState = "refined_partial_answer";     break;
    case "finalize_answer":     newState = "finalized_complete_answer";  break;
    default:                    newState = previousState;
  }

  const supersedesGeneration = policy.supersedesPrevious && session.lastGeneration > 0
    ? session.lastGeneration
    : null;

  // ── Mutate session ────────────────────────────────────────────────────────
  session.lifecycleState   = newState;
  session.lastGeneration   = policy.refinementGeneration;
  session.lastRefinedAt    = now;
  session.refinementCount += 1;
  if (policy.action === "start_first_answer") session.firstAnswerAt = now;
  if (policy.action === "finalize_answer")    session.finalAnswerAt = now;

  return {
    policy,
    previousState,
    newState,
    shouldGenerateAnswer: true,
    supersedesGeneration,
    metrics: {
      action:               policy.action,
      refinementGeneration: policy.refinementGeneration,
      refinementCount:      session.refinementCount,
      ts:                   now,
    },
  };
}

// ── Observability ─────────────────────────────────────────────────────────────

/** Returns the current session count (diagnostic). */
export function getSessionCount(): number { return _sessions.size; }

/** Returns a snapshot of a session (diagnostic / logging). */
export function snapshotSession(sessionKey: string): RefinementSession | null {
  return _sessions.get(sessionKey) ?? null;
}
