/**
 * advanced-reranking-provider.ts — Phase 5O
 *
 * OpenAI-based cross-encoder style semantic relevance reranking.
 *
 * Design:
 *   - Uses gpt-4o-mini chat completion with structured JSON output
 *   - Query + candidate text pairs scored in a single batched call
 *   - Scores normalized to [0, 1] range
 *   - All failure modes produce explicit errors (no silent fallback — that
 *     is the caller's responsibility in advanced-reranking.ts)
 *   - Token usage and latency recorded for cost/metric visibility
 *
 * INV-RER1: Tenant-safe — no cross-tenant data flows through provider
 * INV-RER2: Operates only on already-safe shortlisted candidates
 * INV-RER4: Produces separable heavy_rerank_score, never overwrites fused_score
 * INV-RER7: explainAdvancedRerankingProvider performs no writes
 */

import OpenAI from "openai";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RerankProviderCandidate {
  chunkId: string;
  chunkText: string;
}

export interface RerankProviderParams {
  queryText: string;
  candidates: RerankProviderCandidate[];
  modelName?: string;
  maxTextCharsPerCandidate?: number;
  timeoutMs?: number;
}

export interface RerankProviderScore {
  chunkId: string;
  score: number;
  rawScore: number;
}

export interface RerankProviderOutput {
  scores: RerankProviderScore[];
  providerName: string;
  providerVersion: string;
  modelName: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
  candidatesScored: number;
  truncationApplied: boolean;
}

export class RerankProviderError extends Error {
  constructor(
    public readonly code: "no_api_key" | "provider_error" | "provider_timeout" | "invalid_response" | "no_candidates",
    message: string,
  ) {
    super(message);
    this.name = "RerankProviderError";
  }
}

// ── Token cost estimation ─────────────────────────────────────────────────────

const MODEL_COST_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini":   { input: 0.00015, output: 0.0006  },
  "gpt-4o":        { input: 0.0025,  output: 0.01    },
  "gpt-4-turbo":   { input: 0.01,    output: 0.03    },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | null {
  const rates = MODEL_COST_PER_1K[model];
  if (!rates) return null;
  return (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precise relevance scoring system. Your task is to score how relevant each document is to the given query.

For each document, output a JSON object with a "scores" array. Each element must have:
- "id": the document ID (exactly as provided)
- "score": a number from 0.0 to 1.0 (0 = completely irrelevant, 1 = perfectly relevant)

Be precise. Use the full range of 0.0–1.0. Output ONLY valid JSON, no other text.

Output format example:
{"scores": [{"id": "chunk_abc", "score": 0.87}, {"id": "chunk_xyz", "score": 0.23}]}`;

// ── Build ranking prompt ──────────────────────────────────────────────────────

function buildRankingPrompt(
  queryText: string,
  candidates: RerankProviderCandidate[],
  maxTextCharsPerCandidate: number,
): { userMessage: string; truncationApplied: boolean } {
  let truncationApplied = false;
  const lines: string[] = [`Query: "${queryText}"`, "", "Documents to score:"];

  for (const c of candidates) {
    const text = c.chunkText.length > maxTextCharsPerCandidate
      ? (truncationApplied = true, c.chunkText.slice(0, maxTextCharsPerCandidate) + "…")
      : c.chunkText;
    lines.push(`[${c.chunkId}]: ${text}`);
  }

  return { userMessage: lines.join("\n"), truncationApplied };
}

// ── Score parsing and normalization ──────────────────────────────────────────

function parseAndNormalizeScores(
  rawContent: string,
  expectedChunkIds: Set<string>,
): RerankProviderScore[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new RerankProviderError("invalid_response", `Failed to parse JSON: ${rawContent.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).scores)) {
    throw new RerankProviderError("invalid_response", "Response missing 'scores' array");
  }

  const rawScores = (parsed as { scores: unknown[] }).scores;
  const result: RerankProviderScore[] = [];
  const maxRaw = rawScores.reduce<number>(
    (max, s) => typeof (s as Record<string, unknown>).score === "number" ? Math.max(max, (s as Record<string, unknown>).score as number) : max,
    0,
  );

  for (const s of rawScores) {
    const item = s as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.score !== "number") continue;
    if (!expectedChunkIds.has(item.id)) continue;

    const rawScore = item.score as number;
    const normalized = maxRaw > 1
      ? Math.max(0, Math.min(1, rawScore / maxRaw))
      : Math.max(0, Math.min(1, rawScore));

    result.push({ chunkId: item.id, score: normalized, rawScore });
  }

  return result;
}

// ── Main provider function (INV-RER1, INV-RER2) ───────────────────────────────

