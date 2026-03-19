/**
 * Phase 10 — Knowledge Ingestion Orchestrator
 * Pipeline: upload → parse → chunk → embed → index
 * INV-KNW10: Pipeline runs must be tenant-scoped.
 * INV-KNW11: Partial failures must be tracked; pipeline must support retry.
 * INV-KNW12: Pipeline status must be observable at every stage.
 */

import { createKnowledgeSource, updateKnowledgeSourceStatus } from "./knowledge-sources";
import { ingestDocument, updateDocumentStatus } from "./knowledge-documents";
import { chunkDocument } from "./knowledge-chunking";
import { generateEmbeddingsForDocument, retryFailedEmbeddings } from "./knowledge-embeddings";
import { registerIndexEntriesForDocument } from "./knowledge-indexing";
import { logAuditBestEffort } from "../audit/audit-log";

export type PipelineStage = "source_created" | "document_ingested" | "document_chunked" | "embeddings_generated" | "indexed" | "failed";

export interface PipelineResult {
  success: boolean;
  tenantId: string;
  sourceId: string;
  documentId: string;
  stage: PipelineStage;
  chunkCount?: number;
  embeddingResult?: { generated: number; failed: number; skipped: number };
  indexResult?: { registered: number; failed: number };
  errorMessage?: string;
  retried?: boolean;
}

// ─── runIngestionPipeline ─────────────────────────────────────────────────────
// Full pipeline: source → document → chunk → embed → index

