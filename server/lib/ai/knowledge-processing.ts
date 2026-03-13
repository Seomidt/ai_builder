/**
 * knowledge-processing.ts — Phase 5B (parse/chunk pipeline)
 *
 * Service helpers for the document processing pipeline:
 *   - knowledge_storage_objects
 *   - knowledge_processing_jobs
 *   - knowledge_chunks
 *   - knowledge_embeddings
 *   - knowledge_index_state
 *
 * Enforced invariants (service layer):
 *   INV-5   Cross-tenant linkage rejected at every write path.
 *   INV-4   isVersionRetrievable() is the authoritative retrieval gate.
 *   INV-P1  Parse job only runs if version/doc/KB all belong to same tenant
 *           and lifecycle allows processing.
 *   INV-P2  Chunking runs on the explicitly requested version only.
 *   INV-P3  Chunking must NOT mark a document retrievable.
 *   INV-P4  Archived/inactive KB or document blocks processing.
 *   INV-P5  Failed parse must not clear valid historical chunks.
 *   INV-P6  Failed chunk rebuild leaves no partial active chunk corruption
 *           (transactional deactivation + insert).
 *   INV-P7  Non-current version chunking does not alter current version
 *           retrieval state.
 *   INV-P8  Cross-tenant linkage rejected in all parse/chunk paths.
 *   INV-P9  Chunk keys and hashes are deterministic for same input+config.
 *   INV-P10 document_status='ready' still requires valid current_version_id
 *           + index_state='indexed'. 5A.1 invariants are NOT weakened.
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
import { parseDocumentVersion, computeTextChecksum, type ParsedDocument } from "./document-parsers";
import { chunkParsedDocument, type ChunkingConfig } from "./document-chunking";
import {
  parseStructuredDocumentVersion,
  normalizeStructuredDocument,
  type StructuredParseResult,
  type StructuredParseOptions,
} from "./structured-document-parsers";
import {
  chunkStructuredDocument,
  type StructuredChunkingConfig,
} from "./structured-document-chunking";

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

// ─── Phase 5B: Job Execution Hardening ────────────────────────────────────────

export interface AcquireJobOptions {
  workerId?: string;
  processorName?: string;
  processorVersion?: string;
}

/**
 * acquireKnowledgeProcessingJob — race-safe job acquisition.
 *
 * Atomically transitions status from 'queued' → 'running'.
 * If another worker already acquired the job, returns undefined (skip safely).
 * Uses a conditional UPDATE rather than SELECT-then-UPDATE to prevent TOCTOU.
 */
export async function acquireKnowledgeProcessingJob(
  jobId: string,
  tenantId: string,
  opts: AcquireJobOptions = {},
): Promise<KnowledgeProcessingJob | undefined> {
  const now = new Date();
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({
      status: "running",
      startedAt: now,
      lockedAt: now,
      heartbeatAt: now,
      workerId: opts.workerId ?? null,
      processorName: opts.processorName ?? null,
      processorVersion: opts.processorVersion ?? null,
      attemptCount: sql`${knowledgeProcessingJobs.attemptCount} + 1`,
    })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, jobId),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
        eq(knowledgeProcessingJobs.status, "queued"),
      ),
    )
    .returning();
  return row;
}

/**
 * completeKnowledgeProcessingJob — mark job completed with durable summary.
 */
export async function completeKnowledgeProcessingJob(
  jobId: string,
  tenantId: string,
  resultSummary: Record<string, unknown>,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({
      status: "completed",
      completedAt: new Date(),
      resultSummary,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, jobId),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
        eq(knowledgeProcessingJobs.status, "running"),
      ),
    )
    .returning();
  return row;
}

/**
 * failKnowledgeProcessingJob — mark job failed with durable failure_reason.
 * Does NOT require status='running' — can fail a queued job too (e.g. pre-flight rejection).
 */
export async function failKnowledgeProcessingJob(
  jobId: string,
  tenantId: string,
  failureReason: string,
): Promise<KnowledgeProcessingJob | undefined> {
  const [row] = await db
    .update(knowledgeProcessingJobs)
    .set({
      status: "failed",
      completedAt: new Date(),
      failureReason,
    })
    .where(
      and(
        eq(knowledgeProcessingJobs.id, jobId),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();
  return row;
}

// ─── Phase 5B: INV-P1/P4 Lifecycle Validation Helpers ────────────────────────

interface FullVersionContext {
  version: {
    id: string;
    tenantId: string;
    knowledgeDocumentId: string;
    mimeType: string | null;
    parseStatus: string | null;
    isCurrent: boolean;
  };
  document: {
    id: string;
    tenantId: string;
    knowledgeBaseId: string;
    lifecycleState: string;
    documentStatus: string;
  };
  kb: {
    id: string;
    tenantId: string;
    lifecycleState: string;
  };
}

/**
 * assertFullVersionContext
 *
 * INV-P1: validates version → document → KB chain all belong to same tenant.
 * INV-P4: validates KB and document lifecycle_state = 'active'.
 * INV-P8: cross-tenant linkage rejected.
 */
async function assertFullVersionContext(
  versionId: string,
  tenantId: string,
  opts: { requireActiveLifecycle?: boolean } = { requireActiveLifecycle: true },
): Promise<FullVersionContext> {
  const [ver] = await db
    .select({
      id: knowledgeDocumentVersions.id,
      tenantId: knowledgeDocumentVersions.tenantId,
      knowledgeDocumentId: knowledgeDocumentVersions.knowledgeDocumentId,
      mimeType: knowledgeDocumentVersions.mimeType,
      parseStatus: knowledgeDocumentVersions.parseStatus,
      isCurrent: knowledgeDocumentVersions.isCurrent,
    })
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, versionId));

  if (!ver) throw new KnowledgeInvariantError("INV-P1", `version ${versionId} not found`);
  if (ver.tenantId !== tenantId) {
    throw new KnowledgeInvariantError(
      "INV-P8",
      `cross-tenant: version ${versionId} belongs to tenant ${ver.tenantId}, caller is ${tenantId}`,
    );
  }

  const [doc] = await db
    .select({
      id: knowledgeDocuments.id,
      tenantId: knowledgeDocuments.tenantId,
      knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
      lifecycleState: knowledgeDocuments.lifecycleState,
      documentStatus: knowledgeDocuments.documentStatus,
    })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, ver.knowledgeDocumentId),
        eq(knowledgeDocuments.tenantId, tenantId),
      ),
    );

  if (!doc) {
    throw new KnowledgeInvariantError(
      "INV-P1",
      `document ${ver.knowledgeDocumentId} not found for tenant ${tenantId}`,
    );
  }

  const [kb] = await db
    .select({
      id: knowledgeBases.id,
      tenantId: knowledgeBases.tenantId,
      lifecycleState: knowledgeBases.lifecycleState,
    })
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, doc.knowledgeBaseId),
        eq(knowledgeBases.tenantId, tenantId),
      ),
    );

  if (!kb) {
    throw new KnowledgeInvariantError(
      "INV-P1",
      `knowledge_base ${doc.knowledgeBaseId} not found for tenant ${tenantId}`,
    );
  }

  if (opts.requireActiveLifecycle) {
    if (kb.lifecycleState !== "active") {
      throw new KnowledgeInvariantError(
        "INV-P4",
        `knowledge_base ${kb.id} lifecycle_state='${kb.lifecycleState}' — processing blocked on non-active KB`,
      );
    }
    if (doc.lifecycleState !== "active") {
      throw new KnowledgeInvariantError(
        "INV-P4",
        `document ${doc.id} lifecycle_state='${doc.lifecycleState}' — processing blocked on non-active document`,
      );
    }
  }

  return { version: ver, document: doc, kb };
}

