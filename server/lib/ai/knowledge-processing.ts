/**
 * knowledge-processing.ts — Phase 5A (hardened)
 *
 * Service helpers for the document processing pipeline:
 *   - knowledge_storage_objects
 *   - knowledge_processing_jobs
 *   - knowledge_chunks
 *   - knowledge_embeddings
 *   - knowledge_index_state
 *
 * Enforced invariants (service layer):
 *   INV-5  Cross-tenant linkage rejected at every write path. Each insert
 *          validates that all referenced parent rows (KB, document, version,
 *          chunk) share the caller-supplied tenantId via explicit field
 *          comparison — not just query filters.
 *   INV-4  isVersionRetrievable() enforces that retrieval readiness requires
 *          both a valid index_state='indexed' row AND the document being in
 *          'ready' status with an active lifecycle_state. The function is the
 *          authoritative gate for retrieval paths.
 *
 * Additional invariants:
 *   - Processing jobs are append-oriented — never mutate a past job row.
 *   - Index state is upserted (one row per document version).
 *   - Storage object metadata is immutable after upload.
 *   - Chunk + embedding tables are derived artifacts.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
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
import { KnowledgeInvariantError } from "./knowledge-bases";

// ─── Internal tenant-assertion helpers ────────────────────────────────────────

async function assertVersionTenant(
  versionId: string,
  tenantId: string,
  label = "version",
): Promise<{ id: string; tenantId: string; knowledgeDocumentId: string }> {
  const [row] = await db
    .select({
      id: knowledgeDocumentVersions.id,
      tenantId: knowledgeDocumentVersions.tenantId,
      knowledgeDocumentId: knowledgeDocumentVersions.knowledgeDocumentId,
    })
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, versionId));

  if (!row) {
    throw new KnowledgeInvariantError("INV-5", `${label} ${versionId} not found`);
  }
  if (row.tenantId !== tenantId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `cross-tenant linkage rejected: ${label} ${versionId} belongs to tenant ${row.tenantId}, caller is tenant ${tenantId}`,
    );
  }
  return row;
}

async function assertDocumentTenant(
  documentId: string,
  tenantId: string,
  label = "document",
): Promise<{ id: string; tenantId: string; knowledgeBaseId: string }> {
  const [row] = await db
    .select({
      id: knowledgeDocuments.id,
      tenantId: knowledgeDocuments.tenantId,
      knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, documentId));

  if (!row) {
    throw new KnowledgeInvariantError("INV-5", `${label} ${documentId} not found`);
  }
  if (row.tenantId !== tenantId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `cross-tenant linkage rejected: ${label} ${documentId} belongs to tenant ${row.tenantId}, caller is tenant ${tenantId}`,
    );
  }
  return row;
}

async function assertKnowledgeBaseTenant(
  kbId: string,
  tenantId: string,
): Promise<{ id: string; tenantId: string }> {
  const [row] = await db
    .select({ id: knowledgeBases.id, tenantId: knowledgeBases.tenantId })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, kbId));

  if (!row) {
    throw new KnowledgeInvariantError("INV-5", `knowledge_base ${kbId} not found`);
  }
  if (row.tenantId !== tenantId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `cross-tenant linkage rejected: knowledge_base ${kbId} belongs to tenant ${row.tenantId}, caller is tenant ${tenantId}`,
    );
  }
  return row;
}

async function assertChunkTenant(
  chunkId: string,
  tenantId: string,
): Promise<{ id: string; tenantId: string; knowledgeBaseId: string; knowledgeDocumentId: string }> {
  const [row] = await db
    .select({
      id: knowledgeChunks.id,
      tenantId: knowledgeChunks.tenantId,
      knowledgeBaseId: knowledgeChunks.knowledgeBaseId,
      knowledgeDocumentId: knowledgeChunks.knowledgeDocumentId,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.id, chunkId));

  if (!row) {
    throw new KnowledgeInvariantError("INV-5", `chunk ${chunkId} not found`);
  }
  if (row.tenantId !== tenantId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `cross-tenant linkage rejected: chunk ${chunkId} belongs to tenant ${row.tenantId}, caller is tenant ${tenantId}`,
    );
  }
  return row;
}

// ─── Storage Object Operations ────────────────────────────────────────────────

/**
 * attachStorageObject
 *
 * INV-5: Validates that the referenced version belongs to input.tenantId
 *        before inserting the storage object.
 */
