/**
 * KB Embeddings Service — Storage 1.2
 *
 * Generates real OpenAI embeddings for knowledge_chunks and stores results
 * in knowledge_embeddings. Idempotent per (chunk, model) pair.
 *
 * Used by: kb-worker.ts (embedding_generate jobs) + kb-retrieval.ts (query embedding)
 */

import { db } from "../../db.ts";
import { knowledgeChunks, knowledgeEmbeddings } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { isOpenAIAvailable, getOpenAIClient } from "../openai-client.ts";

export const EMBEDDING_MODEL  = "text-embedding-3-small";
export const EMBEDDING_DIMS   = 1536;
const BATCH_SIZE               = 20;   // max chunks per API call (OpenAI limit: 2048)
const MAX_CHUNK_TOKENS         = 8000; // safe limit for text-embedding-3-small
const COST_PER_1K_TOKENS       = 0.00002; // USD — text-embedding-3-small

// ── generateQueryEmbedding ─────────────────────────────────────────────────────
// Returns a real 1536-dim embedding vector for a query string.
// Falls back to null if OpenAI is unavailable (retrieval degrades to lexical only).

export async function generateQueryEmbedding(queryText: string): Promise<number[] | null> {
  if (!isOpenAIAvailable()) return null;
  try {
    const client = getOpenAIClient();
    const resp = await client.embeddings.create({
      model:           EMBEDDING_MODEL,
      input:           queryText.slice(0, MAX_CHUNK_TOKENS * 4),
      encoding_format: "float",
    });
    return resp.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn("[kb-embeddings] query embedding failed:", (err as Error).message);
    return null;
  }
}

// ── generateChunkEmbeddings ────────────────────────────────────────────────────
// Generates embeddings for all unembedded active chunks in a document version.
// Idempotent: skips chunks that already have a completed embedding.
// Tenant-scoped — strictly isolated.

export async function generateChunkEmbeddings(params: {
  tenantId:                  string;
  knowledgeBaseId:           string;
  knowledgeDocumentId:       string;
  knowledgeDocumentVersionId: string;
  maxChunks?:                number;
}): Promise<{ generated: number; failed: number; skipped: number; tokenUsage: number }> {
  const { tenantId, knowledgeBaseId, knowledgeDocumentId, knowledgeDocumentVersionId } = params;
  const maxChunks = Math.min(params.maxChunks ?? 500, 500);

  if (!isOpenAIAvailable()) {
    console.warn("[kb-embeddings] OPENAI_API_KEY not set — cannot generate embeddings");
    return { generated: 0, failed: 0, skipped: 0, tokenUsage: 0 };
  }

  // Find chunks without completed embeddings
  const allChunks = await db
    .select({ id: knowledgeChunks.id, chunkText: knowledgeChunks.chunkText })
    .from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.tenantId, tenantId),
      eq(knowledgeChunks.knowledgeDocumentVersionId, knowledgeDocumentVersionId),
      eq(knowledgeChunks.chunkActive, true),
    ))
    .limit(maxChunks);

  if (allChunks.length === 0) return { generated: 0, failed: 0, skipped: 0, tokenUsage: 0 };

  // Find already-embedded chunk IDs
  const chunkIds = allChunks.map((c) => c.id);
  const existingEmbeddings = await db
    .select({ chunkId: knowledgeEmbeddings.knowledgeChunkId })
    .from(knowledgeEmbeddings)
    .where(and(
      eq(knowledgeEmbeddings.tenantId, tenantId),
      eq(knowledgeEmbeddings.embeddingStatus, "completed"),
      inArray(knowledgeEmbeddings.knowledgeChunkId, chunkIds),
    ));

  const embeddedSet = new Set(existingEmbeddings.map((e) => e.chunkId));
  const toEmbed = allChunks.filter((c) => !embeddedSet.has(c.id) && c.chunkText);

  if (toEmbed.length === 0) return { generated: 0, failed: 0, skipped: allChunks.length, tokenUsage: 0 };

  const client = getOpenAIClient();
  let generated = 0;
  let failed = 0;
  let totalTokens = 0;

  // Process in batches
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((c) => (c.chunkText ?? "").slice(0, MAX_CHUNK_TOKENS * 4));

    try {
      const resp = await client.embeddings.create({
        model:           EMBEDDING_MODEL,
        input:           inputs,
        encoding_format: "float",
      });

      totalTokens += resp.usage?.total_tokens ?? 0;
      const costUsd = ((resp.usage?.total_tokens ?? 0) / 1000) * COST_PER_1K_TOKENS;

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const vector = resp.data[j]?.embedding ?? null;
        if (!vector) { failed++; continue; }

        await db.insert(knowledgeEmbeddings).values({
          tenantId,
          knowledgeBaseId,
          knowledgeDocumentId,
          knowledgeDocumentVersionId,
          knowledgeChunkId:   chunk.id,
          embeddingProvider:  "openai",
          embeddingModel:     EMBEDDING_MODEL,
          embeddingStatus:    "completed",
          embeddingVector:    vector,
          embeddingDimensions: EMBEDDING_DIMS,
          dimensions:          EMBEDDING_DIMS,
          tokenUsage:          Math.ceil((resp.usage?.total_tokens ?? 0) / batch.length),
          estimatedCostUsd:    (costUsd / batch.length).toFixed(8) as any,
          vectorBackend:       "pgvector",
          vectorStatus:        "pending",
          isActive:            true,
          embeddingVersion:    "1",
          contentHash:         chunk.id,
          similarityMetric:    "cosine",
        }).onConflictDoNothing();

        generated++;
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`[kb-embeddings] batch ${i}–${i + BATCH_SIZE} failed:`, errMsg);
      failed += batch.length;
    }
  }

  console.log(`[kb-embeddings] doc=${knowledgeDocumentId}: generated=${generated} failed=${failed} skipped=${allChunks.length - toEmbed.length} tokens=${totalTokens}`);
  return { generated, failed, skipped: allChunks.length - toEmbed.length, tokenUsage: totalTokens };
}

// ── embeddingCount ─────────────────────────────────────────────────────────────
// Returns count of completed embeddings for a document version.

export async function embeddingCount(tenantId: string, versionId: string): Promise<number> {
  const { count } = await import("drizzle-orm");
  const [row] = await db
    .select({ cnt: count() })
    .from(knowledgeEmbeddings)
    .where(and(
      eq(knowledgeEmbeddings.tenantId, tenantId),
      eq(knowledgeEmbeddings.knowledgeDocumentVersionId, versionId),
      eq(knowledgeEmbeddings.embeddingStatus, "completed"),
    ));
  return Number(row?.cnt ?? 0);
}

// ── cosineSimilarity ─────────────────────────────────────────────────────────
// Application-layer cosine similarity for reranking.

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}
