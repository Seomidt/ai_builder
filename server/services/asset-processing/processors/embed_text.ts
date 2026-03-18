/**
 * embed_text.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Retrieve chunks from asset version metadata
 *   - Generate embeddings (stub — real embedding via Phase 5C infrastructure)
 *   - Store embedding metadata in asset version
 *   - Enqueue index_asset job
 *
 * INV-PROC-5: idempotent — if embeddings already present, skip.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../../db";
import { knowledgeAssetVersions } from "@shared/schema";
import {
  registerProcessor,
  type ProcessorContext,
  type ProcessorResult,
} from "../asset_processor_registry";
import { enqueueAssetProcessingJob } from "../../../lib/ai/knowledge-asset-processing";
import { getNextJobType } from "../asset_processing_pipeline";

interface ChunkEmbedding {
  chunkIndex: number;
  chunkKey: string;
  embeddingStatus: "stub" | "completed" | "failed";
  embeddingDimensions: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingVersion: string;
  tokenUsage: number;
}

async function embedText(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if embeddings already generated (INV-PROC-5)
  if (Array.isArray(existingMeta.assetEmbeddings) && (existingMeta.assetEmbeddings as unknown[]).length > 0) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "assetEmbeddings already present" },
    };
  }

  const chunks = existingMeta.assetChunks as Array<{ chunkIndex: number; chunkKey: string; chunkText: string }> | undefined;
  if (!chunks || chunks.length === 0) {
    return {
      success: false,
      errorMessage: "No assetChunks found in asset version metadata — chunk_text must run first",
    };
  }

  // Stub embedding generation — each chunk gets a deterministic stub embedding record
  // Real implementation would call Phase 5C embedding infrastructure
  const embeddings: ChunkEmbedding[] = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    chunkKey: chunk.chunkKey,
    embeddingStatus: "stub",
    embeddingDimensions: 1536,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingVersion: "phase5c-stub-v1",
    tokenUsage: Math.ceil((chunk.chunkText?.length ?? 0) / 4),
  }));

  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      assetEmbeddings: embeddings,
      embeddedAt: new Date().toISOString(),
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingVersion: "phase5c-stub-v1",
      totalTokensUsed: embeddings.reduce((sum, e) => sum + e.tokenUsage, 0),
    };

    await db
      .update(knowledgeAssetVersions)
      .set({ metadata: updatedMeta })
      .where(
        and(
          eq(knowledgeAssetVersions.id, version.id),
          eq(knowledgeAssetVersions.assetId, asset.id),
        ),
      );
  }

  const nextJobType = getNextJobType(asset.assetType, job.jobType);

  if (nextJobType) {
    await enqueueAssetProcessingJob({
      tenantId,
      assetId: asset.id,
      assetVersionId: version?.id ?? null,
      jobType: nextJobType,
      metadata: { triggeredBy: job.id, embeddingCount: embeddings.length },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      embeddingCount: embeddings.length,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      totalTokensUsed: embeddings.reduce((sum, e) => sum + e.tokenUsage, 0),
    },
  };
}

// Self-register on module load
registerProcessor("embed_text", embedText);