export async function attachStorageObject(
  input: InsertKnowledgeStorageObject,
): Promise<KnowledgeStorageObject> {
  await assertVersionTenant(input.knowledgeDocumentVersionId, input.tenantId, "document_version");
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

/**
 * createKnowledgeProcessingJob
 *
 * INV-5: Validates that the referenced document belongs to input.tenantId.
 *        If a version is provided, also validates it belongs to the same tenant
 *        and the same document.
 */
export async function createKnowledgeProcessingJob(
  input: InsertKnowledgeProcessingJob,
): Promise<KnowledgeProcessingJob> {
  const doc = await assertDocumentTenant(input.knowledgeDocumentId, input.tenantId);

  if (input.knowledgeDocumentVersionId) {
    const ver = await assertVersionTenant(
      input.knowledgeDocumentVersionId,
      input.tenantId,
      "document_version",
    );
    if (ver.knowledgeDocumentId !== input.knowledgeDocumentId) {
      throw new KnowledgeInvariantError(
        "INV-5",
        `version ${input.knowledgeDocumentVersionId} belongs to document ${ver.knowledgeDocumentId}, not ${input.knowledgeDocumentId}`,
      );
    }
  }

  if (doc.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `document ${input.knowledgeDocumentId} belongs to knowledge_base ${doc.knowledgeBaseId}, not ${input.knowledgeBaseId}`,
    );
  }

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
        eq(knowledgeProcessingJobs.status, "pending"),
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

// ─── Chunk Operations ─────────────────────────────────────────────────────────

/**
 * createKnowledgeChunk
 *
 * INV-5: Validates that KB, document, and version all share input.tenantId,
 *        and that the document belongs to the referenced KB, and the version
 *        belongs to the referenced document.
 */
export async function createKnowledgeChunk(
  input: InsertKnowledgeChunk,
): Promise<KnowledgeChunk> {
  await assertKnowledgeBaseTenant(input.knowledgeBaseId, input.tenantId);
  const doc = await assertDocumentTenant(input.knowledgeDocumentId, input.tenantId);
  const ver = await assertVersionTenant(
    input.knowledgeDocumentVersionId,
    input.tenantId,
    "document_version",
  );

  if (doc.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `document ${input.knowledgeDocumentId} belongs to knowledge_base ${doc.knowledgeBaseId}, not ${input.knowledgeBaseId}`,
    );
  }
  if (ver.knowledgeDocumentId !== input.knowledgeDocumentId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `version ${input.knowledgeDocumentVersionId} belongs to document ${ver.knowledgeDocumentId}, not ${input.knowledgeDocumentId}`,
    );
  }

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

// ─── Embedding Operations ─────────────────────────────────────────────────────

/**
 * createKnowledgeEmbedding
 *
 * INV-5: Validates that KB, document, version, and chunk all share
 *        input.tenantId, with explicit cross-field consistency checks
 *        (chunk.knowledgeBaseId and chunk.knowledgeDocumentId must match).
 */
