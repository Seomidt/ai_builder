/**
 * index_asset.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Validate embeddings exist in asset version metadata
 *   - Mark asset version as indexed in metadata
 *   - Update asset processing_state → ready
 *
 * INV-PROC-5: idempotent — if already indexed, skip without error.
 * INV-PROC-9: respects asset lifecycle — only indexes active assets.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../../db";
import { knowledgeAssets, knowledgeAssetVersions } from "@shared/schema";
import {
  registerProcessor,
  type ProcessorContext,
  type ProcessorResult,
} from "../asset_processor_registry";

async function indexAsset(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version } = ctx;

  // INV-PROC-9: only index active assets
  if (asset.lifecycleState !== "active") {
    return {
      success: false,
      errorMessage: `Cannot index asset in lifecycle state: ${asset.lifecycleState}. Only active assets can be indexed.`,
    };
  }

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if already indexed (INV-PROC-5)
  if (existingMeta.indexedAt) {
    return {
      success: true,
      outputMetadata: { skippedReason: "already indexed", indexedAt: existingMeta.indexedAt },
    };
  }

  // Validate embeddings exist
  const embeddings = existingMeta.assetEmbeddings as unknown[] | undefined;
  if (!embeddings || embeddings.length === 0) {
    return {
      success: false,
      errorMessage: "No assetEmbeddings found in asset version metadata — embed_text must run first",
    };
  }

  // Mark version as indexed
  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      indexedAt: new Date().toISOString(),
      indexVersion: "phase5i-v1",
      embeddingCount: embeddings.length,
      vectorBackend: "pgvector",
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

  // Update asset processing_state → ready
  await db
    .update(knowledgeAssets)
    .set({
      processingState: "ready",
      updatedAt: new Date(),
    })
    .where(eq(knowledgeAssets.id, asset.id));

  return {
    success: true,
    outputMetadata: {
      embeddingCount: embeddings.length,
      indexedAt: new Date().toISOString(),
      assetProcessingState: "ready",
    },
  };
}

// Self-register on module load
registerProcessor("index_asset", indexAsset);
