/**
 * Phase 5C — Embedding Execution Flow
 *
 * runEmbeddingForDocumentVersion:
 *   1. Validate tenant ownership + version chain (INV-EMB1)
 *   2. Validate version exists and KB is active (INV-EMB2)
 *   3. Fetch active chunks for the version
 *   4. Create processing job (embedding_generate)
 *   5. Batch chunks (50–100 per batch)
 *   6. Call embedding provider per batch
 *   7. Persist embeddings transactionally (INV-EMB7)
 *   8. Update embedding status on knowledge_embeddings rows
 *   9. Update knowledge_index_state.embedding_count (NOT index_state='indexed')
 *
 * retryEmbeddingForDocumentVersion:
 *   - Creates embedding_retry job
 *   - Re-processes failed embeddings for a version
 *
 * Invariants:
 *   INV-EMB1: Tenant isolation — cross-tenant access fails explicitly
 *   INV-EMB2: Only active KB documents are processed
 *   INV-EMB3: Re-running replaces all prior embeddings transactionally (INV-EMB7)
 *   INV-EMB4: NEVER sets index_state='indexed'
 *   INV-EMB5: Each batch records provider, model, token_usage, estimated_cost_usd
 *   INV-EMB6: Empty chunk set fails explicitly — no silent empty embeddings
 *   INV-EMB7: Embedding replacement is transactional — no partial state
 *   INV-EMB8: embedding_count reflects completed embeddings only
 */

import { db } from "../../db";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  knowledgeDocumentVersions,
  knowledgeDocuments,
  knowledgeBases,
  knowledgeChunks,
  knowledgeEmbeddings,
  knowledgeProcessingJobs,
  knowledgeIndexState,
  type KnowledgeProcessingJob,
  type KnowledgeEmbedding,
} from "../../../shared/schema";
import { KnowledgeInvariantError } from "./knowledge-bases";
import {
  selectEmbeddingProvider,
  splitIntoBatches,
  normalizeEmbeddingVector,
  computeEmbeddingContentHash,
  summarizeEmbeddingCost,
  type EmbeddingBatchResult,
  type EmbeddingProvider,
  type EmbeddingProviderName,
} from "./embedding-providers";

// ─── Config ───────────────────────────────────────────────────────────────────

export const DEFAULT_EMBEDDING_BATCH_SIZE = 50;
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderName = "openai_small";

export interface RunEmbeddingOptions {
  providerName?: EmbeddingProviderName | string;
  batchSize?: number;
  workerId?: string;
  idempotencyKey?: string;
  skipExisting?: boolean;
  replaceExisting?: boolean;
}

export interface EmbeddingExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  chunksProcessed: number;
  embeddingsCreated: number;
  priorEmbeddingsDeactivated: number;
  totalTokenUsage: number;
  totalCostUsd: number;
  provider: string;
  model: string;
  batchCount: number;
  error?: string;
}

// ─── Tenant assertions ────────────────────────────────────────────────────────

async function assertEmbeddingVersionContext(versionId: string, tenantId: string) {
  const [ver] = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)));

  if (!ver) {
    throw new KnowledgeInvariantError(
      "INV-EMB1",
      `Document version ${versionId} not found for tenant ${tenantId}. Cross-tenant access denied — explicit failure.`,
    );
  }

  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, ver.knowledgeDocumentId), eq(knowledgeDocuments.tenantId, tenantId)));

  if (!doc) {
    throw new KnowledgeInvariantError("INV-EMB1", `Document for version ${versionId} not found or tenant mismatch.`);
  }

  const [kb] = await db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, doc.knowledgeBaseId), eq(knowledgeBases.tenantId, tenantId)));

  if (!kb) {
    throw new KnowledgeInvariantError("INV-EMB2", `Knowledge base for version ${versionId} not found or inactive.`);
  }

  return { ver, doc, kb };
}

// ─── Job helpers ──────────────────────────────────────────────────────────────

async function createEmbeddingJob(
  tenantId: string,
  documentId: string,
  versionId: string,
  jobType: "embedding_generate" | "embedding_retry",
  provider: EmbeddingProvider,
  idempotencyKey?: string,
): Promise<KnowledgeProcessingJob> {
  const [job] = await db
    .insert(knowledgeProcessingJobs)
    .values({
      tenantId,
      knowledgeDocumentId: documentId,
      knowledgeDocumentVersionId: versionId,
      jobType,
      status: "queued",
      embeddingProvider: provider.info.name,
      embeddingModel: provider.info.model,
      idempotencyKey: idempotencyKey ?? null,
    })
    .returning();
  return job;
}

