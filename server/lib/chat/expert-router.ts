/**
 * expert-router.ts — Automatic expert selection (no user choice required).
 *
 * Improvements over the original chat-routing.ts selectBestExpert():
 *  - Returns top-N experts (not just 1) for hybrid routing
 *  - Distinguishes "strong match" (score >= STRONG_MATCH_THRESHOLD)
 *    from "weak/default match" (score < threshold)
 *  - Returns null if absolutely no experts are accessible (no fallback)
 *  - Never trusts client-provided expert IDs (always re-verified)
 */

import {
  listAccessibleExpertsForUser,
  scoreExpertsForMessage,
  verifyExpertAccess,
  type AccessibleExpert,
} from "../../services/chat-routing.ts";

export const STRONG_MATCH_THRESHOLD = 6;   // score >= this → "relevant" expert
export const TOP_N_EXPERTS          = 3;   // max experts for hybrid routing

export interface ExpertMatch {
  expert:      AccessibleExpert;
  score:       number;
  isRelevant:  boolean;   // score >= STRONG_MATCH_THRESHOLD
  explanation: string;
}

export interface ExpertRoutingResult {
  /** Best matching experts, sorted descending by score (up to TOP_N_EXPERTS) */
  experts:          ExpertMatch[];
  /** True if at least one expert has score >= STRONG_MATCH_THRESHOLD */
  hasRelevantMatch: boolean;
  /** The single best expert for non-hybrid routing */
  primary:          ExpertMatch | null;
}

/**
 * Automatically select the best expert(s) for a message.
 * Always tenant-scoped. No user input required for selection.
 *
 * Returns ExpertRoutingResult with 0 experts if no accessible experts exist.
 */
export async function autoSelectExperts(params: {
  message:        string;
  organizationId: string;
  topN?:          number;
}): Promise<ExpertRoutingResult> {
  const { message, organizationId, topN = TOP_N_EXPERTS } = params;

  const accessible = await listAccessibleExpertsForUser({ organizationId });
  if (accessible.length === 0) {
    return { experts: [], hasRelevantMatch: false, primary: null };
  }

  const scored = scoreExpertsForMessage(accessible, message);
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  const topExperts: ExpertMatch[] = sorted.slice(0, topN).map((e) => ({
    expert:     e,
    score:      e.score,
    isRelevant: e.score >= STRONG_MATCH_THRESHOLD,
    explanation: e.score >= STRONG_MATCH_THRESHOLD
      ? `Stærkt match '${e.name}' (score: ${e.score})`
      : `Svagt match '${e.name}' (score: ${e.score}) — bruges som fallback`,
  }));

  const hasRelevantMatch = topExperts.some((e) => e.isRelevant);
  const primary          = topExperts[0] ?? null;

  return { experts: topExperts, hasRelevantMatch, primary };
}

/**
 * Verify that a client-provided preferred_expert_id is accessible.
 * Returns the expert match if valid, null otherwise.
 * Always enforces tenant isolation.
 */
export async function verifyPreferredExpert(params: {
  expertId:       string;
  organizationId: string;
  message:        string;
}): Promise<ExpertMatch | null> {
  const expert = await verifyExpertAccess({
    expertId:       params.expertId,
    organizationId: params.organizationId,
  });

  if (!expert) return null;

  const scored = scoreExpertsForMessage([expert], params.message);
  const score  = scored[0]?.score ?? 0;

  return {
    expert,
    score,
    isRelevant:  true, // user explicitly chose → treat as relevant
    explanation: `Brugervalgt ekspert '${expert.name}' verificeret (score: ${score})`,
  };
}
