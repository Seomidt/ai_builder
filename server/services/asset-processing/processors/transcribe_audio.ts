/**
 * transcribe_audio.ts — Phase 5I processor
 *
 * Responsibilities:
 *   - Transcribe audio asset to text (stub — real transcription via Whisper/Deepgram)
 *   - Store transcript text in asset version metadata
 *   - Enqueue chunk_text job
 *
 * INV-PROC-5: idempotent — if transcriptText already present, skip.
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

async function transcribeAudio(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  const existingMeta = (version?.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if transcript already generated (INV-PROC-5)
  if (existingMeta.transcriptText) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "transcriptText already present" },
    };
  }

  // Stub transcription — real implementation would call OpenAI Whisper, Deepgram, AssemblyAI
  const mimeType = version?.mimeType ?? "audio/unknown";
  const sizeBytes = version?.sizeBytes ?? 0;
  const transcriptText = `[STUB TRANSCRIPT] Asset: ${asset.id} | Audio MIME: ${mimeType} | Size: ${sizeBytes} bytes. Audio transcription pending real transcription engine integration. Configure TRANSCRIPTION_PROVIDER env variable to enable.`;

  if (version) {
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      parsedText: transcriptText,
      transcriptText,
      transcriptionProvider: "stub",
      transcriptionCompletedAt: new Date().toISOString(),
      transcriptionModel: null,
      durationSeconds: null,
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
      metadata: { triggeredBy: job.id, transcriptionProvider: "stub" },
    });
  }

  return {
    success: true,
    nextJobType: nextJobType ?? undefined,
    outputMetadata: {
      transcriptionProvider: "stub",
      transcriptLength: transcriptText.length,
      mimeType,
    },
  };
}

// Self-register on module load
registerProcessor("transcribe_audio", transcribeAudio);
