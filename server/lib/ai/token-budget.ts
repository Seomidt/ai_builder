/**
 * token-budget.ts — Phase 5E
 *
 * Token budget estimation and enforcement for retrieval context assembly.
 *
 * Design:
 *   - Fast character-based estimation (chars/4 ≈ tokens for English text)
 *   - Configurable overhead for metadata/formatting
 *   - Greedy selection: add chunks in rank order until budget exhausted
 *   - INV-RET5: token budget must NEVER be exceeded
 *   - No LLM calls — purely local estimation
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenBudgetOptions {
  maxTokens?: number;
  metadataOverheadTokens?: number;
  systemPromptReservedTokens?: number;
}

export interface TokenBudgetResult<T> {
  selected: T[];
  skippedBudget: T[];
  totalEstimatedTokens: number;
  budgetRemaining: number;
  budgetUtilizationPct: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_METADATA_OVERHEAD = 50;
const DEFAULT_SYSTEM_PROMPT_RESERVE = 0;

// ─── Estimation ───────────────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Uses chars/4 approximation. Conservative for English text; works for mixed content.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a chunk including header metadata overhead.
 */
export function estimateChunkTokens(
  text: string,
  metadataOverhead: number = DEFAULT_METADATA_OVERHEAD,
): number {
  return estimateTokens(text) + metadataOverhead;
}

// ─── Budget enforcement ───────────────────────────────────────────────────────

/**
 * Greedy token budget enforcement.
 *
 * Iterates chunks in rank order (ascending rank) and adds each until budget
 * is exhausted. Skipped chunks are tracked separately.
 *
 * INV-RET5: budget is never exceeded — if a chunk would push past the limit,
 * it is skipped (not truncated, not approximated).
 */
export function enforceTokenBudget<T extends { chunkText: string | null }>(
  chunks: T[],
  options: TokenBudgetOptions = {},
): TokenBudgetResult<T> {
  const {
    maxTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
    metadataOverheadTokens = DEFAULT_METADATA_OVERHEAD,
    systemPromptReservedTokens = DEFAULT_SYSTEM_PROMPT_RESERVE,
  } = options;

  const effectiveBudget = maxTokens - systemPromptReservedTokens;
  if (effectiveBudget <= 0) {
    return {
      selected: [],
      skippedBudget: [...chunks],
      totalEstimatedTokens: 0,
      budgetRemaining: effectiveBudget,
      budgetUtilizationPct: 0,
    };
  }

  const selected: T[] = [];
  const skippedBudget: T[] = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    const text = chunk.chunkText ?? "";
    const chunkTokens = estimateChunkTokens(text, metadataOverheadTokens);

    if (usedTokens + chunkTokens <= effectiveBudget) {
      selected.push(chunk);
      usedTokens += chunkTokens;
    } else {
      skippedBudget.push(chunk);
    }
  }

  return {
    selected,
    skippedBudget,
    totalEstimatedTokens: usedTokens,
    budgetRemaining: effectiveBudget - usedTokens,
    budgetUtilizationPct: effectiveBudget > 0 ? Math.round((usedTokens / effectiveBudget) * 100) : 0,
  };
}

/**
 * Check if adding a text would exceed the remaining budget.
 */
export function wouldExceedBudget(
  text: string,
  usedTokens: number,
  maxTokens: number,
  overhead: number = DEFAULT_METADATA_OVERHEAD,
): boolean {
  return usedTokens + estimateChunkTokens(text, overhead) > maxTokens;
}

/**
 * Format a human-readable budget summary.
 */
export function formatBudgetSummary(result: TokenBudgetResult<unknown>): string {
  return `${result.totalEstimatedTokens} tokens used of budget (${result.budgetUtilizationPct}% utilized, ${result.budgetRemaining} remaining), ${result.selected.length} selected, ${result.skippedBudget.length} skipped`;
}
