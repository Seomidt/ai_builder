/**
 * Phase 5C — Embedding Provider Abstraction
 *
 * Providers:
 *   - OpenAI text-embedding-3-small (1536-dim, default)
 *   - OpenAI text-embedding-3-large (3072-dim)
 *   - stub_embedding (deterministic, no API call — for tests)
 *
 * All providers implement EmbeddingProvider interface.
 * No silent fallbacks — explicit failure on missing API key or unsupported model.
 *
 * Server-only. Never import from client/.
 */

import OpenAI from "openai";
import { createHash } from "crypto";

// ─── Provider output ──────────────────────────────────────────────────────────

export interface EmbeddingBatchResult {
  vectors: number[][];
  dimensions: number;
  model: string;
  provider: string;
  tokenUsage: number;
  estimatedCostUsd: number;
}

export interface EmbeddingProviderInfo {
  name: string;
  version: string;
  model: string;
  dimensions: number;
  maxBatchSize: number;
  costPerToken: number;
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface EmbeddingProvider {
  info: EmbeddingProviderInfo;
  generateBatch(texts: string[]): Promise<EmbeddingBatchResult>;
}

// ─── Cost table (USD per token) ───────────────────────────────────────────────

const COST_PER_TOKEN: Record<string, number> = {
  "text-embedding-3-small": 0.00000002,
  "text-embedding-3-large": 0.00000013,
  "text-embedding-ada-002": 0.0000001,
};

// ─── OpenAI provider factory ──────────────────────────────────────────────────

function buildOpenAIProvider(model: string, dims: number): EmbeddingProvider {
  const info: EmbeddingProviderInfo = {
    name: "openai",
    version: "1.0",
    model,
    dimensions: dims,
    maxBatchSize: 100,
    costPerToken: COST_PER_TOKEN[model] ?? 0.00000002,
  };

  return {
    info,
    async generateBatch(texts: string[]): Promise<EmbeddingBatchResult> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          `Embedding provider '${info.name}' requires OPENAI_API_KEY. API key not set. Explicit failure — no silent fallback.`,
        );
      }
      if (!texts || texts.length === 0) {
        throw new Error("generateBatch called with empty texts array. Explicit failure.");
      }

      const client = new OpenAI({ apiKey });

      const response = await client.embeddings.create({
        model,
        input: texts,
        encoding_format: "float",
      });

      const vectors = response.data.map((d) => d.embedding);
      const tokenUsage = response.usage?.total_tokens ?? 0;
      const costPerToken = COST_PER_TOKEN[model] ?? 0.00000002;
      const estimatedCostUsd = tokenUsage * costPerToken;

      return {
        vectors,
        dimensions: dims,
        model,
        provider: "openai",
        tokenUsage,
        estimatedCostUsd,
      };
    },
  };
}

// ─── Stub provider (deterministic, no API call) ───────────────────────────────
/**
 * Produces deterministic pseudo-vectors using SHA256 of text.
 * Used for validation, tests, and development without API access.
 */
export const stubEmbeddingProvider: EmbeddingProvider = {
  info: {
    name: "stub_embedding",
    version: "1.0",
    model: "stub-1536",
    dimensions: 1536,
    maxBatchSize: 1000,
    costPerToken: 0,
  },
  async generateBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (!texts || texts.length === 0) {
      throw new Error("generateBatch called with empty texts array. Explicit failure.");
    }
    const vectors = texts.map((text) => {
      const hash = createHash("sha256").update(text, "utf8").digest();
      const vector: number[] = [];
      for (let i = 0; i < 1536; i++) {
        const byte = hash[i % 32];
        vector.push((byte / 255) * 2 - 1);
      }
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      return vector.map((v) => (norm > 0 ? v / norm : 0));
    });
    return {
      vectors,
      dimensions: 1536,
      model: "stub-1536",
      provider: "stub_embedding",
      tokenUsage: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      estimatedCostUsd: 0,
    };
  },
};

// ─── Built-in providers ───────────────────────────────────────────────────────

export const openaiSmallEmbeddingProvider = buildOpenAIProvider("text-embedding-3-small", 1536);
export const openaiLargeEmbeddingProvider = buildOpenAIProvider("text-embedding-3-large", 3072);

// ─── Provider selection ───────────────────────────────────────────────────────

export type EmbeddingProviderName =
  | "openai_small"
  | "openai_large"
  | "openai"
  | "stub_embedding";

export function selectEmbeddingProvider(name?: EmbeddingProviderName | string): EmbeddingProvider {
  const n = name ?? "openai_small";
  switch (n) {
    case "openai_small":
    case "openai":
      return openaiSmallEmbeddingProvider;
    case "openai_large":
      return openaiLargeEmbeddingProvider;
    case "stub_embedding":
      return stubEmbeddingProvider;
    default:
      throw new Error(
        `Unknown embedding provider '${n}'. Supported: openai_small, openai_large, stub_embedding. Explicit failure — no silent fallback.`,
      );
  }
}

// ─── Batch splitter ───────────────────────────────────────────────────────────

export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// ─── Vector normalization ─────────────────────────────────────────────────────

export function normalizeEmbeddingVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((v) => v / norm);
}

// ─── Content hash for dedup ───────────────────────────────────────────────────

export function computeEmbeddingContentHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}::${text}`, "utf8").digest("hex").slice(0, 24);
}

// ─── Cost summary ─────────────────────────────────────────────────────────────

export function summarizeEmbeddingCost(results: EmbeddingBatchResult[]): {
  totalTokens: number;
  totalCostUsd: number;
  batchCount: number;
  vectorCount: number;
} {
  return {
    totalTokens: results.reduce((s, r) => s + r.tokenUsage, 0),
    totalCostUsd: results.reduce((s, r) => s + r.estimatedCostUsd, 0),
    batchCount: results.length,
    vectorCount: results.reduce((s, r) => s + r.vectors.length, 0),
  };
}
