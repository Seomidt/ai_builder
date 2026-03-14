/**
 * real-extract-video-metadata.ts — Phase 5K
 * Real video metadata extraction using ffprobe.
 *
 * Job type: extract_video_metadata
 *
 * Invariants enforced:
 *  INV-MPROC1: tenant-safe
 *  INV-MPROC2: requires valid version
 *  INV-MPROC3: unsupported MIME → explicit failure
 *  INV-MPROC4: empty metadata → explicit failure
 *  INV-MPROC5: writes to metadata.video only
 *  INV-MPROC6: idempotent downstream scheduling
 *  INV-MPROC7: does not mark retrieval-ready
 *  INV-MPROC8: fails explicitly if ffprobe unavailable
 */

import * as child_process from "child_process";
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
  summarizeProcessorFailure,
  safeEnqueueDownstreamJob,
  ExplicitProcessorFailure,
} from "../../../lib/ai/multimodal-processing-utils";
import { getNextJobType } from "../asset_processing_pipeline";

const PROCESSOR_NAME = "extract_video_metadata";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFractionRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const parts = rate.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den === 0) return null;
    return Math.round((num / den) * 100) / 100;
  }
  return parseFloat(rate) || null;
}

async function extractVideoMetadata(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  if (!version) {
    return {
      success: false,
      errorMessage: "No version linked to job — cannot extract video metadata (INV-MPROC2)",
    };
  }

  const existingMeta = (version.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if video metadata already extracted
  const existingVideo = existingMeta.video as Record<string, unknown> | undefined;
  if (existingVideo?.duration_seconds !== undefined && existingVideo?.processed_at) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "Video metadata already extracted (idempotent)" },
    };
  }

  try {
    // Check ffprobe availability (INV-MPROC8)
    try {
      child_process.execSync("ffprobe -version 2>&1", { timeout: 5000 });
    } catch {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "FFPROBE_UNAVAILABLE",
        "ffprobe is not available in PATH — video metadata extraction unavailable (INV-MPROC8)",
      );
    }

    // Load binary (INV-MPROC1/12: tenant-safe)
    const { mimeType, filePath } = await loadAssetBinaryForProcessing(
      version.storageObjectId ?? "",
      tenantId,
    );

    // Validate MIME type (INV-MPROC3)
    assertSupportedMimeType(PROCESSOR_NAME, mimeType);

    // Run ffprobe to extract metadata
    const ffprobeCmd = `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`;
    let ffprobeOutput: string;
    try {
      ffprobeOutput = child_process.execSync(ffprobeCmd, {
        timeout: 30000,
        encoding: "utf8",
      });
    } catch (err: unknown) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "FFPROBE_EXECUTION_FAILED",
        `ffprobe execution failed: ${(err as Error).message}`,
      );
    }

    let probeData: FfprobeOutput;
    try {
      probeData = JSON.parse(ffprobeOutput);
    } catch {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "FFPROBE_PARSE_FAILED",
        "Failed to parse ffprobe JSON output",
      );
    }

    const videoStream = probeData.streams?.find((s) => s.codec_type === "video");
    const audioStream = probeData.streams?.find((s) => s.codec_type === "audio");
    const format = probeData.format;

    const durationSeconds = format?.duration ? parseFloat(format.duration) : null;

    // INV-MPROC4: explicit failure if no meaningful metadata
    if (!durationSeconds && !videoStream) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "NO_VIDEO_METADATA",
        "ffprobe returned no video stream or duration information (INV-MPROC4)",
      );
    }

    const videoMeta = {
      container_format: format?.format_name ?? null,
      duration_seconds: durationSeconds,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      video_codec: videoStream?.codec_name ?? null,
      audio_codec: audioStream?.codec_name ?? null,
      frame_rate: parseFractionRate(videoStream?.r_frame_rate),
      processed_at: new Date().toISOString(),
    };

    // INV-MPROC5: additive write to metadata.video only
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      video: videoMeta,
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
        containerFormat: videoMeta.container_format,
        durationSeconds: videoMeta.duration_seconds,
        dimensions: videoMeta.width && videoMeta.height ? `${videoMeta.width}x${videoMeta.height}` : null,
        videoCodec: videoMeta.video_codec,
        audioCodec: videoMeta.audio_codec,
        frameRate: videoMeta.frame_rate,
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
      video: {
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

registerProcessor(PROCESSOR_NAME, extractVideoMetadata);
