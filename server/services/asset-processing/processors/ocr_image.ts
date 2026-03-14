/**
 * ocr_image.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Run OCR pipeline on image asset
 *   - Store extracted text in asset version metadata
 *   - Enqueue chunk_text job
 *
 * Stub implementation: real OCR engine integration pending.
 * INV-PROC-5: idempotent — if ocrText already present, skip.
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

async function ocrImage(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if OCR already completed (INV-PROC-5)
  if (existingMeta.ocrText) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "ocrText already present" },
    };
  }

  // Stub OCR — real OCR would call Tesseract, AWS Textract, Google Vision, etc.
  const mimeType = version?.mimeType ?? "image/unknown";
  const ocrText = `[STUB OCR OUTPUT] Asset: ${asset.id} | Image MIME: ${mimeType}. OCR text extraction pending real OCR engine integration. Configure OCR_PROVIDER env variable to enable.`;

  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      parsedText: ocrText,
      ocrText,
      ocrProvider: "stub",
      ocrCompletedAt: new Date().toISOString(),
      ocrConfidence: null,
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
      metadata: { triggeredBy: job.id, ocrProvider: "stub" },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      ocrProvider: "stub",
      ocrTextLength: ocrText.length,
      mimeType,
    },
  };
}

// Self-register on module load
registerProcessor("ocr_image", ocrImage);
