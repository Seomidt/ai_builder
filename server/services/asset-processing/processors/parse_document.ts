/**
 * parse_document.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Retrieve asset version + storage object reference
 *   - Extract text content (stub — real parser registered when parser service available)
 *   - Store extracted text in asset version metadata
 *   - Enqueue next pipeline step (chunk_text)
 *
 * INV-PROC-5: idempotent — if parsedText already present in metadata, skip re-parse.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../../db";
import { knowledgeAssets, knowledgeAssetVersions, knowledgeAssetProcessingJobs } from "@shared/schema";
import {
  registerProcessor,
  type ProcessorContext,
  type ProcessorResult,
} from "../asset_processor_registry";
import { enqueueAssetProcessingJob } from "../../../lib/ai/knowledge-asset-processing";
import { getNextJobType } from "../asset_processing_pipeline";

async function parseDocument(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  // Idempotency: if text already parsed, skip (INV-PROC-5)
  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;
  if (existingMeta.parsedText) {
    return {
      success: true,
      nextJobType: getNextJobType(asset.assetType, job.jobType) ?? undefined,
      outputMetadata: { skippedReason: "parsedText already present" },
    };
  }

  // Stub extraction: in production this would call a real document parser
  // (PDF, DOCX, HTML, etc.) via the storage object reference
  const mimeType = version?.mimeType ?? "application/octet-stream";
  const sizeBytes = version?.sizeBytes ?? 0;

  const parsedText = `[STUB PARSED TEXT] Asset: ${asset.id} | Version: ${version?.id ?? "none"} | MIME: ${mimeType} | Size: ${sizeBytes} bytes. Content extraction pending real parser integration.`;

  // Store parsed text in asset version metadata
  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      parsedText,
      parsedAt: new Date().toISOString(),
      parserVersion: "stub-v1",
      parseSource: "phase5i-stub",
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

  // Enqueue next step
  if (nextJobType) {
    await enqueueAssetProcessingJob({
      tenantId,
      assetId: asset.id,
      assetVersionId: version?.id ?? null,
      jobType: nextJobType,
      metadata: { triggeredBy: job.id, pipelineStep: "post_parse_document" },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      parsedTextLength: parsedText.length,
      mimeType,
      parserVersion: "stub-v1",
    },
  };
}

// Self-register on module load
registerProcessor("parse_document", parseDocument);