export async function runIngestionPipeline(params: {
  tenantId: string;
  sourceType?: "file_upload" | "web_crawl" | "api_ingestion" | "manual";
  sourceName?: string;
  existingSourceId?: string;
  documentTitle: string;
  content: string;
  contentType?: string;
  checksum?: string;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vectorIndexed?: boolean;
  lexicalIndexed?: boolean;
  actorId?: string;
  retryOnFailure?: boolean;
}): Promise<PipelineResult> {
  const {
    tenantId, sourceType = "file_upload", sourceName, existingSourceId,
    documentTitle, content, contentType, checksum,
    embeddingModel = "text-embedding-3-small", chunkSize = 512, chunkOverlap = 64,
    vectorIndexed = true, lexicalIndexed = true, actorId, retryOnFailure = true,
  } = params;

  let sourceId = existingSourceId ?? "";
  let documentId = "";

  try {
    // ── Stage 1: Source ──────────────────────────────────────────────────────
    if (!existingSourceId) {
      const source = await createKnowledgeSource({
        tenantId,
        sourceType,
        name: sourceName ?? documentTitle,
        actorId,
      });
      sourceId = source.id;
    }
    await updateKnowledgeSourceStatus(sourceId, "syncing", tenantId);

    // ── Stage 2: Document ingestion ──────────────────────────────────────────
    const doc = await ingestDocument({ tenantId, sourceId, title: documentTitle, checksum, contentType, actorId });
    documentId = doc.id;

    // Idempotent: if already indexed, return early
    if (doc.documentStatus === "indexed") {
      await updateKnowledgeSourceStatus(sourceId, "active", tenantId);
      return { success: true, tenantId, sourceId, documentId, stage: "indexed" };
    }

    await updateDocumentStatus(documentId, "processing", tenantId);

    // ── Stage 3: Chunking ────────────────────────────────────────────────────
    const chunks = await chunkDocument({ tenantId, documentId, content, chunkSize, chunkOverlap, actorId });

    // ── Stage 4: Embedding ───────────────────────────────────────────────────
    let embeddingResult = await generateEmbeddingsForDocument({ tenantId, documentId, embeddingModel, actorId });

    // Retry logic (INV-KNW11)
    if (retryOnFailure && embeddingResult.failed > 0) {
      const retry = await retryFailedEmbeddings({ tenantId, documentId, embeddingModel });
      embeddingResult = {
        generated: embeddingResult.generated + retry.succeeded,
        failed: retry.stillFailed,
        skipped: embeddingResult.skipped,
      };
    }

    if (embeddingResult.generated === 0 && chunks.length > 0) {
      await updateDocumentStatus(documentId, "failed", tenantId);
      await updateKnowledgeSourceStatus(sourceId, "error", tenantId);
      return {
        success: false, tenantId, sourceId, documentId,
        stage: "failed", chunkCount: chunks.length,
        embeddingResult, errorMessage: "No embeddings generated",
      };
    }

    await updateDocumentStatus(documentId, "embedded", tenantId);

    // ── Stage 5: Index registration ──────────────────────────────────────────
    const indexResult = await registerIndexEntriesForDocument({ tenantId, documentId, sourceId, vectorIndexed, lexicalIndexed, actorId });

    await updateKnowledgeSourceStatus(sourceId, "active", tenantId);

    await logAuditBestEffort({
      tenantId,
      action: "knowledge.index.updated",
      resourceType: "ingestion_pipeline",
      resourceId: documentId,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Ingestion pipeline completed for document '${documentTitle}'`,
      metadata: { sourceId, documentId, chunkCount: chunks.length, embeddingResult, indexResult },
    });

    return {
      success: true, tenantId, sourceId, documentId,
      stage: "indexed", chunkCount: chunks.length,
      embeddingResult, indexResult,
    };
  } catch (err) {
    const errorMessage = (err as Error).message;
    if (documentId) {
      await updateDocumentStatus(documentId, "failed", tenantId).catch(() => {});
    }
    if (sourceId) {
      await updateKnowledgeSourceStatus(sourceId, "error", tenantId).catch(() => {});
    }
    return { success: false, tenantId, sourceId, documentId, stage: "failed", errorMessage };
  }
}

// ─── retryFailedPipelineDocument ─────────────────────────────────────────────

export async function retryFailedPipelineDocument(params: {
  tenantId: string;
  documentId: string;
  sourceId: string;
  content: string;
  embeddingModel?: string;
}): Promise<PipelineResult> {
  const { tenantId, documentId, sourceId, content, embeddingModel = "text-embedding-3-small" } = params;

  try {
    await updateDocumentStatus(documentId, "processing", tenantId);

    const chunks = await chunkDocument({ tenantId, documentId, content });
    const embeddingResult = await generateEmbeddingsForDocument({ tenantId, documentId, embeddingModel });
    const indexResult = await registerIndexEntriesForDocument({ tenantId, documentId, sourceId });

    return {
      success: true, tenantId, sourceId, documentId, stage: "indexed",
      chunkCount: chunks.length, embeddingResult, indexResult, retried: true,
    };
  } catch (err) {
    await updateDocumentStatus(documentId, "failed", tenantId).catch(() => {});
    return {
      success: false, tenantId, sourceId, documentId, stage: "failed",
      errorMessage: (err as Error).message, retried: true,
    };
  }
}

// ─── explainPipelineState ─────────────────────────────────────────────────────
// INV-KNW12: Read-only — no writes.

export async function explainPipelineState(params: {
  tenantId: string;
  documentId: string;
}): Promise<{
  documentId: string;
  stage: string;
  chunkCount: number;
  pendingEmbeddings: number;
  completedEmbeddings: number;
  failedEmbeddings: number;
  indexedChunks: number;
  note: string;
}> {
  const { tenantId, documentId } = params;

  // Use direct DB queries (no pg.Client chaining) for read-only aggregation
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const [docR, chunkR, embR, idxR] = await Promise.all([
      client.query(`SELECT document_status FROM public.ingestion_documents WHERE id = $1 AND tenant_id = $2`, [documentId, tenantId]),
      client.query(`SELECT COUNT(*) as cnt FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2`, [documentId, tenantId]),
      client.query(`SELECT embedding_status, COUNT(*) as cnt FROM public.ingestion_embeddings WHERE chunk_id IN (SELECT id FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2) GROUP BY embedding_status`, [documentId, tenantId]),
      client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_index_entries WHERE document_id = $1 AND tenant_id = $2`, [documentId, tenantId]),
    ]);

    const embByStatus: Record<string, number> = {};
    for (const r of embR.rows) embByStatus[r.embedding_status] = parseInt(r.cnt, 10);

    return {
      documentId,
      stage: docR.rows[0]?.document_status ?? "unknown",
      chunkCount: parseInt(chunkR.rows[0].cnt, 10),
      pendingEmbeddings: embByStatus["pending"] ?? 0,
      completedEmbeddings: embByStatus["completed"] ?? 0,
      failedEmbeddings: embByStatus["failed"] ?? 0,
      indexedChunks: parseInt(idxR.rows[0].cnt, 10),
      note: "INV-KNW12: Read-only — no writes performed.",
    };
  } finally {
    await client.end();
  }
}
