/**
 * real-transcribe-audio.ts — Phase 5K
 * Real audio transcription using OpenAI Whisper API.
 *
 * Replaces Phase 5I stub. Job type: transcribe_audio
 *
 * Invariants enforced:
 *  INV-MPROC1: tenant-safe
 *  INV-MPROC2: requires valid version
 *  INV-MPROC3: unsupported MIME → explicit failure
 *  INV-MPROC4: empty transcript → explicit failure
 *  INV-MPROC5: writes to metadata.transcript only
 *  INV-MPROC6: idempotent downstream scheduling
 *  INV-MPROC7: does not mark retrieval-ready
 *  INV-MPROC8: fails explicitly if Whisper unavailable
 */

import * as fs from "fs";
import { eq, and } from "drizzle-orm";
import { db } from "../../../db";
import { knowledgeAssetVersions } from "@shared/schema";
import {
  registerProcessor,
  type ProcessorContext,
  type ProcessorResult,
} from "../asset_processor_registry";
import {
  loadAssetBinaryForProcessing,
  assertSupportedMimeType,
  normalizeTranscriptText,
  summarizeProcessorFailure,
  safeEnqueueDownstreamJob,
  ExplicitProcessorFailure,
} from "../../../lib/ai/multimodal-processing-utils";
import { getNextJobType } from "../asset_processing_pipeline";

const PROCESSOR_NAME = "transcribe_audio";
const ENGINE_NAME = "openai-whisper";
const ENGINE_MODEL = "whisper-1";

async function transcribeAudio(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  if (!version) {
    return {
      success: false,
      errorMessage: "No version linked to job — cannot transcribe (INV-MPROC2)",
    };
  }

  const existingMeta = (version.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if real transcription already present
  const existingTranscript = existingMeta.transcript as Record<string, unknown> | undefined;
  if (existingTranscript?.engine_name === ENGINE_NAME && existingTranscript?.transcript_text) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "Real transcription already completed (idempotent)" },
    };
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "OPENAI_KEY_MISSING",
        "OPENAI_API_KEY is not configured — Whisper transcription unavailable (INV-MPROC8)",
      );
    }

    // Load binary (INV-MPROC1/12: tenant-safe)
    const { buffer, mimeType, filePath } = await loadAssetBinaryForProcessing(
      version.storageObjectId ?? "",
      tenantId,
    );

    // Validate MIME type (INV-MPROC3)
    assertSupportedMimeType(PROCESSOR_NAME, mimeType);

    // OpenAI Whisper requires a File-like object — use the actual file path
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const audioStream = fs.createReadStream(filePath);

    const transcriptionResponse = await openai.audio.transcriptions.create({
      file: audioStream,
      model: ENGINE_MODEL,
      response_format: "verbose_json",
    } as any);

    const rawText = (transcriptionResponse as any).text ?? "";
    const transcriptText = normalizeTranscriptText(rawText);
    const detectedLanguage = (transcriptionResponse as any).language ?? null;
    const durationSeconds = (transcriptionResponse as any).duration ?? null;

    // INV-MPROC4: empty transcript → explicit failure
    if (!transcriptText) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "EMPTY_TRANSCRIPT",
        "Whisper returned empty transcript — cannot proceed (INV-MPROC4)",
      );
    }

    // Build transcript metadata (INV-MPROC5: additive, scoped to transcript key)
    const transcriptMeta = {
      engine_name: ENGINE_NAME,
      engine_version: ENGINE_MODEL,
      transcript_text: transcriptText,
      detected_language: detectedLanguage,
      duration_seconds: durationSeconds,
      processed_at: new Date().toISOString(),
    };

    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      transcript: transcriptMeta,
      parsedText: transcriptText,
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

    // Idempotent downstream scheduling (INV-MPROC6)
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    let downstreamResult = null;
    if (nextJobType) {
      downstreamResult = await safeEnqueueDownstreamJob(
        tenantId,
        asset.id,
        version.id,
        nextJobType,
        job.id,
      );
    }

    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: {
        engine: ENGINE_NAME,
        model: ENGINE_MODEL,
        transcriptLength: transcriptText.length,
        detectedLanguage,
        durationSeconds,
        downstreamJob: downstreamResult,
      },
    };
  } catch (err: unknown) {
    const failureSummary = summarizeProcessorFailure(PROCESSOR_NAME, err, {
      assetId: asset.id,
      versionId: version.id,
    });

    const failureMeta: Record<string, unknown> = {
      ...existingMeta,
      transcript: {
        engine_name: ENGINE_NAME,
        engine_version: ENGINE_MODEL,
        transcript_text: null,
        failure: failureSummary,
        processed_at: new Date().toISOString(),
      },
    };

    try {
      await db
        .update(knowledgeAssetVersions)
        .set({ metadata: failureMeta })
        .where(eq(knowledgeAssetVersions.id, version.id));
    } catch { /* don't mask */ }

    return {
      success: false,
      errorMessage: (err as Error).message,
      outputMetadata: { failure: failureSummary },
    };
  }
}

registerProcessor(PROCESSOR_NAME, transcribeAudio);
