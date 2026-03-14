/**
 * chunk_text.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Load parsed text from asset version metadata
 *   - Split into chunks using a fixed-size strategy
 *   - Store chunks in asset version metadata (asset_chunks)
 *   - Enqueue embed_text job
 *
 * INV-PROC-5: idempotent — if chunks already present in metadata, skip.
 *
 * Note: Phase 5I stores chunks in asset version metadata (not knowledge_chunks)
 * because knowledge_chunks requires knowledge_document_id FK which belongs to
 * the Phase 5A document registry. Asset-native chunk storage is introduced here
 * and will be migrated to a dedicated table in a future phase.
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

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_CHUNK_OVERLAP = 50;

interface AssetChunk {
  chunkIndex: number;
  chunkKey: string;
  characterStart: number;
  characterEnd: number;
  chunkText: string;
  tokenEstimate: number;
}

function splitIntoChunks(text: string, chunkSize: number, overlap: number): AssetChunk[] {
  const chunks: AssetChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunkText = text.slice(start, end);
    chunks.push({
      chunkIndex: index,
      chunkKey: `chunk-${index}-${start}-${end}`,
      characterStart: start,
      characterEnd: end,
      chunkText,
      tokenEstimate: Math.ceil(chunkText.length / 4),
    });
    index++;
    start = end - overlap;
    if (start >= text.length || end === text.length) break;
  }

  return chunks;
}

async function chunkText(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if chunks already generated (INV-PROC-5)
  if (Array.isArray(existingMeta.assetChunks) && (existingMeta.assetChunks as unknown[]).length > 0) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "assetChunks already present", chunkCount: (existingMeta.assetChunks as unknown[]).length },
    };
  }

  // Retrieve parsed text from previous step
  const parsedText = (existingMeta.parsedText as string | undefined) ?? "";
  if (!parsedText) {
    return {
      success: false,
      errorMessage: "No parsedText found in asset version metadata — parse_document must run first",
    };
  }

  const chunkSize = Number(
    ((existingMeta.chunkSize as number | undefined) ?? DEFAULT_CHUNK_SIZE),
  );
  const overlap = Number(
    ((existingMeta.chunkOverlap as number | undefined) ?? DEFAULT_CHUNK_OVERLAP),
  );

  const chunks = splitIntoChunks(parsedText, chunkSize, overlap);

  // Store chunks in asset version metadata
  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      assetChunks: chunks,
      chunkedAt: new Date().toISOString(),
      chunkStrategy: "fixed-size-overlap",
      chunkVersion: "v1",
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
      metadata: { triggeredBy: job.id, chunkCount: chunks.length },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      chunkCount: chunks.length,
      totalCharacters: parsedText.length,
      chunkStrategy: "fixed-size-overlap",
    },
  };
}

// Self-register on module load
registerProcessor("chunk_text", chunkText);
