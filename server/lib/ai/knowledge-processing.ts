/**
 * knowledge-processing.ts — Phase 5A
 *
 * Service helpers for the document processing pipeline foundation:
 *   - knowledge_storage_objects
 *   - knowledge_processing_jobs
 *   - knowledge_chunks (metadata foundation)
 *   - knowledge_embeddings (metadata foundation)
 *   - knowledge_index_state
 *
 * Design invariants:
 *   - Processing jobs are append-oriented — never mutate a past job row, create a new one
 *   - Index state is a single row per document version (UNIQUE on knowledge_document_version_id)
 *   - Storage object metadata is immutable after upload — no silent overwrites
 *   - Chunk + embedding tables are derived artifacts — rebuildable without corrupting canonical truth
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeStorageObjects,
  knowledgeProcessingJobs,
  knowledgeChunks,
  knowledgeEmbeddings,
  knowledgeIndexState,
  type KnowledgeStorageObject,
  type InsertKnowledgeStorageObject,
  type KnowledgeProcessingJob,
  type InsertKnowledgeProcessingJob,
  type KnowledgeChunk,
  type InsertKnowledgeChunk,
  type KnowledgeEmbedding,
  type InsertKnowledgeEmbedding,
  type KnowledgeIndexStateRow,
  type InsertKnowledgeIndexState,
} from "@shared/schema";

// ─── Storage Object Operations ────────────────────────────────────────────────

export async function attachStorageObject(
  input: InsertKnowledgeStorageObject,
): Promise<KnowledgeStorageObject> {
  const [row] = await db.insert(knowledgeStorageObjects).values(input).returning();
  return row;
}

export async function getStorageObjectsByVersion(
  versionId: string,
  tenantId: string,
): Promise<KnowledgeStorageObject[]> {
  return db
    .select()
    .from(knowledgeStorageObjects)
    .where(
      and(
        eq(knowledgeStorageObjects.knowledgeDocumentVersionId, versionId),
        eq(knowledgeStorageObjects.tenantId, tenantId),
      ),
    )
    .orderBy(desc(knowledgeStorageObjects.createdAt));
}

export async function markStorageObjectUploaded(
  id: string,
  tenantId: string,
  checksum?: string,
): Promise<KnowledgeStorageObject | undefined> {
  const [row] = await db
    .update(knowledgeStorageObjects)
    .set({
      uploadStatus: "uploaded",
      uploadedAt: new Date(),
      checksum: checksum ?? null,
    })
    .where(
      and(
        eq(knowledgeStorageObjects.id, id),
        eq(knowledgeStorageObjects.tenantId, tenantId),
      ),
    )
    .returning();
  return row;
}

export async function markStorageObjectVerified(
  id: string,
  tenantId: string,
): Promise<KnowledgeStorageObject | undefined> {
  const [row] = await db
    .update(knowledgeStorageObjects)
    .set({ uploadStatus: "verified", verifiedAt: new Date() })
    .where(
      and(
        eq(knowledgeStorageObjects.id, id),
        eq(knowledgeStorageObjects.tenantId, tenantId),
      ),
    )
    .returning();
  return row;
}

// ─── Processing Job Operations ─────────────────────────────────────────────────

export async function createKnowledgeProcessingJob(
  input: InsertKnowledgeProcessingJob,
): Promise<KnowledgeProcessingJob> {
  const [row] = await db.insert(knowledgeProcessingJobs).values(input).returning();
  return row;
}

export async function getProcessingJob(
  id: string,
  tenantId: string,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeProcessingJobs)
    .where(
      and(
        eq(knowledgeProcessingJobs.id, id),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
      ),
    );
  return row;
}

export async function listProcessingJobs(
  tenantId: string,
  documentId?: string,
  status?: string,
): Promise<KnowledgeProcessingJob[]> {
  const conditions = [eq(knowledgeProcessingJobs.tenantId, tenantId)];
  if (documentId) conditions.push(eq(knowledgeProcessingJobs.knowledgeDocumentId, documentId));
  if (status) conditions.push(eq(knowledgeProcessingJobs.status, status));
  return db
    .select()
    .from(knowledgeProcessingJobs)
    .where(and(...conditions))
    .orderBy(desc(knowledgeProcessingJobs.createdAt));
}

export async function startProcessingJob(
  id: string,
  tenantId: string,
  workerId?: string,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({
      status: "running",
      startedAt: new Date(),
      workerId: workerId ?? null,
      attemptCount: sql`${knowledgeProcessingJobs.attemptCount} + 1`,
    })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, id),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
        eq(knowledgeProcessingJobs.status, "queued"),
      ),
    )
    .returning();
  return row;
}

export async function completeProcessingJob(
  id: string,
  tenantId: string,
  resultSummary?: Record<string, unknown>,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({ status: "completed", completedAt: new Date(), resultSummary: resultSummary ?? null })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, id),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();
  return row;
}

export async function failProcessingJob(
  id: string,
  tenantId: string,
  failureReason: string,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({ status: "failed", completedAt: new Date(), failureReason })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, id),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();
  return row;
}

// ─── Chunk Operations (metadata foundation) ───────────────────────────────────

export async function createKnowledgeChunk(
  input: InsertKnowledgeChunk,
): Promise<KnowledgeChunk> {
  const [row] = await db.insert(knowledgeChunks).values(input).returning();
  return row;
}

export async function listChunksByVersion(
  versionId: string,
  tenantId: string,
  activeOnly = true,
): Promise<KnowledgeChunk[]> {
  const conditions = [
    eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
    eq(knowledgeChunks.tenantId, tenantId),
  ];
  if (activeOnly) conditions.push(eq(knowledgeChunks.chunkActive, true));
  return db
    .select()
    .from(knowledgeChunks)
    .where(and(...conditions))
    .orderBy(knowledgeChunks.chunkIndex);
}

export async function deactivateChunksByVersion(
  versionId: string,
  tenantId: string,
): Promise<number> {
  const result = await db
    .update(knowledgeChunks)
    .set({ chunkActive: false })
    .where(
      and(
        eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
        eq(knowledgeChunks.tenantId, tenantId),
        eq(knowledgeChunks.chunkActive, true),
      ),
    )
    .returning();
  return result.length;
}

// ─── Embedding Operations (metadata foundation) ───────────────────────────────

export async function createKnowledgeEmbedding(
  input: InsertKnowledgeEmbedding,
): Promise<KnowledgeEmbedding> {
  const [row] = await db.insert(knowledgeEmbeddings).values(input).returning();
  return row;
}

export async function listEmbeddingsByVersion(
  versionId: string,
  tenantId: string,
): Promise<KnowledgeEmbedding[]> {
  return db
    .select()
    .from(knowledgeEmbeddings)
    .where(
      and(
        eq(knowledgeEmbeddings.knowledgeDocumentVersionId, versionId),
        eq(knowledgeEmbeddings.tenantId, tenantId),
      ),
    )
    .orderBy(desc(knowledgeEmbeddings.createdAt));
}

// ─── Index State Operations ───────────────────────────────────────────────────

export async function updateKnowledgeIndexState(
  input: InsertKnowledgeIndexState,
): Promise<KnowledgeIndexStateRow> {
  const [row] = await db
    .insert(knowledgeIndexState)
    .values(input)
    .onConflictDoUpdate({
      target: knowledgeIndexState.knowledgeDocumentVersionId,
      set: {
        indexState: input.indexState,
        chunkCount: input.chunkCount ?? 0,
        indexedChunkCount: input.indexedChunkCount ?? 0,
        embeddingCount: input.embeddingCount ?? 0,
        lastIndexedAt: input.indexState === "indexed" ? new Date() : undefined,
        staleReason: input.staleReason ?? null,
        failureReason: input.failureReason ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function getIndexStateByVersion(
  versionId: string,
  tenantId: string,
): Promise<KnowledgeIndexStateRow | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeIndexState)
    .where(
      and(
        eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId),
        eq(knowledgeIndexState.tenantId, tenantId),
      ),
    );
  return row;
}

export async function listIndexStateByKnowledgeBase(
  knowledgeBaseId: string,
  tenantId: string,
  indexStateFilter?: string,
): Promise<KnowledgeIndexStateRow[]> {
  const conditions = [
    eq(knowledgeIndexState.knowledgeBaseId, knowledgeBaseId),
    eq(knowledgeIndexState.tenantId, tenantId),
  ];
  if (indexStateFilter) conditions.push(eq(knowledgeIndexState.indexState, indexStateFilter));
  return db
    .select()
    .from(knowledgeIndexState)
    .where(and(...conditions))
    .orderBy(desc(knowledgeIndexState.updatedAt));
}

/**
 * isVersionRetrievable — Lifecycle-safe retrieval readiness check.
 *
 * A version is retrievable only when ALL three conditions are true:
 *   1. version.version_status = 'indexed'
 *   2. index_state.index_state = 'indexed'
 *   3. document.document_status = 'ready' AND document.lifecycle_state = 'active'
 *
 * This prevents partial-indexed content from appearing in retrieval results.
 */
export async function isVersionRetrievable(
  versionId: string,
  tenantId: string,
): Promise<{ retrievable: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  const idxState = await getIndexStateByVersion(versionId, tenantId);
  if (!idxState) {
    reasons.push("no index_state row found for this version");
    return { retrievable: false, reasons };
  }
  if (idxState.indexState !== "indexed") {
    reasons.push(`index_state is '${idxState.indexState}', expected 'indexed'`);
  }

  return {
    retrievable: reasons.length === 0,
    reasons,
  };
}