// ─── Phase 5B: Parse Execution Flow ──────────────────────────────────────────

export interface RunParseOptions {
  content?: string;
  workerId?: string;
  idempotencyKey?: string;
  processorName?: string;
  processorVersion?: string;
  documentType?: string;
}

export interface ParseExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  parseStatus: "completed" | "failed";
  error?: string;
  chunkCount?: number;
  parsedDocument?: ParsedDocument;
}

/**
 * runParseForDocumentVersion — Phase 5B parse execution flow.
 *
 * INV-P1: validates full version→document→KB chain + tenant.
 * INV-P4: blocks processing on archived/deleted KB or document.
 * INV-P8: rejects cross-tenant linkage.
 * INV-P5: parse failure does NOT clear chunks for this or any other version.
 *
 * If no real file bytes are available (content not provided and storage is not
 * wired), the job is FAILED explicitly — no fake success (per declaration design rule).
 */
export async function runParseForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunParseOptions = {},
): Promise<ParseExecutionResult> {
  const ctx = await assertFullVersionContext(versionId, tenantId, { requireActiveLifecycle: true });

  const storageObjects = await getStorageObjectsByVersion(versionId, tenantId);
  const hasStorage = storageObjects.length > 0;

  if (!opts.content && !hasStorage) {
    const reason = `No parseable content: no content string provided and no storage objects found for version ${versionId}.`;
    await db
      .update(knowledgeDocumentVersions)
      .set({ parseStatus: "failed", parseFailureReason: reason })
      .where(eq(knowledgeDocumentVersions.id, versionId));

    const [job] = await db
      .insert(knowledgeProcessingJobs)
      .values({
        tenantId,
        knowledgeDocumentId: ctx.document.id,
        knowledgeDocumentVersionId: versionId,
        jobType: "parse",
        status: "failed",
        failureReason: reason,
        processorName: opts.processorName ?? "parse_runner",
        processorVersion: opts.processorVersion ?? "1.0",
        idempotencyKey: opts.idempotencyKey ?? null,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();

    return { jobId: job.id, status: "failed", parseStatus: "failed", error: reason };
  }

  const [job] = await db
    .insert(knowledgeProcessingJobs)
    .values({
      tenantId,
      knowledgeDocumentId: ctx.document.id,
      knowledgeDocumentVersionId: versionId,
      jobType: "parse",
      status: "queued",
      processorName: opts.processorName ?? "parse_runner",
      processorVersion: opts.processorVersion ?? "1.0",
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();

  const acquired = await acquireKnowledgeProcessingJob(job.id, tenantId, {
    workerId: opts.workerId,
    processorName: opts.processorName ?? "parse_runner",
    processorVersion: opts.processorVersion ?? "1.0",
  });

  if (!acquired) {
    return {
      jobId: job.id,
      status: "failed",
      parseStatus: "failed",
      error: "Failed to acquire parse job — may have been taken by another worker.",
    };
  }

  await db
    .update(knowledgeDocumentVersions)
    .set({ parseStatus: "running", parseStartedAt: new Date(), parseFailureReason: null })
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );

  const contentToparse: string = opts.content ?? "";
  const mimeType = ctx.version.mimeType ?? "text/plain";

  const parseResult = parseDocumentVersion(contentToparse, mimeType, opts.documentType);

  if (!parseResult.success) {
    const reason = parseResult.error;
    await db
      .update(knowledgeDocumentVersions)
      .set({
        parseStatus: "failed",
        parseCompletedAt: new Date(),
        parseFailureReason: reason,
        parserName: parseResult.parserName,
        parserVersion: parseResult.parserVersion,
      })
      .where(
        and(
          eq(knowledgeDocumentVersions.id, versionId),
          eq(knowledgeDocumentVersions.tenantId, tenantId),
        ),
      );

    await failKnowledgeProcessingJob(job.id, tenantId, reason);

    return { jobId: job.id, status: "failed", parseStatus: "failed", error: reason };
  }

  const parsed = parseResult.data;
  const textChecksum = computeTextChecksum(parsed.plainText);

  await db
    .update(knowledgeDocumentVersions)
    .set({
      parseStatus: "completed",
      parseCompletedAt: new Date(),
      parserName: parsed.parserName,
      parserVersion: parsed.parserVersion,
      parsedTextChecksum: textChecksum,
      normalizedCharacterCount: parsed.plainText.length,
      parseFailureReason: null,
    })
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );

  await completeKnowledgeProcessingJob(job.id, tenantId, {
    parserName: parsed.parserName,
    parserVersion: parsed.parserVersion,
    normalizedCharacterCount: parsed.plainText.length,
    sectionCount: parsed.sections.length,
    warnings: parsed.warnings,
    parsedTextChecksum: textChecksum,
  });

  return {
    jobId: job.id,
    status: "completed",
    parseStatus: "completed",
    parsedDocument: parsed,
  };
}

/**
 * markParseFailed — explicitly fail parse metadata on a version.
 * INV-P5: does not touch chunks of any version.
 */
export async function markParseFailed(
  versionId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
  await db
    .update(knowledgeDocumentVersions)
    .set({ parseStatus: "failed", parseCompletedAt: new Date(), parseFailureReason: reason })
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );
}

/**
 * markParseCompleted — explicitly mark parse metadata as completed.
 */
export async function markParseCompleted(
  versionId: string,
  tenantId: string,
  meta: {
    parserName: string;
    parserVersion: string;
    parsedTextChecksum: string;
    normalizedCharacterCount: number;
  },
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
  await db
    .update(knowledgeDocumentVersions)
    .set({
      parseStatus: "completed",
      parseCompletedAt: new Date(),
      parserName: meta.parserName,
      parserVersion: meta.parserVersion,
      parsedTextChecksum: meta.parsedTextChecksum,
      normalizedCharacterCount: meta.normalizedCharacterCount,
      parseFailureReason: null,
    })
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );
}

