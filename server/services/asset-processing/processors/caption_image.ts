/**
 * caption_image.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Generate image caption metadata (stub — real captioning via vision model)
 *   - Store caption text in asset version metadata
 *   - Enqueue chunk_text job
 *
 * INV-PROC-5: idempotent — if captionText already present, skip.
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

async function captionImage(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if caption already generated (INV-PROC-5)
  if (existingMeta.captionText) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "captionText already present" },
    };
  }

  // Stub captioning — real implementation would call GPT-4o vision or similar
  const captionText = `[STUB CAPTION] Asset: ${asset.id} | Title: ${asset.title ?? "untitled"}. Visual content description pending real vision model integration. Configure VISION_MODEL env variable to enable.`;

  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      parsedText: captionText,
      captionText,
      captionProvider: "stub",
      captionCompletedAt: new Date().toISOString(),
      captionModel: null,
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
      metadata: { triggeredBy: job.id, captionProvider: "stub" },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      captionProvider: "stub",
      captionTextLength: captionText.length,
    },
  };
}

// Self-register on module load
registerProcessor("caption_image", captionImage);
