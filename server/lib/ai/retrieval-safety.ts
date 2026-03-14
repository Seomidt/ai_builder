/**
 * retrieval-safety.ts — Phase 5Q
 *
 * Prompt-injection and context-poisoning detection in retrieved context.
 *
 * Design invariants:
 *   INV-QUAL5  Safety review must be explainable
 *   INV-QUAL6  Safety review must not fabricate evidence
 *   INV-QUAL7  Answer generation uses only safety-reviewed context
 *   INV-QUAL8  Preview/explain endpoints perform no writes
 *   INV-QUAL9  Metrics are tenant-isolated
 *
 * Safety status values:
 *   no_issue   — no patterns matched
 *   suspicious — 1-2 injection patterns found
 *   high_risk  — 3+ injection patterns found
 *
 * Safety mode behavior (from retrieval-config.ts):
 *   monitor_only    — flag but retain all chunks
 *   downrank        — reduce scores of suspicious/high_risk chunks
 *   exclude_high_risk — remove high_risk chunks; retain suspicious ones
 *
 * Exclusion reason codes added:
 *   prompt_injection_risk
 *   context_poisoning_risk
 *   unsafe_instructional_content
 *
 * Inclusion/flagging codes:
 *   retained_with_safety_flag
 *   downranked_for_safety_review
 *   included_after_safety_review
 */

import {
  RETRIEVAL_SAFETY_MODE,
  SAFETY_SUSPICIOUS_THRESHOLD,
  SAFETY_HIGH_RISK_THRESHOLD,
  SAFETY_DOWNRANK_SUSPICIOUS_FACTOR,
  SAFETY_DOWNRANK_HIGH_RISK_FACTOR,
  type RetrievalSafetyMode,
} from "../config/retrieval-config";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SafetyStatus = "no_issue" | "suspicious" | "high_risk";

export interface SafetyChunkInput {
  chunkId: string;
  chunkText: string;
  documentId?: string;
  sourceType?: string;
  finalScore?: number;
}

export interface SafetyFlaggedChunk {
  chunkId: string;
  safetyStatus: SafetyStatus;
  patternMatchCount: number;
  patternMatches: string[];
  reasons: string[];
  originalScore: number;
  adjustedScore: number;
  action: "retained" | "downranked" | "excluded";
  actionReason: string;
}

export interface RetrievalSafetySummary {
  overallStatus: SafetyStatus;
  flaggedChunkCount: number;
  highRiskCount: number;
  suspiciousCount: number;
  totalChunksReviewed: number;
  excludedCount: number;
  flaggedChunks: SafetyFlaggedChunk[];
  safetyMode: RetrievalSafetyMode;
  note: string;
}

// ── Injection detection patterns ──────────────────────────────────────────────
// All patterns are case-insensitive regex. Ordered by specificity.
// INV-QUAL6: Only fire when evidence is present — no false fabrication.

const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "ignore_previous_instructions", pattern: /ignore\s+(previous|prior|all|your)\s+instructions?/i },
  { name: "disregard_directive",          pattern: /disregard\s+(the|all|your|previous|above|prior|following)/i },
  { name: "you_are_now",                  pattern: /\byou\s+are\s+now\s+(a|an|the|acting|supposed)\b/i },
  { name: "act_as_override",              pattern: /\bact\s+as\s+(a|an|the)\s+\w+\s*(and|that|who|with)/i },
  { name: "new_role_directive",           pattern: /\byour\s+(new\s+)?(role|instructions?|task|prompt|system\s+prompt|directive)\s*(?:is|are|:)/i },
  { name: "system_prompt_reference",      pattern: /\bsystem\s*prompt\b/i },
  { name: "assistant_colon",             pattern: /\bassistant\s*:/i },
  { name: "new_instructions_colon",      pattern: /\bnew\s+instructions?\s*:/i },
  { name: "do_not_follow",               pattern: /\bdo\s+not\s+(follow|obey|comply\s+with)/i },
  { name: "forget_instructions",         pattern: /\bforget\s+(your|all|previous|prior|the\s+(?:above|previous))/i },
  { name: "override_system",             pattern: /\boverride\s+(the\s+)?(system|safety|rules?|guidelines?|policy)/i },
  { name: "inject_payload",              pattern: /\binject(ion|ed)?\s+(payload|command|prompt|instruction)/i },
  { name: "jailbreak_marker",            pattern: /\b(jailbreak|dan\s+mode|developer\s+mode)\b/i },
  { name: "base64_instruction_hint",     pattern: /\b(decode|base64)\b.*\b(instruction|command|prompt)\b/i },
  { name: "print_system_prompt",         pattern: /\bprint\s+(the\s+)?(system\s+prompt|instructions?|original\s+prompt)/i },
];

// ── Pattern matching ──────────────────────────────────────────────────────────

function matchInjectionPatterns(text: string): string[] {
  const matched: string[] = [];
  for (const { name, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(name);
    }
  }
  return matched;
}