// ─── Phase 5B: Index State Integration ────────────────────────────────────────

/**
 * syncIndexStateAfterChunking — Task 8 integration.
 *
 * Updates knowledge_index_state after a successful chunk run.
 * INV-P3: does NOT mark index_state='indexed'.
 * If prior state was 'indexed', transitions to 'stale' (rebuild needed).
 * Otherwise transitions to 'pending'.
 */
export async function syncIndexStateAfterChunking(
  versionId: string,
  tenantId: string,
  knowledgeBaseId: string,
  knowledgeDocumentId: string,
  newChunkCount: number,
): Promise<KnowledgeIndexStateRow> {
  const existing = await getIndexStateByVersion(versionId, tenantId);
  const priorState = existing?.indexState ?? null;

  const newIndexState = priorState === "indexed" ? "stale" : "pending";
  const staleReason =
    priorState === "indexed" ? "Chunks rebuilt — embeddings and index are now stale." : undefined;

  const [row] = await db
    .insert(knowledgeIndexState)
    .values({
      tenantId,
      knowledgeBaseId,
      knowledgeDocumentId,
      knowledgeDocumentVersionId: versionId,
      indexState: newIndexState,
      chunkCount: newChunkCount,
      indexedChunkCount: 0,
      embeddingCount: 0,
      staleReason: staleReason ?? null,
      failureReason: null,
    })
    .onConflictDoUpdate({
      target: knowledgeIndexState.knowledgeDocumentVersionId,
      set: {
        indexState: newIndexState,
        chunkCount: newChunkCount,
        indexedChunkCount: 0,
        embeddingCount: 0,
        staleReason: staleReason ?? null,
        failureReason: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/**
 * markIndexStateStaleAfterChunkReplace — explicitly set index to 'stale'.
 * Used when chunk rebuild succeeds but prior state was 'indexed'.
 */
export async function markIndexStateStaleAfterChunkReplace(
  versionId: string,
  tenantId: string,
  reason?: string,
): Promise<void> {
  await db
    .update(knowledgeIndexState)
    .set({
      indexState: "stale",
      staleReason: reason ?? "Chunks were replaced — index is now stale.",
      indexedChunkCount: 0,
      embeddingCount: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId),
        eq(knowledgeIndexState.tenantId, tenantId),
      ),
    );
}

// ─── Phase 5B: Chunk Execution Flow ──────────────────────────────────────────

export interface RunChunkingOptions {
  content?: string;
  parsedDocument?: ParsedDocument;
  chunkingConfig?: Partial<ChunkingConfig>;
  workerId?: string;
  idempotencyKey?: string;
  processorName?: string;
  processorVersion?: string;
}

export interface ChunkingExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  chunkCount: number;
  priorChunksDeactivated: number;
  indexState?: string;
  error?: string;
}

/**
 * runChunkingForDocumentVersion — Phase 5B chunk execution flow.
 *
 * INV-P1: validates full version→document→KB chain + tenant.
 * INV-P2: chunks only the explicitly requested version.
 * INV-P3: does NOT mark document retrievable.
 * INV-P4: blocks on archived/deleted KB or document.
 * INV-P6: transactional deactivation + insert (no partial corruption).
 * INV-P7: non-current version chunking does not alter current version state.
 * INV-P8: cross-tenant rejected.
 * INV-P9: deterministic chunk keys/hashes.
 */
export async function runChunkingForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunChunkingOptions = {},
): Promise<ChunkingExecutionResult> {
  const ctx = await assertFullVersionContext(versionId, tenantId, { requireActiveLifecycle: true });

  const [ver] = await db
    .select({
      id: knowledgeDocumentVersions.id,
      parseStatus: knowledgeDocumentVersions.parseStatus,
      mimeType: knowledgeDocumentVersions.mimeType,
    })
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );

  if (!ver) {
    throw new KnowledgeInvariantError("INV-P2", `version ${versionId} not found`);
  }

  if (ver.parseStatus !== "completed" && !opts.parsedDocument && !opts.content) {
    const error = `Cannot chunk version ${versionId}: parse_status is '${ver.parseStatus ?? "null"}'. Run parse first or supply parsedDocument/content.`;
    return { jobId: "none", status: "failed", chunkCount: 0, priorChunksDeactivated: 0, error };
  }

  const [job] = await db
    .insert(knowledgeProcessingJobs)
    .values({
      tenantId,
      knowledgeDocumentId: ctx.document.id,
      knowledgeDocumentVersionId: versionId,
      jobType: "chunk",
      status: "queued",
      processorName: opts.processorName ?? "chunk_runner",
      processorVersion: opts.processorVersion ?? "1.0",
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();

  const acquired = await acquireKnowledgeProcessingJob(job.id, tenantId, {
    workerId: opts.workerId,
    processorName: opts.processorName ?? "chunk_runner",
    processorVersion: opts.processorVersion ?? "1.0",
  });

  if (!acquired) {
    return {
      jobId: job.id,
      status: "failed",
      chunkCount: 0,
      priorChunksDeactivated: 0,
      error: "Failed to acquire chunk job — may have been taken by another worker.",
    };
  }

  let parsed: ParsedDocument;

  if (opts.parsedDocument) {
    parsed = opts.parsedDocument;
  } else if (opts.content) {
    const mimeType = ctx.version.mimeType ?? "text/plain";
    const parseResult = parseDocumentVersion(opts.content, mimeType);
    if (!parseResult.success) {
      await failKnowledgeProcessingJob(job.id, tenantId, parseResult.error);
      return {
        jobId: job.id,
        status: "failed",
        chunkCount: 0,
        priorChunksDeactivated: 0,
        error: `Parse step failed during chunking: ${parseResult.error}`,
      };
    }
    parsed = parseResult.data;
  } else {
    await failKnowledgeProcessingJob(job.id, tenantId, "No parsedDocument or content provided.");
    return {
      jobId: job.id,
      status: "failed",
      chunkCount: 0,
      priorChunksDeactivated: 0,
      error: "No parsedDocument or content provided to chunk.",
    };
  }

  const candidates = chunkParsedDocument(
    parsed,
    ctx.document.id,
    versionId,
    opts.chunkingConfig,
  );

  let priorDeactivated = 0;
  let newChunkCount = 0;
  let indexStateRow: KnowledgeIndexStateRow | undefined;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      const priorActive = await tx
        .update(knowledgeChunks)
        .set({
          chunkActive: false,
          replacedAt: now,
          replacedByJobId: job.id,
        })
        .where(
          and(
            eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
            eq(knowledgeChunks.tenantId, tenantId),
            eq(knowledgeChunks.chunkActive, true),
          ),
        )
        .returning();
      priorDeactivated = priorActive.length;

      if (candidates.length > 0) {
        const inserts = candidates.map((c) => ({
          tenantId,
          knowledgeBaseId: ctx.kb.id,
          knowledgeDocumentId: ctx.document.id,
          knowledgeDocumentVersionId: versionId,
          chunkIndex: c.chunkIndex,
          chunkKey: c.chunkKey,
          chunkHash: c.chunkHash,
          chunkText: c.chunkText,
          chunkStrategy: c.chunkStrategy,
          chunkVersion: c.chunkVersion,
          overlapCharacters: c.overlapCharacters,
          characterStart: c.characterStart,
          characterEnd: c.characterEnd,
          tokenEstimate: c.tokenEstimate,
          sourceHeadingPath: c.sourceHeadingPath ?? null,
          sourceSectionLabel: c.sourceSectionLabel ?? null,
          chunkActive: true,
          metadata: null,
        }));

        await tx.insert(knowledgeChunks).values(inserts);
        newChunkCount = candidates.length;
      }

      await tx
        .update(knowledgeProcessingJobs)
        .set({
          status: "completed",
          completedAt: now,
          heartbeatAt: now,
          resultSummary: {
            chunkCount: newChunkCount,
            priorChunksDeactivated: priorDeactivated,
            strategy: opts.chunkingConfig?.strategy ?? "paragraph_window",
          },
        })
        .where(
          and(
            eq(knowledgeProcessingJobs.id, job.id),
            eq(knowledgeProcessingJobs.tenantId, tenantId),
          ),
        );
    });

    indexStateRow = await syncIndexStateAfterChunking(
      versionId,
      tenantId,
      ctx.kb.id,
      ctx.document.id,
      newChunkCount,
    );
  } catch (err) {
    await failKnowledgeProcessingJob(
      job.id,
      tenantId,
      `Chunk transaction failed: ${(err as Error).message}`,
    );
    return {
      jobId: job.id,
      status: "failed",
      chunkCount: 0,
      priorChunksDeactivated: 0,
      error: `Chunk transaction failed: ${(err as Error).message}`,
    };
  }

  return {
    jobId: job.id,
    status: "completed",
    chunkCount: newChunkCount,
    priorChunksDeactivated: priorDeactivated,
    indexState: indexStateRow?.indexState,
  };
}