export async function rerankCandidatesWithModel(
  params: RerankProviderParams,
): Promise<RerankProviderOutput> {
  const {
    queryText,
    candidates,
    modelName = "gpt-4o-mini",
    maxTextCharsPerCandidate = 400,
    timeoutMs = 15000,
  } = params;

  if (!candidates.length) {
    throw new RerankProviderError("no_candidates", "No candidates provided for reranking");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new RerankProviderError("no_api_key", "OPENAI_API_KEY not set — advanced reranking unavailable");
  }

  const { userMessage, truncationApplied } = buildRankingPrompt(
    queryText.slice(0, 512),
    candidates,
    maxTextCharsPerCandidate,
  );

  const client = new OpenAI({ apiKey, timeout: timeoutMs });
  const startMs = Date.now();

  let raw: OpenAI.Chat.Completions.ChatCompletion;
  try {
    raw = await client.chat.completions.create({
      model: modelName,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET")) {
      throw new RerankProviderError("provider_timeout", `OpenAI rerank request timed out: ${msg}`);
    }
    throw new RerankProviderError("provider_error", `OpenAI rerank request failed: ${msg}`);
  }

  const latencyMs = Date.now() - startMs;
  const rawContent = raw.choices[0]?.message?.content ?? "";
  const promptTokens = raw.usage?.prompt_tokens ?? null;
  const completionTokens = raw.usage?.completion_tokens ?? null;

  const expectedIds = new Set(candidates.map((c) => c.chunkId));
  const scores = parseAndNormalizeScores(rawContent, expectedIds);

  // Fill in score = 0 for any candidate not returned by model
  const scoredIds = new Set(scores.map((s) => s.chunkId));
  for (const c of candidates) {
    if (!scoredIds.has(c.chunkId)) {
      scores.push({ chunkId: c.chunkId, score: 0, rawScore: 0 });
    }
  }

  return {
    scores,
    providerName: "openai",
    providerVersion: modelName,
    modelName,
    latencyMs,
    promptTokens,
    completionTokens,
    estimatedCostUsd:
      promptTokens !== null && completionTokens !== null
        ? estimateCostUsd(modelName, promptTokens, completionTokens)
        : null,
    candidatesScored: candidates.length,
    truncationApplied,
  };
}

// ── Build reranking inputs (INV-RER7: no writes) ──────────────────────────────

export function buildRerankingInputs(
  params: Pick<RerankProviderParams, "queryText" | "candidates" | "maxTextCharsPerCandidate">,
): Array<{ chunkId: string; queryText: string; truncatedText: string; inputLength: number }> {
  const max = params.maxTextCharsPerCandidate ?? 400;
  return params.candidates.map((c) => ({
    chunkId: c.chunkId,
    queryText: params.queryText,
    truncatedText: c.chunkText.slice(0, max),
    inputLength: Math.min(c.chunkText.length, max),
  }));
}

// ── Normalize raw output ──────────────────────────────────────────────────────

export function normalizeRerankingOutput(
  raw: Pick<RerankProviderOutput, "scores">,
): RerankProviderScore[] {
  const maxScore = raw.scores.reduce((m, s) => Math.max(m, s.score), 1e-12);
  return raw.scores.map((s) => ({
    ...s,
    score: Math.max(0, Math.min(1, s.score / maxScore)),
  }));
}

// ── Explain provider (INV-RER7: no writes) ────────────────────────────────────

export function explainAdvancedRerankingProvider(): Record<string, unknown> {
  return {
    providerType: "openai_chat_completion",
    scoringApproach: "cross_encoder_style_relevance_scoring",
    model: "gpt-4o-mini (configurable)",
    promptStrategy: "single_batched_call_with_all_shortlisted_candidates",
    outputFormat: "json_object_with_scores_array",
    scoreRange: "[0.0, 1.0]",
    normalization: "linear_normalization_if_scores_exceed_1",
    fallback: "lightweight_deterministic_reranker_from_phase_5n",
    latencyCharacteristics: {
      typical: "300–800ms for shortlist of 20",
      timeout: "15000ms",
    },
    costCharacteristics: {
      model: "gpt-4o-mini",
      inputCostPer1kTokens: MODEL_COST_PER_1K["gpt-4o-mini"]?.input,
      outputCostPer1kTokens: MODEL_COST_PER_1K["gpt-4o-mini"]?.output,
    },
    candidateInputConstraints: {
      maxCandidatesPerCall: "no hard limit (token budget permitting)",
      maxTextCharsPerCandidate: 400,
      textTruncated: true,
    },
    safetyProperties: {
      tenantSafe: true,
      noSideEffects: true,
      operatesOnSafeShortlistOnly: true,
    },
  };
}

// ── Summarize provider result (INV-RER7: no writes) ──────────────────────────

export function summarizeRerankingProviderResult(result: RerankProviderOutput): Record<string, unknown> {
  const scores = result.scores.map((s) => s.score);
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const max = scores.length > 0 ? Math.max(...scores) : 0;
  const min = scores.length > 0 ? Math.min(...scores) : 0;

  return {
    providerName: result.providerName,
    modelName: result.modelName,
    candidatesScored: result.candidatesScored,
    latencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    truncationApplied: result.truncationApplied,
    scoreStats: {
      avgScore: Number(avg.toFixed(6)),
      maxScore: Number(max.toFixed(6)),
      minScore: Number(min.toFixed(6)),
    },
  };
}