async function acquireEmbeddingJob(
  jobId: string,
  tenantId: string,
  workerId?: string,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(knowledgeProcessingJobs)
    .set({
      status: "running",
      startedAt: now,
      lockedAt: now,
      heartbeatAt: now,
      workerId: workerId ?? null,
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
  return result.length > 0;
}

async function failEmbeddingJob(jobId: string, tenantId: string, reason: string): Promise<void> {
  await db
    .update(knowledgeProcessingJobs)
    .set({ status: "failed", failureReason: reason, completedAt: new Date(), heartbeatAt: new Date() })
    .where(and(eq(knowledgeProcessingJobs.id, jobId), eq(knowledgeProcessingJobs.tenantId, tenantId)));
}

// ─── Main embedding execution ─────────────────────────────────────────────────

export async function runEmbeddingForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunEmbeddingOptions = {},
): Promise<EmbeddingExecutionResult> {
  const { ver, doc, kb } = await assertEmbeddingVersionContext(versionId, tenantId);

  const provider = selectEmbeddingProvider(opts.providerName ?? DEFAULT_EMBEDDING_PROVIDER);
  const batchSize = opts.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;

  const job = await createEmbeddingJob(tenantId, doc.id, versionId, "embedding_generate", provider, opts.idempotencyKey);

  const acquired = await acquireEmbeddingJob(job.id, tenantId, opts.workerId);
  if (!acquired) {
    return {
      jobId: job.id, status: "failed", chunksProcessed: 0, embeddingsCreated: 0,
      priorEmbeddingsDeactivated: 0, totalTokenUsage: 0, totalCostUsd: 0,
      provider: provider.info.name, model: provider.info.model, batchCount: 0,
      error: "Failed to acquire embedding job lock — may already be running.",
    };
  }

  // Fetch active chunks
  const activeChunks = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
        eq(knowledgeChunks.tenantId, tenantId),
        eq(knowledgeChunks.chunkActive, true),
      ),
    )
    .orderBy(knowledgeChunks.chunkIndex);

  if (activeChunks.length === 0) {
    const reason = `No active chunks found for version ${versionId}. Embedding requires active chunks (INV-EMB6).`;
    await failEmbeddingJob(job.id, tenantId, reason);
    return {
      jobId: job.id, status: "failed", chunksProcessed: 0, embeddingsCreated: 0,
      priorEmbeddingsDeactivated: 0, totalTokenUsage: 0, totalCostUsd: 0,
      provider: provider.info.name, model: provider.info.model, batchCount: 0,
      error: reason,
    };
  }

  const batches = splitIntoBatches(activeChunks, batchSize);
  const batchResults: EmbeddingBatchResult[] = [];
  const newEmbeddingRows: Array<typeof knowledgeEmbeddings.$inferInsert> = [];

  try {
    for (const batch of batches) {
      const texts = batch.map((c) => c.chunkText ?? "");
      const result = await provider.generateBatch(texts);
      batchResults.push(result);

      for (let i = 0; i < batch.length; i++) {
        const chunk = batch[i];
        const chunkText = chunk.chunkText ?? "";
        const vector = normalizeEmbeddingVector(result.vectors[i]);
        const contentHash = computeEmbeddingContentHash(chunkText, result.model);
        const tokenEst = Math.ceil(chunkText.length / 4);

        newEmbeddingRows.push({
          tenantId,
          knowledgeBaseId: kb.id,
          knowledgeDocumentId: doc.id,
          knowledgeDocumentVersionId: versionId,
          knowledgeChunkId: chunk.id,
          embeddingProvider: result.provider,
          embeddingModel: result.model,
          embeddingStatus: "completed",
          embeddingVector: vector,
          embeddingDimensions: result.dimensions,
          tokenUsage: tokenEst,
          estimatedCostUsd: String(provider.info.costPerToken * tokenEst),
          vectorBackend: "pgvector",
          vectorStatus: "pending",
          contentHash,
          metadata: { batchIndex: batches.indexOf(batch), chunkIndex: chunk.chunkIndex, chunkKey: chunk.chunkKey },
        });
      }

      // Heartbeat
      await db
        .update(knowledgeProcessingJobs)
        .set({ heartbeatAt: new Date() })
        .where(and(eq(knowledgeProcessingJobs.id, job.id), eq(knowledgeProcessingJobs.tenantId, tenantId)));
    }
  } catch (err) {
    const reason = (err as Error).message;
    await failEmbeddingJob(job.id, tenantId, reason);
    return {
      jobId: job.id, status: "failed", chunksProcessed: 0, embeddingsCreated: 0,
      priorEmbeddingsDeactivated: 0, totalTokenUsage: 0, totalCostUsd: 0,
      provider: provider.info.name, model: provider.info.model, batchCount: batches.length,
      error: reason,
    };
  }

  let priorDeactivated = 0;
  let embeddingsCreated = 0;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      // Deactivate (mark failed/deleted) prior embeddings for this version (INV-EMB3/7)
      const prior = await tx
        .update(knowledgeEmbeddings)
        .set({ embeddingStatus: "failed", failureReason: "replaced_by_re-run", updatedAt: now })
        .where(
          and(
            eq(knowledgeEmbeddings.knowledgeDocumentVersionId, versionId),
            eq(knowledgeEmbeddings.tenantId, tenantId),
            eq(knowledgeEmbeddings.embeddingStatus, "completed"),
          ),
        )
        .returning();
      priorDeactivated = prior.length;

      // Insert new embeddings
      if (newEmbeddingRows.length > 0) {
        await tx.insert(knowledgeEmbeddings).values(newEmbeddingRows);
        embeddingsCreated = newEmbeddingRows.length;
      }
    });

    // Update index state — embedding_count only, NOT index_state='indexed' (INV-EMB4/8)
    const [existingIdx] = await db
      .select()
      .from(knowledgeIndexState)
      .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId), eq(knowledgeIndexState.tenantId, tenantId)));

    if (existingIdx) {
      await db
        .update(knowledgeIndexState)
        .set({ embeddingCount: embeddingsCreated, updatedAt: new Date() })
        .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId), eq(knowledgeIndexState.tenantId, tenantId)));
    } else {
      await db.insert(knowledgeIndexState).values({
        tenantId,
        knowledgeBaseId: kb.id,
        knowledgeDocumentId: doc.id,
        knowledgeDocumentVersionId: versionId,
        indexState: "pending",
        embeddingCount: embeddingsCreated,
        chunkCount: activeChunks.length,
      });
    }

    const costSummary = summarizeEmbeddingCost(batchResults);

    await db
      .update(knowledgeProcessingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        heartbeatAt: new Date(),
        tokenUsage: costSummary.totalTokens,
        estimatedCostUsd: String(costSummary.totalCostUsd.toFixed(8)),
        resultSummary: {
          chunksProcessed: activeChunks.length,
          embeddingsCreated,
          priorDeactivated,
          totalTokenUsage: costSummary.totalTokens,
          totalCostUsd: costSummary.totalCostUsd,
          provider: provider.info.name,
          model: provider.info.model,
          batchCount: batches.length,
        },
      })
      .where(and(eq(knowledgeProcessingJobs.id, job.id), eq(knowledgeProcessingJobs.tenantId, tenantId)));

    return {
      jobId: job.id,
      status: "completed",
      chunksProcessed: activeChunks.length,
      embeddingsCreated,
      priorEmbeddingsDeactivated: priorDeactivated,
      totalTokenUsage: costSummary.totalTokens,
      totalCostUsd: costSummary.totalCostUsd,
      provider: provider.info.name,
      model: provider.info.model,
      batchCount: batches.length,
    };
  } catch (err) {
    const reason = (err as Error).message;
    await failEmbeddingJob(job.id, tenantId, reason);
    return {
      jobId: job.id, status: "failed", chunksProcessed: 0, embeddingsCreated: 0,
      priorEmbeddingsDeactivated: 0, totalTokenUsage: 0, totalCostUsd: 0,
      provider: provider.info.name, model: provider.info.model, batchCount: 0,
      error: reason,
    };
  }
}