export async function createKnowledgeEmbedding(
  input: InsertKnowledgeEmbedding,
): Promise<KnowledgeEmbedding> {
  await assertKnowledgeBaseTenant(input.knowledgeBaseId, input.tenantId);
  const doc = await assertDocumentTenant(input.knowledgeDocumentId, input.tenantId);
  const ver = await assertVersionTenant(
    input.knowledgeDocumentVersionId,
    input.tenantId,
    "document_version",
  );
  const chunk = await assertChunkTenant(input.knowledgeChunkId, input.tenantId);

  if (doc.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `document ${input.knowledgeDocumentId} belongs to knowledge_base ${doc.knowledgeBaseId}, not ${input.knowledgeBaseId}`,
    );
  }
  if (ver.knowledgeDocumentId !== input.knowledgeDocumentId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `version ${input.knowledgeDocumentVersionId} belongs to document ${ver.knowledgeDocumentId}, not ${input.knowledgeDocumentId}`,
    );
  }
  if (chunk.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `chunk ${input.knowledgeChunkId} belongs to knowledge_base ${chunk.knowledgeBaseId}, not ${input.knowledgeBaseId}`,
    );
  }
  if (chunk.knowledgeDocumentId !== input.knowledgeDocumentId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `chunk ${input.knowledgeChunkId} belongs to document ${chunk.knowledgeDocumentId}, not ${input.knowledgeDocumentId}`,
    );
  }

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

/**
 * updateKnowledgeIndexState (upsert)
 *
 * INV-5: Validates that KB, document, and version all share input.tenantId
 *        with explicit cross-field consistency checks before upserting.
 */
export async function updateKnowledgeIndexState(
  input: InsertKnowledgeIndexState,
): Promise<KnowledgeIndexStateRow> {
  await assertKnowledgeBaseTenant(input.knowledgeBaseId, input.tenantId);
  const doc = await assertDocumentTenant(input.knowledgeDocumentId, input.tenantId);
  const ver = await assertVersionTenant(
    input.knowledgeDocumentVersionId,
    input.tenantId,
    "document_version",
  );

  if (doc.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `document ${input.knowledgeDocumentId} belongs to knowledge_base ${doc.knowledgeBaseId}, not ${input.knowledgeBaseId}`,
    );
  }
  if (ver.knowledgeDocumentId !== input.knowledgeDocumentId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `version ${input.knowledgeDocumentVersionId} belongs to document ${ver.knowledgeDocumentId}, not ${input.knowledgeDocumentId}`,
    );
  }

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
 * isVersionRetrievable — INV-4 authoritative retrieval gate.
 *
 * A version is retrievable only when ALL of the following are true:
 *   1. A knowledge_index_state row exists for this version
 *   2. index_state.index_state = 'indexed'
 *   3. The parent document has document_status = 'ready'
 *   4. The parent document has lifecycle_state = 'active'
 *   5. The parent knowledge base has lifecycle_state = 'active'
 *
 * Condition 3+4 enforce that a document must have been explicitly
 * transitioned to 'ready' via markDocumentReady() — mere version
 * existence is not sufficient.
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

  const [doc] = await db
    .select({
      id: knowledgeDocuments.id,
      documentStatus: knowledgeDocuments.documentStatus,
      lifecycleState: knowledgeDocuments.lifecycleState,
      knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
    })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, idxState.knowledgeDocumentId),
        eq(knowledgeDocuments.tenantId, tenantId),
      ),
    );

  if (!doc) {
    reasons.push(`parent document ${idxState.knowledgeDocumentId} not found for tenant ${tenantId}`);
    return { retrievable: false, reasons };
  }
  if (doc.documentStatus !== "ready") {
    reasons.push(
      `document_status is '${doc.documentStatus}', must be 'ready' — call markDocumentReady() after indexing`,
    );
  }
  if (doc.lifecycleState !== "active") {
    reasons.push(`document lifecycle_state is '${doc.lifecycleState}', must be 'active'`);
  }

  const [kb] = await db
    .select({ id: knowledgeBases.id, lifecycleState: knowledgeBases.lifecycleState })
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, doc.knowledgeBaseId),
        eq(knowledgeBases.tenantId, tenantId),
      ),
    );

  if (!kb) {
    reasons.push(`parent knowledge_base ${doc.knowledgeBaseId} not found for tenant ${tenantId}`);
  } else if (kb.lifecycleState !== "active") {
    reasons.push(`knowledge_base lifecycle_state is '${kb.lifecycleState}', must be 'active'`);
  }

  return { retrievable: reasons.length === 0, reasons };
}