function classifyChunkSafety(matchCount: number): SafetyStatus {
  if (matchCount >= SAFETY_HIGH_RISK_THRESHOLD) return "high_risk";
  if (matchCount >= SAFETY_SUSPICIOUS_THRESHOLD) return "suspicious";
  return "no_issue";
}

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Detect prompt-injection style content in retrieved chunks (INV-QUAL5/6).
 * Returns flagged chunks with explainable evidence.
 * Does not write to DB (INV-QUAL8 when used for preview).
 */
export function detectPromptInjectionInContext(
  chunks: SafetyChunkInput[],
  safetyMode: RetrievalSafetyMode = RETRIEVAL_SAFETY_MODE,
): SafetyFlaggedChunk[] {
  const flagged: SafetyFlaggedChunk[] = [];

  for (const chunk of chunks) {
    const matches = matchInjectionPatterns(chunk.chunkText);
    const status = classifyChunkSafety(matches.length);
    const originalScore = chunk.finalScore ?? 0;

    if (status === "no_issue") continue; // INV-QUAL6: no false flags

    let adjustedScore = originalScore;
    let action: SafetyFlaggedChunk["action"] = "retained";
    let actionReason = "retained_with_safety_flag";

    if (safetyMode === "downrank") {
      const factor = status === "high_risk"
        ? SAFETY_DOWNRANK_HIGH_RISK_FACTOR
        : SAFETY_DOWNRANK_SUSPICIOUS_FACTOR;
      adjustedScore = parseFloat((originalScore * factor).toFixed(8));
      action = "downranked";
      actionReason = "downranked_for_safety_review";
    } else if (safetyMode === "exclude_high_risk" && status === "high_risk") {
      adjustedScore = 0;
      action = "excluded";
      actionReason = "prompt_injection_risk";
    }

    const reasons = matches.map((m) => {
      if (m === "jailbreak_marker") return "unsafe_instructional_content";
      if (m.includes("inject")) return "prompt_injection_risk";
      if (["system_prompt_reference", "new_role_directive", "you_are_now"].includes(m))
        return "context_poisoning_risk";
      return "prompt_injection_risk";
    });

    flagged.push({
      chunkId: chunk.chunkId,
      safetyStatus: status,
      patternMatchCount: matches.length,
      patternMatches: matches,
      reasons: [...new Set(reasons)],
      originalScore,
      adjustedScore,
      action,
      actionReason,
    });
  }

  return flagged;
}

/**
 * Detect broader context-poisoning signals across the full chunk set.
 * Looks at cross-chunk patterns that may indicate coordinated poisoning.
 * INV-QUAL5/6: only signals when evidence is found.
 */
export function detectContextPoisoningSignals(
  chunks: SafetyChunkInput[],
): {
  poisoningDetected: boolean;
  signals: string[];
  affectedChunkIds: string[];
  note: string;
} {
  const signals: string[] = [];
  const affectedChunkIds: string[] = [];

  if (chunks.length === 0) {
    return { poisoningDetected: false, signals: [], affectedChunkIds: [], note: "No chunks to review" };
  }

  // Signal 1: Abnormal concentration — one source document contributes >60% of injection matches
  const docMatchCounts = new Map<string, number>();
  for (const chunk of chunks) {
    const matchCount = matchInjectionPatterns(chunk.chunkText).length;
    if (matchCount > 0 && chunk.documentId) {
      docMatchCounts.set(chunk.documentId, (docMatchCounts.get(chunk.documentId) ?? 0) + matchCount);
    }
  }

  const totalMatches = [...docMatchCounts.values()].reduce((a, b) => a + b, 0);
  if (totalMatches > 0) {
    for (const [docId, docMatches] of docMatchCounts.entries()) {
      if (docMatches / totalMatches > 0.6) {
        signals.push(`concentrated_injection_source:doc=${docId}`);
        const docChunks = chunks.filter((c) => c.documentId === docId && matchInjectionPatterns(c.chunkText).length > 0);
        affectedChunkIds.push(...docChunks.map((c) => c.chunkId));
      }
    }
  }

  // Signal 2: Multiple chunks from the same document with injection patterns
  for (const [docId, count] of docMatchCounts.entries()) {
    if (count >= 2) {
      signals.push(`multi_chunk_injection_from_same_doc:doc=${docId}`);
    }
  }

  // Signal 3: Abnormally long instruction sequences
  for (const chunk of chunks) {
    const injectionWords = ["instructions", "directive", "system", "prompt", "override", "ignore"];
    const wordCount = chunk.chunkText.toLowerCase().split(/\s+/).length;
    const injectionWordCount = injectionWords.filter((w) => chunk.chunkText.toLowerCase().includes(w)).length;
    if (wordCount > 20 && injectionWordCount / wordCount > 0.2) {
      signals.push(`abnormal_instruction_density:chunk=${chunk.chunkId}`);
      if (!affectedChunkIds.includes(chunk.chunkId)) affectedChunkIds.push(chunk.chunkId);
    }
  }

  return {
    poisoningDetected: signals.length > 0,
    signals: [...new Set(signals)],
    affectedChunkIds: [...new Set(affectedChunkIds)],
    note: signals.length > 0
      ? `${signals.length} poisoning signal(s) detected`
      : "No poisoning signals detected",
  };
}

// ── Safety summary ────────────────────────────────────────────────────────────

