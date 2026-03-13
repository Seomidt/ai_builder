/**
 * vector-adapter.ts — Phase 5A
 *
 * Backend-agnostic vector search abstraction layer.
 *
 * Application domain logic must NEVER call raw SQL vector queries directly.
 * All vector operations must go through this adapter.
 *
 * Current implementation: pgvector stub (Phase 5A foundation).
 * Future implementations: Pinecone, Weaviate, Qdrant, custom retrieval service.
 *
 * Extension path for future phases:
 *   1. Implement a concrete provider class (e.g., PineconeVectorProvider)
 *   2. Register it in VECTOR_PROVIDERS map below
 *   3. Set ACTIVE_VECTOR_BACKEND env var to switch providers
 */

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

// ─── pgvector Provider (Phase 5A Stub) ────────────────────────────────────────
//
// Full pgvector implementation requires the vector column on knowledge_embeddings
// and pgvector extension in Postgres, which are Phase 5B deliverables.
//
// This stub satisfies the interface contract and returns safe empty results.
// It logs calls so future phases can easily see integration points.

class PgvectorProvider implements VectorProvider {
  readonly backendName = "pgvector";

  async vectorSearch(
    _embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    console.log("[vector-adapter:pgvector] vectorSearch called", {
      tenantId: options.filters.tenantId,
      knowledgeBaseId: options.filters.knowledgeBaseId,
      topK: options.topK ?? 10,
      note: "Phase 5A stub — vector column not yet added. Returns empty results.",
    });
    return [];
  }

  async upsertDocumentEmbeddings(
    inputs: UpsertEmbeddingInput[],
  ): Promise<{ upsertedCount: number }> {
    console.log("[vector-adapter:pgvector] upsertDocumentEmbeddings called", {
      count: inputs.length,
      tenantId: inputs[0]?.tenantId,
      note: "Phase 5A stub — full upsert in Phase 5B.",
    });
    return { upsertedCount: 0 };
  }

  async deleteDocumentEmbeddings(
    filter: DeleteEmbeddingsFilter,
  ): Promise<{ deletedCount: number }> {
    console.log("[vector-adapter:pgvector] deleteDocumentEmbeddings called", {
      filter,
      note: "Phase 5A stub — deletion in Phase 5B.",
    });
    return { deletedCount: 0 };
  }

  async markIndexState(update: IndexStateUpdate): Promise<void> {
    console.log("[vector-adapter:pgvector] markIndexState called", {
      documentVersionId: update.documentVersionId,
      indexState: update.indexState,
      note: "Phase 5A stub — DB write in Phase 5B.",
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
