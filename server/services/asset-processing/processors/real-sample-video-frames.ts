/**
 * real-sample-video-frames.ts — Phase 5K
 * Real video frame sampling using ffmpeg.
 *
 * Job type: sample_video_frames
 *
 * Samples frames at deterministic intervals (every N seconds).
 * Frame descriptors saved to version metadata.
 * Frames extracted to STORAGE_LOCAL_BASE/frames/{assetId}/{versionId}/
 *
 * Invariants enforced:
 *  INV-MPROC1: tenant-safe
 *  INV-MPROC2: requires valid version
 *  INV-MPROC3: unsupported MIME → explicit failure
 *  INV-MPROC4: no frames extracted → explicit failure
 *  INV-MPROC5: writes to metadata.video_frames only
 *  INV-MPROC6: idempotent downstream scheduling
 *  INV-MPROC7: does not mark retrieval-ready
 *  INV-MPROC8: fails explicitly if ffmpeg unavailable
 */

import * as fs from "fs";
import * as path from "path";
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
  STORAGE_LOCAL_BASE,
  ExplicitProcessorFailure,
} from "../../../lib/ai/multimodal-processing-utils";
import { getNextJobType } from "../asset_processing_pipeline";

const PROCESSOR_NAME = "sample_video_frames";
const FRAME_INTERVAL_SECONDS = 10;
const MAX_FRAMES = 20;

async function sampleVideoFrames(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  if (!version) {
    return {
      success: false,
      errorMessage: "No version linked to job — cannot sample frames (INV-MPROC2)",
    };
  }

  const existingMeta = (version.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if frames already sampled
  const existingFrames = existingMeta.video_frames as Record<string, unknown> | undefined;
  if (existingFrames?.frame_count && (existingFrames.frame_count as number) > 0) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "Video frames already sampled (idempotent)" },
    };
  }

  // Temp output directory for frames
  const outputDir = path.join(STORAGE_LOCAL_BASE, "frames", asset.id, version.id);

  try {
    // Check ffmpeg availability (INV-MPROC8)
    try {
      child_process.execSync("ffmpeg -version 2>&1", { timeout: 5000 });
    } catch {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "FFMPEG_UNAVAILABLE",
        "ffmpeg is not available in PATH — frame sampling unavailable (INV-MPROC8)",
      );
    }

    // Load binary (INV-MPROC1/12)
    const { mimeType, filePath } = await loadAssetBinaryForProcessing(
      version.storageObjectId ?? "",
      tenantId,
    );

    // Validate MIME type (INV-MPROC3)
    assertSupportedMimeType(PROCESSOR_NAME, mimeType);

    // Get video duration from existing video metadata if available
    const existingVideo = existingMeta.video as Record<string, unknown> | undefined;
    const durationSeconds = existingVideo?.duration_seconds as number | null;

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Build ffmpeg command — extract frames at deterministic intervals
    // Output: frame_%04d.jpg
    const fpsFilter = `1/${FRAME_INTERVAL_SECONDS}`;
    const vFrames = durationSeconds
      ? Math.min(Math.ceil(durationSeconds / FRAME_INTERVAL_SECONDS), MAX_FRAMES)
      : MAX_FRAMES;

    const ffmpegCmd = [
      "ffmpeg",
      "-i", `"${filePath}"`,
      "-vf", `fps=${fpsFilter}`,
      "-vframes", String(vFrames),
      "-q:v", "5",
      `"${path.join(outputDir, "frame_%04d.jpg")}"`,
      "-y",
      "2>&1",
    ].join(" ");

    try {
      child_process.execSync(ffmpegCmd, { timeout: 120000, encoding: "utf8" });
    } catch (err: unknown) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "FFMPEG_EXECUTION_FAILED",
        `ffmpeg frame extraction failed: ${(err as Error).message}`,
      );
    }

    // Count extracted frames
    const extractedFiles = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir).filter((f) => f.endsWith(".jpg"))
      : [];

    // INV-MPROC4: explicit failure if no frames extracted
    if (extractedFiles.length === 0) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "NO_FRAMES_EXTRACTED",
        "ffmpeg ran but extracted no frames (INV-MPROC4)",
      );
    }

    // Build frame descriptors (metadata shape per spec)
    const sampledAtSeconds = extractedFiles.map((_, idx) =>
      Math.round(idx * FRAME_INTERVAL_SECONDS),
    );

    const videoFramesMeta = {
      sample_strategy: `every_${FRAME_INTERVAL_SECONDS}_seconds`,
      frame_count: extractedFiles.length,
      sampled_at_seconds: sampledAtSeconds,
      frame_output_dir: outputDir,
      generated_at: new Date().toISOString(),
    };

    // INV-MPROC5: additive write to metadata.video_frames only
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      video_frames: videoFramesMeta,
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
        frameCount: extractedFiles.length,
        sampleStrategy: videoFramesMeta.sample_strategy,
        outputDir,
        downstreamJob: downstreamResult,
      },
    };
  } catch (err: unknown) {
    const failureSummary = summarizeProcessorFailure(PROCESSOR_NAME, err, {
      assetId: asset.id,
      versionId: version.id,
    });

    // INV-MPROC5: additive failure metadata in video_frames key only
    const failureMeta: Record<string, unknown> = {
      ...existingMeta,
      video_frames: {
        failure: failureSummary,
        generated_at: new Date().toISOString(),
      },
    };

    try {
      await db
        .update(knowledgeAssetVersions)
        .set({ metadata: failureMeta })
        .where(eq(knowledgeAssetVersions.id, version.id));
    } catch { /* don't mask */ }

    // Cleanup partial output directory
    try {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    } catch { /* cleanup failure is non-fatal */ }

    return {
      success: false,
      errorMessage: (err as Error).message,
      outputMetadata: { failure: failureSummary },
    };
  }
}

registerProcessor(PROCESSOR_NAME, sampleVideoFrames);