/**
 * previewChunkingForDocumentVersion — dry-run chunking for inspection.
 *
 * INV-P2: Explicitly checks the given versionId — does NOT default to current.
 * Does NOT write any rows to the database.
 */
export async function previewChunkingForDocumentVersion(
  versionId: string,
  tenantId: string,
  content: string,
  opts: {
    chunkingConfig?: Partial<ChunkingConfig>;
    mimeType?: string;
    documentType?: string;
  } = {},
): Promise<{
  candidateCount: number;
  estimatedTokens: number;
  candidates: Array<{
    chunkIndex: number;
    chunkKey: string;
    chunkHash: string;
    characterStart: number;
    characterEnd: number;
    tokenEstimate: number;
    previewText: string;
    sourceHeadingPath?: string;
  }>;
  warnings: string[];
}> {
  const ver = await assertVersionTenant(versionId, tenantId);
  const mimeType = opts.mimeType ?? "text/plain";
  const parseResult = parseDocumentVersion(content, mimeType, opts.documentType);

  if (!parseResult.success) {
    return {
      candidateCount: 0,
      estimatedTokens: 0,
      candidates: [],
      warnings: [`Parse failed: ${parseResult.error}`],
    };
  }

  const candidates = chunkParsedDocument(parseResult.data, ver.knowledgeDocumentId, versionId, opts.chunkingConfig);
  const estimatedTokens = candidates.reduce((sum, c) => sum + c.tokenEstimate, 0);

  return {
    candidateCount: candidates.length,
    estimatedTokens,
    candidates: candidates.map((c) => ({
      chunkIndex: c.chunkIndex,
      chunkKey: c.chunkKey,
      chunkHash: c.chunkHash,
      characterStart: c.characterStart,
      characterEnd: c.characterEnd,
      tokenEstimate: c.tokenEstimate,
      previewText: c.chunkText.slice(0, 200),
      sourceHeadingPath: c.sourceHeadingPath,
    })),
    warnings: parseResult.data.warnings,
  };
}

// ─── Phase 5B: Observability / Inspection Helpers ─────────────────────────────

/**
 * explainDocumentVersionParseState — Task 12 observability.
 * Returns a human-readable explanation of why parsing is in its current state.
 */
export async function explainDocumentVersionParseState(
  versionId: string,
  tenantId: string,
): Promise<{
  versionId: string;
  parseStatus: string | null;
  parserName: string | null;
  parserVersion: string | null;
  parsedTextChecksum: string | null;
  normalizedCharacterCount: number | null;
  parseStartedAt: Date | null;
  parseCompletedAt: Date | null;
  parseFailureReason: string | null;
  explanation: string;
}> {
  await assertVersionTenant(versionId, tenantId);

  const [row] = await db
    .select({
      id: knowledgeDocumentVersions.id,
      parseStatus: knowledgeDocumentVersions.parseStatus,
      parserName: knowledgeDocumentVersions.parserName,
      parserVersion: knowledgeDocumentVersions.parserVersion,
      parsedTextChecksum: knowledgeDocumentVersions.parsedTextChecksum,
      normalizedCharacterCount: knowledgeDocumentVersions.normalizedCharacterCount,
      parseStartedAt: knowledgeDocumentVersions.parseStartedAt,
      parseCompletedAt: knowledgeDocumentVersions.parseCompletedAt,
      parseFailureReason: knowledgeDocumentVersions.parseFailureReason,
    })
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );

  if (!row) throw new KnowledgeInvariantError("INV-P1", `version ${versionId} not found`);

  const explanation =
    row.parseStatus === "completed"
      ? `Parse completed using '${row.parserName}' v${row.parserVersion}. Normalized ${row.normalizedCharacterCount ?? 0} characters.`
      : row.parseStatus === "failed"
      ? `Parse failed: ${row.parseFailureReason ?? "no reason recorded"}`
      : row.parseStatus === "running"
      ? "Parse is currently in progress."
      : row.parseStatus === "pending"
      ? "Parse is queued but has not started."
      : "No parse has been attempted for this version. Call runParseForDocumentVersion to start.";

  return {
    versionId,
    parseStatus: row.parseStatus,
    parserName: row.parserName,
    parserVersion: row.parserVersion,
    parsedTextChecksum: row.parsedTextChecksum,
    normalizedCharacterCount: row.normalizedCharacterCount,
    parseStartedAt: row.parseStartedAt,
    parseCompletedAt: row.parseCompletedAt,
    parseFailureReason: row.parseFailureReason,
    explanation,
  };
}