/**
 * Build a complete safety summary for a set of chunks.
 * This is the pre-answer safety gate (INV-QUAL7).
 * INV-QUAL8: does not persist — caller decides persistence.
 */
export function buildRetrievalSafetySummary(
  chunks: SafetyChunkInput[],
  safetyMode: RetrievalSafetyMode = RETRIEVAL_SAFETY_MODE,
): RetrievalSafetySummary {
  const flaggedChunks = detectPromptInjectionInContext(chunks, safetyMode);
  const poisoningSignals = detectContextPoisoningSignals(chunks);

  const highRiskCount = flaggedChunks.filter((c) => c.safetyStatus === "high_risk").length;
  const suspiciousCount = flaggedChunks.filter((c) => c.safetyStatus === "suspicious").length;
  const excludedCount = flaggedChunks.filter((c) => c.action === "excluded").length;

  // Add poisoning-affected chunks that aren't already flagged
  for (const affectedId of poisoningSignals.affectedChunkIds) {
    if (!flaggedChunks.some((f) => f.chunkId === affectedId)) {
      const chunk = chunks.find((c) => c.chunkId === affectedId);
      if (chunk) {
        flaggedChunks.push({
          chunkId: affectedId,
          safetyStatus: "suspicious",
          patternMatchCount: 0,
          patternMatches: [],
          reasons: ["context_poisoning_risk"],
          originalScore: chunk.finalScore ?? 0,
          adjustedScore: chunk.finalScore ?? 0,
          action: "retained",
          actionReason: "retained_with_safety_flag",
        });
      }
    }
  }

  const totalFlagged = flaggedChunks.length;

  let overallStatus: SafetyStatus = "no_issue";
  if (highRiskCount > 0) overallStatus = "high_risk";
  else if (totalFlagged > 0 || poisoningSignals.poisoningDetected) overallStatus = "suspicious";

  return {
    overallStatus,
    flaggedChunkCount: totalFlagged,
    highRiskCount,
    suspiciousCount,
    totalChunksReviewed: chunks.length,
    excludedCount,
    flaggedChunks,
    safetyMode,
    note: overallStatus === "no_issue"
      ? "No safety issues detected in retrieved context"
      : `Safety issues detected: ${highRiskCount} high_risk, ${suspiciousCount} suspicious, ${excludedCount} excluded`,
  };
}

/**
 * Apply safety decisions to a chunk list, returning only safe/retained chunks.
 * INV-QUAL7: answer generation receives only safety-reviewed context.
 */
export function applySafetyFilterToChunks<T extends { chunkId: string; finalScore?: number }>(
  chunks: T[],
  safetySummary: RetrievalSafetySummary,
): T[] {
  const excludedIds = new Set(
    safetySummary.flaggedChunks
      .filter((f) => f.action === "excluded")
      .map((f) => f.chunkId),
  );

  const scoreAdjustments = new Map(
    safetySummary.flaggedChunks
      .filter((f) => f.action === "downranked")
      .map((f) => [f.chunkId, f.adjustedScore]),
  );

  return chunks
    .filter((c) => !excludedIds.has(c.chunkId))
    .map((c) => {
      if (scoreAdjustments.has(c.chunkId)) {
        return { ...c, finalScore: scoreAdjustments.get(c.chunkId) };
      }
      return c;
    });
}

// ── Explain (read-only, INV-QUAL8) ────────────────────────────────────────────

export function explainRetrievalSafety(safetySummary: RetrievalSafetySummary): {
  overallStatus: SafetyStatus;
  stages: Array<{ stage: string; status: string; detail: string }>;
  flaggedChunkDetails: Array<{
    chunkId: string;
    status: SafetyStatus;
    patterns: string[];
    action: string;
    actionReason: string;
  }>;
  note: string;
} {
  const stages = [
    {
      stage: "injection_detection",
      status: safetySummary.flaggedChunkCount > 0 ? "issues_found" : "clean",
      detail: `${safetySummary.flaggedChunkCount} chunk(s) flagged out of ${safetySummary.totalChunksReviewed} reviewed`,
    },
    {
      stage: "risk_classification",
      status: safetySummary.overallStatus,
      detail: `${safetySummary.highRiskCount} high_risk, ${safetySummary.suspiciousCount} suspicious`,
    },
    {
      stage: "safety_action",
      status: safetySummary.safetyMode,
      detail: safetySummary.excludedCount > 0
        ? `${safetySummary.excludedCount} chunk(s) excluded from context`
        : safetySummary.flaggedChunkCount > 0
        ? `${safetySummary.flaggedChunkCount} chunk(s) flagged/downranked; none excluded`
        : "No action needed",
    },
  ];

  const flaggedChunkDetails = safetySummary.flaggedChunks.map((f) => ({
    chunkId: f.chunkId,
    status: f.safetyStatus,
    patterns: f.patternMatches,
    action: f.action,
    actionReason: f.actionReason,
  }));

  return {
    overallStatus: safetySummary.overallStatus,
    stages,
    flaggedChunkDetails,
    note: "Read-only explanation. INV-QUAL8: no writes performed.",
  };
}