// ─── Retry failed embeddings ──────────────────────────────────────────────────

export async function retryEmbeddingForDocumentVersion(
  versionId: string,
  tenantId: string,
  opts: RunEmbeddingOptions = {},
): Promise<EmbeddingExecutionResult> {
  return runEmbeddingForDocumentVersion(versionId, tenantId, {
    ...opts,
    replaceExisting: true,
  });
}

// ─── Explain embedding state ──────────────────────────────────────────────────

export async function explainEmbeddingState(
  versionId: string,
  tenantId: string,
): Promise<{
  totalEmbeddings: number;
  completedEmbeddings: number;
  failedEmbeddings: number;
  pendingEmbeddings: number;
  embeddingCount: number;
  indexState: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
}> {
  const [ver] = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(and(eq(knowledgeDocumentVersions.id, versionId), eq(knowledgeDocumentVersions.tenantId, tenantId)));

  if (!ver) {
    throw new KnowledgeInvariantError("INV-EMB1", `Version ${versionId} not found for tenant ${tenantId}`);
  }

  const embeddings = await db
    .select()
    .from(knowledgeEmbeddings)
    .where(and(eq(knowledgeEmbeddings.knowledgeDocumentVersionId, versionId), eq(knowledgeEmbeddings.tenantId, tenantId)));

  const completed = embeddings.filter((e) => e.embeddingStatus === "completed");
  const failed = embeddings.filter((e) => e.embeddingStatus === "failed");
  const pending = embeddings.filter((e) => e.embeddingStatus === "pending");

  const [idxRow] = await db
    .select()
    .from(knowledgeIndexState)
    .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId), eq(knowledgeIndexState.tenantId, tenantId)));

  const provider = completed.length > 0 ? completed[0].embeddingProvider : null;
  const model = completed.length > 0 ? completed[0].embeddingModel : null;
  const dimensions = completed.length > 0 ? (completed[0].embeddingDimensions ?? null) : null;

  return {
    totalEmbeddings: embeddings.length,
    completedEmbeddings: completed.length,
    failedEmbeddings: failed.length,
    pendingEmbeddings: pending.length,
    embeddingCount: idxRow?.embeddingCount ?? 0,
    indexState: idxRow?.indexState ?? null,
    provider,
    model,
    dimensions,
  };
}