/**
 * explainDocumentVersionChunkState — Task 12 observability.
 * Returns chunk counts (active vs replaced) and index state for the version.
 */
export async function explainDocumentVersionChunkState(
  versionId: string,
  tenantId: string,
): Promise<{
  versionId: string;
  activeChunkCount: number;
  replacedChunkCount: number;
  indexState: string | null;
  chunkCount: number | null;
  indexedChunkCount: number | null;
  explanation: string;
}> {
  await assertVersionTenant(versionId, tenantId);

  const allChunks = await listChunksByVersion(versionId, tenantId, false);
  const activeChunks = allChunks.filter((c) => c.chunkActive);
  const replacedChunks = allChunks.filter((c) => !c.chunkActive);

  const idxState = await getIndexStateByVersion(versionId, tenantId);

  const explanation =
    activeChunks.length === 0
      ? "No active chunks. Run runChunkingForDocumentVersion to create chunks."
      : idxState?.indexState === "stale"
      ? `${activeChunks.length} active chunks exist but index is stale — embeddings need rebuilding.`
      : idxState?.indexState === "pending"
      ? `${activeChunks.length} active chunks are ready for embedding/indexing.`
      : idxState?.indexState === "indexed"
      ? `${activeChunks.length} active chunks are fully indexed and retrievable.`
      : `${activeChunks.length} active chunks exist. No index state row found.`;

  return {
    versionId,
    activeChunkCount: activeChunks.length,
    replacedChunkCount: replacedChunks.length,
    indexState: idxState?.indexState ?? null,
    chunkCount: idxState?.chunkCount ?? null,
    indexedChunkCount: idxState?.indexedChunkCount ?? null,
    explanation,
  };
}

/**
 * previewChunkReplacement — inspects what would happen if chunking ran again.
 */
export async function previewChunkReplacement(
  versionId: string,
  tenantId: string,
): Promise<{
  currentActiveChunkCount: number;
  currentIndexState: string | null;
  wouldDeactivate: number;
  explanation: string;
}> {
  await assertVersionTenant(versionId, tenantId);

  const activeChunks = await listChunksByVersion(versionId, tenantId, true);
  const idxState = await getIndexStateByVersion(versionId, tenantId);

  const explanation =
    activeChunks.length === 0
      ? "No active chunks to replace. Chunking would insert new chunks fresh."
      : `Re-chunking would deactivate ${activeChunks.length} existing active chunks and insert new ones. Index state would transition to '${idxState?.indexState === "indexed" ? "stale" : "pending"}'.`;

  return {
    currentActiveChunkCount: activeChunks.length,
    currentIndexState: idxState?.indexState ?? null,
    wouldDeactivate: activeChunks.length,
    explanation,
  };
}

/**
 * listDocumentProcessingJobs — list all processing jobs for a document.
 */
export async function listDocumentProcessingJobs(
  documentId: string,
  tenantId: string,
  jobType?: string,
): Promise<KnowledgeProcessingJob[]> {
  await assertDocumentTenant(documentId, tenantId);
  const conditions = [
    eq(knowledgeProcessingJobs.knowledgeDocumentId, documentId),
    eq(knowledgeProcessingJobs.tenantId, tenantId),
  ];
  if (jobType) conditions.push(eq(knowledgeProcessingJobs.jobType, jobType));
  return db
    .select()
    .from(knowledgeProcessingJobs)
    .where(and(...conditions))
    .orderBy(desc(knowledgeProcessingJobs.createdAt));
}

// ─── Phase 5B.1: Structured Parse / Chunk Flows ───────────────────────────────

export interface RunStructuredParseOptions {
  content?: string;
  workerId?: string;
  idempotencyKey?: string;
  parseOptions?: StructuredParseOptions;
}

export interface StructuredParseExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  structuredParseStatus: "completed" | "failed";
  sheetCount?: number;
  rowCount?: number;
  columnCount?: number;
  contentChecksum?: string;
  error?: string;
  parseResult?: StructuredParseResult;
}

/**
 * runStructuredParseForDocumentVersion — Phase 5B.1 structured parse flow.
 *
 * INV-SP1: validates version→document→KB chain + tenant (same tenant).
 * INV-SP5: archived/inactive KB or document blocks processing.
 * INV-SP6: parse failure does NOT clear valid historical chunks.
 * INV-SP9: cross-tenant linkage rejected.
 * INV-SP11: unsupported/malformed formats fail explicitly.
 * INV-SP12: does NOT mark document_status='ready'.
 */
