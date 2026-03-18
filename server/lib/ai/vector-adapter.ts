/**
 * vector-adapter.ts — Phase 5D (updated from Phase 5A stub)
 *
 * Backend-agnostic vector search abstraction layer.
 *
 * Application domain logic must NEVER call raw SQL vector queries directly.
 * All vector operations must go through this adapter.
 *
 * Current implementation: pgvector (real — Phase 5D).
 * Future implementations: Pinecone, Weaviate, Qdrant, custom retrieval service.
 *
 * Extension path for future phases:
 *   1. Implement a concrete provider class (e.g., PineconeVectorProvider)
 *   2. Register it in VECTOR_PROVIDERS map below
 *   3. Set ACTIVE_VECTOR_BACKEND env var to switch providers
 */

import { searchPgvector } from "./vector-search-provider";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VectorSearchFilters {
  tenantId: string;
  knowledgeBaseId?: string;
  lifecycleState?: "active";
  documentStatus?: "ready";
  indexState?: "indexed";
  chunkActive?: boolean;
  currentVersionOnly?: boolean;
}

export interface VectorSearchOptions {
  topK?: number;
  similarityThreshold?: number;
  filters: VectorSearchFilters;
}

export interface VectorSearchResult {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  similarity: number;
  chunkText?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertEmbeddingInput {
  tenantId: string;
  knowledgeBaseId: string;
  documentId: string;
  documentVersionId: string;
  chunkId: string;
  embeddingId: string;
  vector: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface DeleteEmbeddingsFilter {
  tenantId: string;
  documentVersionId?: string;
  documentId?: string;
  knowledgeBaseId?: string;
}

export interface IndexStateUpdate {
  documentVersionId: string;
  tenantId: string;
  indexState: "pending" | "indexing" | "indexed" | "failed" | "stale" | "deleted";
  chunkCount?: number;
  indexedChunkCount?: number;
  embeddingCount?: number;
  staleReason?: string;
  failureReason?: string;
}

// ─── Vector Provider Interface ────────────────────────────────────────────────

export interface VectorProvider {
  readonly backendName: string;

  vectorSearch(embedding: number[], options: VectorSearchOptions): Promise<VectorSearchResult[]>;
  upsertDocumentEmbeddings(inputs: UpsertEmbeddingInput[]): Promise<{ upsertedCount: number }>;
  deleteDocumentEmbeddings(filter: DeleteEmbeddingsFilter): Promise<{ deletedCount: number }>;
  markIndexState(update: IndexStateUpdate): Promise<void>;
}

// ─── pgvector Provider (Phase 5D — Real Implementation) ──────────────────────

class PgvectorProvider implements VectorProvider {
  readonly backendName = "pgvector";

  async vectorSearch(
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const { tenantId, knowledgeBaseId } = options.filters;

    if (!tenantId) {
      console.warn("[vector-adapter:pgvector] vectorSearch called without tenantId — returning empty");
      return [];
    }
    if (!knowledgeBaseId) {
      console.warn("[vector-adapter:pgvector] vectorSearch called without knowledgeBaseId — returning empty");
      return [];
    }

    const result = await searchPgvector(embedding, {
      tenantId,
      knowledgeBaseId,
      topK: options.topK ?? 10,
      metric: "cosine",
      similarityThreshold: options.similarityThreshold,
    });

    return result.rows.map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      knowledgeBaseId: row.knowledgeBaseId,
      similarity: row.similarityScore,
      chunkText: row.chunkText ?? undefined,
    }));
  }

  async upsertDocumentEmbeddings(
    inputs: UpsertEmbeddingInput[],
  ): Promise<{ upsertedCount: number }> {
    // Embeddings are stored directly in knowledge_embeddings by the embedding pipeline.
    // This adapter method is a no-op for the pgvector backend (direct DB storage).
    console.log("[vector-adapter:pgvector] upsertDocumentEmbeddings — pgvector uses direct DB storage", {
      count: inputs.length,
      tenantId: inputs[0]?.tenantId,
    });
    return { upsertedCount: inputs.length };
  }

  async deleteDocumentEmbeddings(
    filter: DeleteEmbeddingsFilter,
  ): Promise<{ deletedCount: number }> {
    // Embeddings are managed by the embedding pipeline deactivation flow.
    // Direct deletion through this adapter is not implemented for pgvector backend.
    console.log("[vector-adapter:pgvector] deleteDocumentEmbeddings — use embedding pipeline deactivation", {
      filter,
    });
    return { deletedCount: 0 };
  }

  async markIndexState(update: IndexStateUpdate): Promise<void> {
    // Index state is managed by knowledge-processing.ts pipeline.
    console.log("[vector-adapter:pgvector] markIndexState — managed by knowledge-processing pipeline", {
      documentVersionId: update.documentVersionId,
      indexState: update.indexState,
    });
  }
}

// ─── Registry & Active Provider ───────────────────────────────────────────────

const VECTOR_PROVIDERS: Record<string, VectorProvider> = {
  pgvector: new PgvectorProvider(),
};

function getActiveVectorProvider(): VectorProvider {
  const backend = process.env.ACTIVE_VECTOR_BACKEND ?? "pgvector";
  const provider = VECTOR_PROVIDERS[backend];
  if (!provider) {
    throw new Error(`[vector-adapter] Unknown vector backend: "${backend}". Registered: ${Object.keys(VECTOR_PROVIDERS).join(", ")}`);
  }
  return provider;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function vectorSearch(
  embedding: number[],
  options: VectorSearchOptions,
): Promise<VectorSearchResult[]> {
  return getActiveVectorProvider().vectorSearch(embedding, options);
}

export async function upsertDocumentEmbeddings(
  inputs: UpsertEmbeddingInput[],
): Promise<{ upsertedCount: number }> {
  return getActiveVectorProvider().upsertDocumentEmbeddings(inputs);
}

export async function deleteDocumentEmbeddings(
  filter: DeleteEmbeddingsFilter,
): Promise<{ deletedCount: number }> {
  return getActiveVectorProvider().deleteDocumentEmbeddings(filter);
}

export async function markIndexState(update: IndexStateUpdate): Promise<void> {
  return getActiveVectorProvider().markIndexState(update);
}

export function getVectorAdapterInfo(): { activeBackend: string; registeredBackends: string[] } {
  return {
    activeBackend: process.env.ACTIVE_VECTOR_BACKEND ?? "pgvector",
    registeredBackends: Object.keys(VECTOR_PROVIDERS),
  };
}