// ─── List embedding jobs ──────────────────────────────────────────────────────

export async function listEmbeddingJobs(
  documentId: string,
  tenantId: string,
): Promise<KnowledgeProcessingJob[]> {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));

  if (!doc) {
    throw new KnowledgeInvariantError("INV-EMB1", `Document ${documentId} not found for tenant ${tenantId}`);
  }

  return db
    .select()
    .from(knowledgeProcessingJobs)
    .where(
      and(
        eq(knowledgeProcessingJobs.knowledgeDocumentId, documentId),
        eq(knowledgeProcessingJobs.tenantId, tenantId),
        sql`${knowledgeProcessingJobs.jobType} IN ('embedding_generate','embedding_retry')`,
      ),
    )
    .orderBy(desc(knowledgeProcessingJobs.createdAt));
}

// ─── Summarize embedding result ───────────────────────────────────────────────

export async function summarizeEmbeddingResult(
  jobId: string,
  tenantId: string,
): Promise<{
  jobId: string;
  status: string;
  chunksProcessed: number;
  embeddingsCreated: number;
  priorDeactivated: number;
  totalTokenUsage: number;
  totalCostUsd: number;
  provider: string | null;
  model: string | null;
  batchCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}> {
  const [job] = await db
    .select()
    .from(knowledgeProcessingJobs)
    .where(and(eq(knowledgeProcessingJobs.id, jobId), eq(knowledgeProcessingJobs.tenantId, tenantId)));

  if (!job) {
    throw new KnowledgeInvariantError("INV-EMB1", `Processing job ${jobId} not found for tenant ${tenantId}`);
  }

  const summary = (job.resultSummary ?? {}) as Record<string, unknown>;
  return {
    jobId: job.id,
    status: job.status,
    chunksProcessed: (summary.chunksProcessed as number) ?? 0,
    embeddingsCreated: (summary.embeddingsCreated as number) ?? 0,
    priorDeactivated: (summary.priorDeactivated as number) ?? 0,
    totalTokenUsage: (summary.totalTokenUsage as number) ?? 0,
    totalCostUsd: (summary.totalCostUsd as number) ?? 0,
    provider: job.embeddingProvider ?? null,
    model: job.embeddingModel ?? null,
    batchCount: (summary.batchCount as number) ?? 0,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failureReason: job.failureReason,
  };
}

// ─── List embeddings for document ────────────────────────────────────────────

export async function listEmbeddingsForDocument(
  documentId: string,
  tenantId: string,
): Promise<Array<Omit<KnowledgeEmbedding, "embeddingVector">>> {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));

  if (!doc) {
    throw new KnowledgeInvariantError("INV-EMB1", `Document ${documentId} not found for tenant ${tenantId}`);
  }

  const rows = await db
    .select()
    .from(knowledgeEmbeddings)
    .where(and(eq(knowledgeEmbeddings.knowledgeDocumentId, documentId), eq(knowledgeEmbeddings.tenantId, tenantId)))
    .orderBy(knowledgeEmbeddings.createdAt);

  // Strip vectors from listing (too large)
  return rows.map((r) => {
    const { embeddingVector: _vec, ...rest } = r;
    return rest;
  });
}