export async function runStructuredParseForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunStructuredParseOptions = {},
): Promise<StructuredParseExecutionResult> {
  const ctx = await assertFullVersionContext(versionId, tenantId, { requireActiveLifecycle: true });

  const mimeType = ctx.version.mimeType ?? "";

  if (!opts.content) {
    const reason = `No structured content provided for version ${versionId}. Storage-backed structured parsing not yet wired — supply content directly (INV-SP11).`;
    await db
      .update(knowledgeDocumentVersions)
      .set({
        structuredParseStatus: "failed",
        structuredParseFailureReason: reason,
        structuredParseCompletedAt: new Date(),
      })
      .where(
        and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
      );

    const [failJob] = await db
      .insert(knowledgeProcessingJobs)
      .values({
        tenantId,
        knowledgeDocumentId: ctx.document.id,
        knowledgeDocumentVersionId: versionId,
        jobType: "structured_parse",
        status: "failed",
        failureReason: reason,
        structuredProcessorName: "structured_parse_runner",
        structuredProcessorVersion: "1.0",
        idempotencyKey: opts.idempotencyKey ?? null,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();
    return { jobId: failJob.id, status: "failed", structuredParseStatus: "failed", error: reason };
  }

  const [job] = await db
    .insert(knowledgeProcessingJobs)
    .values({
      tenantId,
      knowledgeDocumentId: ctx.document.id,
      knowledgeDocumentVersionId: versionId,
      jobType: "structured_parse",
      status: "queued",
      structuredProcessorName: "structured_parse_runner",
      structuredProcessorVersion: "1.0",
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();

  const acquired = await acquireKnowledgeProcessingJob(job.id, tenantId, {
    workerId: opts.workerId,
    processorName: "structured_parse_runner",
    processorVersion: "1.0",
  });

  if (!acquired) {
    return {
      jobId: job.id,
      status: "failed",
      structuredParseStatus: "failed",
      error: "Failed to acquire structured parse job — may have been taken by another worker.",
    };
  }

  await db
    .update(knowledgeDocumentVersions)
    .set({ structuredParseStatus: "running", structuredParseStartedAt: new Date(), structuredParseFailureReason: null })
    .where(
      and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
    );

  let parseResult: StructuredParseResult;

  try {
    const raw = parseStructuredDocumentVersion(opts.content, mimeType, opts.parseOptions);
    parseResult = normalizeStructuredDocument(raw);
  } catch (err) {
    const reason = (err as Error).message;
    await db
      .update(knowledgeDocumentVersions)
      .set({
        structuredParseStatus: "failed",
        structuredParseCompletedAt: new Date(),
        structuredParseFailureReason: reason,
      })
      .where(
        and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
      );
    await failKnowledgeProcessingJob(job.id, tenantId, reason);
    return { jobId: job.id, status: "failed", structuredParseStatus: "failed", error: reason };
  }

  await db
    .update(knowledgeDocumentVersions)
    .set({
      structuredParseStatus: "completed",
      structuredParseCompletedAt: new Date(),
      structuredParseFailureReason: null,
      structuredSheetCount: parseResult.totalSheetCount,
      structuredRowCount: parseResult.totalRowCount,
      structuredColumnCount: parseResult.totalColumnCount,
      structuredContentChecksum: parseResult.contentChecksum,
    })
    .where(
      and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
    );

  await completeKnowledgeProcessingJob(job.id, tenantId, {
    parserName: parseResult.parserName,
    parserVersion: parseResult.parserVersion,
    sheetCount: parseResult.totalSheetCount,
    rowCount: parseResult.totalRowCount,
    columnCount: parseResult.totalColumnCount,
    contentChecksum: parseResult.contentChecksum,
    warnings: parseResult.warnings,
  });

  return {
    jobId: job.id,
    status: "completed",
    structuredParseStatus: "completed",
    sheetCount: parseResult.totalSheetCount,
    rowCount: parseResult.totalRowCount,
    columnCount: parseResult.totalColumnCount,
    contentChecksum: parseResult.contentChecksum,
    parseResult,
  };
}

export async function markStructuredParseFailed(
  versionId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
  await db
    .update(knowledgeDocumentVersions)
    .set({ structuredParseStatus: "failed", structuredParseCompletedAt: new Date(), structuredParseFailureReason: reason })
    .where(
      and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
    );
}

export async function markStructuredParseCompleted(
  versionId: string,
  tenantId: string,
  meta: {
    sheetCount: number;
    rowCount: number;
    columnCount: number;
    contentChecksum: string;
  },
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
  await db
    .update(knowledgeDocumentVersions)
    .set({
      structuredParseStatus: "completed",
      structuredParseCompletedAt: new Date(),
      structuredParseFailureReason: null,
      structuredSheetCount: meta.sheetCount,
      structuredRowCount: meta.rowCount,
      structuredColumnCount: meta.columnCount,
      structuredContentChecksum: meta.contentChecksum,
    })
    .where(
      and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
    );
}

// ─── Structured Index State Integration ──────────────────────────────────────

/**
 * syncIndexStateAfterStructuredChunking
 *
 * INV-SP4: does NOT mark index_state='indexed'.
 * If prior state was 'indexed', transitions to 'stale'. Otherwise 'pending'.
 */
export async function syncIndexStateAfterStructuredChunking(
  versionId: string,
  tenantId: string,
  knowledgeBaseId: string,
  knowledgeDocumentId: string,
  newChunkCount: number,
): Promise<KnowledgeIndexStateRow> {
  const existing = await getIndexStateByVersion(versionId, tenantId);
  const priorState = existing?.indexState ?? null;
  const newIndexState = priorState === "indexed" ? "stale" : "pending";
  const staleReason =
    priorState === "indexed" ? "Structured chunks rebuilt — embeddings and index are now stale." : undefined;

  const [row] = await db
    .insert(knowledgeIndexState)
    .values({
      tenantId,
      knowledgeBaseId,
      knowledgeDocumentId,
      knowledgeDocumentVersionId: versionId,
      indexState: newIndexState,
      chunkCount: newChunkCount,
      indexedChunkCount: 0,
      embeddingCount: 0,
      staleReason: staleReason ?? null,
      failureReason: null,
    })
    .onConflictDoUpdate({
      target: knowledgeIndexState.knowledgeDocumentVersionId,
      set: {
        indexState: newIndexState,
        chunkCount: newChunkCount,
        indexedChunkCount: 0,
        embeddingCount: 0,
        staleReason: staleReason ?? null,
        failureReason: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function markIndexStateStaleAfterStructuredChunkReplace(
  versionId: string,
  tenantId: string,
  reason?: string,
): Promise<void> {
  await db
    .update(knowledgeIndexState)
    .set({
      indexState: "stale",
      staleReason: reason ?? "Structured chunks were replaced — index is now stale.",
      indexedChunkCount: 0,
      embeddingCount: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId),
        eq(knowledgeIndexState.tenantId, tenantId),
      ),
    );
}

// ─── Structured Chunk Execution Flow ─────────────────────────────────────────

export interface RunStructuredChunkingOptions {
  content?: string;
  parseResult?: StructuredParseResult;
  chunkingConfig?: Partial<StructuredChunkingConfig>;
  workerId?: string;
  idempotencyKey?: string;
}

export interface StructuredChunkingExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  chunkCount: number;
  priorStructuredChunksDeactivated: number;
  indexState?: string;
  error?: string;
}

/**
 * runStructuredChunkingForDocumentVersion — Phase 5B.1 structured chunk flow.
 *
 * INV-SP2: chunks only the explicitly requested version.
 * INV-SP3: requires successful structured_parse_status='completed' or explicit parseResult.
 * INV-SP4: does NOT mark document retrievable (indexState never set to 'indexed').
 * INV-SP7: transactional deactivation + insert — no partial active chunk corruption.
 * INV-SP8: non-current version chunking does not alter current version retrieval state.
 * INV-SP9: cross-tenant rejected.
 * INV-SP10: chunk keys and hashes are deterministic.
 * INV-SP12: 5A.1 invariants preserved.
 */
export async function runStructuredChunkingForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunStructuredChunkingOptions = {},
): Promise<StructuredChunkingExecutionResult> {
  const ctx = await assertFullVersionContext(versionId, tenantId, { requireActiveLifecycle: true });

  const [ver] = await db
    .select({
      id: knowledgeDocumentVersions.id,
      structuredParseStatus: knowledgeDocumentVersions.structuredParseStatus,
      mimeType: knowledgeDocumentVersions.mimeType,
    })
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.id, versionId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );

  if (!ver) throw new KnowledgeInvariantError("INV-SP2", `version ${versionId} not found`);

  if (ver.structuredParseStatus !== "completed" && !opts.parseResult && !opts.content) {
    const error = `Cannot structured-chunk version ${versionId}: structured_parse_status is '${ver.structuredParseStatus ?? "null"}'. Run structured parse first or supply parseResult/content. (INV-SP3)`;
    return { jobId: "none", status: "failed", chunkCount: 0, priorStructuredChunksDeactivated: 0, error };
  }

  const [job] = await db
    .insert(knowledgeProcessingJobs)
    .values({
      tenantId,
      knowledgeDocumentId: ctx.document.id,
      knowledgeDocumentVersionId: versionId,
      jobType: "structured_chunk",
      status: "queued",
      structuredProcessorName: "structured_chunk_runner",
      structuredProcessorVersion: "1.0",
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();

  const acquired = await acquireKnowledgeProcessingJob(job.id, tenantId, {
    workerId: opts.workerId,
    processorName: "structured_chunk_runner",
    processorVersion: "1.0",
  });

  if (!acquired) {
    return {
      jobId: job.id,
      status: "failed",
      chunkCount: 0,
      priorStructuredChunksDeactivated: 0,
      error: "Failed to acquire structured chunk job — may have been taken by another worker.",
    };
  }

  let structuredParseResult: StructuredParseResult;

  if (opts.parseResult) {
    structuredParseResult = opts.parseResult;
  } else if (opts.content) {
    const mimeType = ver.mimeType ?? "text/csv";
    try {
      const raw = parseStructuredDocumentVersion(opts.content, mimeType);
      structuredParseResult = normalizeStructuredDocument(raw);
    } catch (err) {
      const reason = `Structured parse step failed during chunking: ${(err as Error).message}`;
      await failKnowledgeProcessingJob(job.id, tenantId, reason);
      return { jobId: job.id, status: "failed", chunkCount: 0, priorStructuredChunksDeactivated: 0, error: reason };
    }
  } else {
    const reason = "No parseResult or content provided for structured chunking.";
    await failKnowledgeProcessingJob(job.id, tenantId, reason);
    return { jobId: job.id, status: "failed", chunkCount: 0, priorStructuredChunksDeactivated: 0, error: reason };
  }

  const candidates = chunkStructuredDocument(
    structuredParseResult,
    ctx.document.id,
    versionId,
    opts.chunkingConfig,
  );

  let priorDeactivated = 0;
  let newChunkCount = 0;
  let indexStateRow: KnowledgeIndexStateRow | undefined;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      const priorActive = await tx
        .update(knowledgeChunks)
        .set({ chunkActive: false, replacedAt: now, replacedByJobId: job.id })
        .where(
          and(
            eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
            eq(knowledgeChunks.tenantId, tenantId),
            eq(knowledgeChunks.chunkActive, true),
            eq(knowledgeChunks.tableChunk, true),
          ),
        )
        .returning();
      priorDeactivated = priorActive.length;

      if (candidates.length > 0) {
        const inserts = candidates.map((c) => ({
          tenantId,
          knowledgeBaseId: ctx.kb.id,
          knowledgeDocumentId: ctx.document.id,
          knowledgeDocumentVersionId: versionId,
          chunkIndex: c.chunkIndex,
          chunkKey: c.chunkKey,
          chunkHash: c.chunkHash,
          chunkText: c.chunkText,
          sheetName: c.sheetName,
          rowStart: c.rowStart,
          rowEnd: c.rowEnd,
          columnHeaders: c.columnHeaders as unknown as Record<string, unknown>,
          tableChunk: true as const,
          tableChunkStrategy: c.tableChunkStrategy,
          tableChunkVersion: c.tableChunkVersion,
          tokenEstimate: c.tokenEstimate,
          chunkActive: true as const,
          metadata: null,
        }));
        await tx.insert(knowledgeChunks).values(inserts);
        newChunkCount = candidates.length;
      }

      await tx
        .update(knowledgeProcessingJobs)
        .set({
          status: "completed",
          completedAt: now,
          heartbeatAt: now,
          resultSummary: {
            chunkCount: newChunkCount,
            priorStructuredChunksDeactivated: priorDeactivated,
            strategy: opts.chunkingConfig?.strategy ?? "table_rows",
            sheetCount: structuredParseResult.totalSheetCount,
          },
        })
        .where(
          and(
            eq(knowledgeProcessingJobs.id, job.id),
            eq(knowledgeProcessingJobs.tenantId, tenantId),
          ),
        );
    });

    indexStateRow = await syncIndexStateAfterStructuredChunking(
      versionId,
      tenantId,
      ctx.kb.id,
      ctx.document.id,
      newChunkCount,
    );
  } catch (err) {
    await failKnowledgeProcessingJob(
      job.id,
      tenantId,
      `Structured chunk transaction failed: ${(err as Error).message}`,
    );
    return {
      jobId: job.id,
      status: "failed",
      chunkCount: 0,
      priorStructuredChunksDeactivated: 0,
      error: `Structured chunk transaction failed: ${(err as Error).message}`,
    };
  }

  return {
    jobId: job.id,
    status: "completed",
    chunkCount: newChunkCount,
    priorStructuredChunksDeactivated: priorDeactivated,
    indexState: indexStateRow?.indexState,
  };
}

export async function markStructuredChunkingFailed(
  versionId: string,
  tenantId: string,
  _reason: string,
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
}

export async function markStructuredChunkingCompleted(
  versionId: string,
  tenantId: string,
  _meta: { chunkCount: number },
): Promise<void> {
  await assertVersionTenant(versionId, tenantId);
}

// ─── Phase 5B.1 Inspection Helpers ───────────────────────────────────────────

export async function explainStructuredParseState(
  versionId: string,
  tenantId: string,
): Promise<{
  versionId: string;
  structuredParseStatus: string | null;
  sheetCount: number | null;
  rowCount: number | null;
  columnCount: number | null;
  contentChecksum: string | null;
  failureReason: string | null;
  parsedAt: Date | null;
}> {
  await assertVersionTenant(versionId, tenantId);
  const [ver] = await db
    .select({
      structuredParseStatus: knowledgeDocumentVersions.structuredParseStatus,
      structuredSheetCount: knowledgeDocumentVersions.structuredSheetCount,
      structuredRowCount: knowledgeDocumentVersions.structuredRowCount,
      structuredColumnCount: knowledgeDocumentVersions.structuredColumnCount,
      structuredContentChecksum: knowledgeDocumentVersions.structuredContentChecksum,
      structuredParseFailureReason: knowledgeDocumentVersions.structuredParseFailureReason,
      structuredParseCompletedAt: knowledgeDocumentVersions.structuredParseCompletedAt,
    })
    .from(knowledgeDocumentVersions)
    .where(
      and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)),
    );

  return {
    versionId,
    structuredParseStatus: ver?.structuredParseStatus ?? null,
    sheetCount: ver?.structuredSheetCount ?? null,
    rowCount: ver?.structuredRowCount ?? null,
    columnCount: ver?.structuredColumnCount ?? null,
    contentChecksum: ver?.structuredContentChecksum ?? null,
    failureReason: ver?.structuredParseFailureReason ?? null,
    parsedAt: ver?.structuredParseCompletedAt ?? null,
  };
}

export async function explainStructuredChunkState(
  versionId: string,
  tenantId: string,
): Promise<{
  versionId: string;
  activeTableChunkCount: number;
  totalTableChunkCount: number;
  replacedTableChunkCount: number;
  strategy: string | null;
  sheets: string[];
  indexState: string | null;
}> {
  await assertVersionTenant(versionId, tenantId);

  const allChunks = await db
    .select({
      chunkActive: knowledgeChunks.chunkActive,
      tableChunk: knowledgeChunks.tableChunk,
      sheetName: knowledgeChunks.sheetName,
      tableChunkStrategy: knowledgeChunks.tableChunkStrategy,
    })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
        eq(knowledgeChunks.tenantId, tenantId),
        eq(knowledgeChunks.tableChunk, true),
      ),
    );

  const active = allChunks.filter((c) => c.chunkActive);
  const replaced = allChunks.filter((c) => !c.chunkActive);
  const sheets = Array.from(new Set(active.map((c) => c.sheetName).filter(Boolean) as string[]));
  const strategy = active[0]?.tableChunkStrategy ?? null;

  const idxState = await getIndexStateByVersion(versionId, tenantId);

  return {
    versionId,
    activeTableChunkCount: active.length,
    totalTableChunkCount: allChunks.length,
    replacedTableChunkCount: replaced.length,
    strategy,
    sheets,
    indexState: idxState?.indexState ?? null,
  };
}

export async function previewStructuredChunkReplacement(
  versionId: string,
  tenantId: string,
): Promise<{
  currentActiveTableChunkCount: number;
  currentIndexState: string | null;
  wouldDeactivate: number;
  explanation: string;
}> {
  await assertVersionTenant(versionId, tenantId);

  const active = await db
    .select({ id: knowledgeChunks.id })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
        eq(knowledgeChunks.tenantId, tenantId),
        eq(knowledgeChunks.chunkActive, true),
        eq(knowledgeChunks.tableChunk, true),
      ),
    );

  const idxState = await getIndexStateByVersion(versionId, tenantId);
  const explanation =
    active.length === 0
      ? "No active table chunks to replace. Structured chunking would insert new table chunks fresh."
      : `Re-running structured chunking would deactivate ${active.length} existing active table chunks and insert new ones. Index state would transition to '${idxState?.indexState === "indexed" ? "stale" : "pending"}'.`;

  return {
    currentActiveTableChunkCount: active.length,
    currentIndexState: idxState?.indexState ?? null,
    wouldDeactivate: active.length,
    explanation,
  };
}

export async function listStructuredProcessingJobs(
  documentId: string,
  tenantId: string,
): Promise<KnowledgeProcessingJob[]> {
  await assertDocumentTenant(documentId, tenantId);
  return db
    .select()
    .from(knowledgeProcessingJobs)
    .where(
      and(
        eq(knowledgeProcessingJobs.knowledgeDocumentId, documentId),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
        sql`${knowledgeProcessingJobs.jobType} IN ('structured_parse','structured_chunk')`,
      ),
    )
    .orderBy(desc(knowledgeProcessingJobs.createdAt));
}

export async function summarizeStructuredChunkingResult(
  jobId: string,
  tenantId: string,
): Promise<{
  jobId: string;
  status: string;
  chunkCount: number;
  priorStructuredChunksDeactivated: number;
  strategy: string | null;
  sheetCount: number | null;
  processorName: string | null;
  processorVersion: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}> {
  const job = await getProcessingJob(jobId, tenantId);
  if (!job) throw new KnowledgeInvariantError("INV-SP1", `processing job ${jobId} not found`);

  const summary = (job.resultSummary ?? {}) as Record<string, unknown>;

  return {
    jobId: job.id,
    status: job.status,
    chunkCount: (summary.chunkCount as number) ?? 0,
    priorStructuredChunksDeactivated: (summary.priorStructuredChunksDeactivated as number) ?? 0,
    strategy: (summary.strategy as string) ?? null,
    sheetCount: (summary.sheetCount as number) ?? null,
    processorName: job.structuredProcessorName,
    processorVersion: job.structuredProcessorVersion,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failureReason: job.failureReason,
  };
}

/**
 * summarizeChunkingResult — summarizes a completed chunk job's result.
 */
export async function summarizeChunkingResult(
  jobId: string,
  tenantId: string,
): Promise<{
  jobId: string;
  status: string;
  chunkCount: number;
  priorChunksDeactivated: number;
  strategy: string | null;
  processorName: string | null;
  processorVersion: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}> {
  const job = await getProcessingJob(jobId, tenantId);
  if (!job) throw new KnowledgeInvariantError("INV-P1", `processing job ${jobId} not found`);

  const summary = (job.resultSummary ?? {}) as Record<string, unknown>;

  return {
    jobId: job.id,
    status: job.status,
    chunkCount: (summary.chunkCount as number) ?? 0,
    priorChunksDeactivated: (summary.priorChunksDeactivated as number) ?? 0,
    strategy: (summary.strategy as string) ?? null,
    processorName: job.processorName,
    processorVersion: job.processorVersion,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failureReason: job.failureReason,
  };
}
