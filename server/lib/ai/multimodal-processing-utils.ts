/**
 * multimodal-processing-utils.ts — Phase 5K
 * Shared utilities for real multimodal processors.
 *
 * Provides:
 *  - loadAssetBinaryForProcessing()  — load raw bytes for a storage object
 *  - assertSupportedMimeType()       — explicit failure on unsupported MIME
 *  - normalizeExtractedText()        — trim + collapse whitespace
 *  - normalizeCaptionText()          — trim + collapse whitespace
 *  - normalizeTranscriptText()       — trim + collapse whitespace
 *  - summarizeProcessorFailure()     — structured failure summary
 *  - safeEnqueueDownstreamJob()      — idempotent downstream scheduling (INV-MPROC6)
 *  - explainProcessingEnvironmentCapabilities() — truthful capability detection (INV-MPROC8)
 *
 * Storage backend:
 *   Only 'local' provider is currently supported for binary reading.
 *   Files are expected at: {STORAGE_LOCAL_BASE}/{bucketName}/{objectKey}
 *   Default STORAGE_LOCAL_BASE=/tmp/asset-storage
 *
 *   Other providers (r2, s3, supabase) will fail explicitly.
 */

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  assetStorageObjects,
  knowledgeAssetProcessingJobs,
  type AssetStorageObject,
} from "@shared/schema";
import { enqueueAssetProcessingJob } from "./knowledge-asset-processing";

// ─── Constants ─────────────────────────────────────────────────────────────────

export const STORAGE_LOCAL_BASE = process.env.STORAGE_LOCAL_BASE ?? "/tmp/asset-storage";

export const SUPPORTED_MIME_TYPES: Record<string, string[]> = {
  ocr_image: ["image/jpeg", "image/png", "image/webp", "image/tiff"],
  caption_image: ["image/jpeg", "image/png", "image/webp"],
  transcribe_audio: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg"],
  extract_video_metadata: ["video/mp4", "video/quicktime", "video/webm", "video/avi"],
  sample_video_frames: ["video/mp4", "video/quicktime", "video/webm", "video/avi"],
};

// ─── ExplicitProcessorFailure ─────────────────────────────────────────────────

export class ExplicitProcessorFailure extends Error {
  readonly processorName: string;
  readonly failureCode: string;

  constructor(processorName: string, failureCode: string, message: string) {
    super(message);
    this.name = "ExplicitProcessorFailure";
    this.processorName = processorName;
    this.failureCode = failureCode;
  }
}

// ─── loadAssetBinaryForProcessing ─────────────────────────────────────────────

/**
 * Load the binary content of a storage object as a Buffer.
 *
 * Only 'local' storage provider is supported — others fail explicitly.
 * Validates tenant ownership before returning content (INV-MPROC12).
 */
export async function loadAssetBinaryForProcessing(
  storageObjectId: string,
  tenantId: string,
): Promise<{ buffer: Buffer; mimeType: string; filePath: string; storageObject: AssetStorageObject }> {
  if (!storageObjectId) {
    throw new ExplicitProcessorFailure("storage", "NO_STORAGE_OBJECT", "No storage object linked to this version");
  }

  const [obj] = await db
    .select()
    .from(assetStorageObjects)
    .where(
      and(
        eq(assetStorageObjects.id, storageObjectId),
        eq(assetStorageObjects.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!obj) {
    throw new ExplicitProcessorFailure(
      "storage",
      "STORAGE_OBJECT_NOT_FOUND",
      `Storage object ${storageObjectId} not found for tenant ${tenantId} (INV-MPROC12)`,
    );
  }

  if (obj.storageClass === "deleted" || obj.deletedAt) {
    throw new ExplicitProcessorFailure(
      "storage",
      "STORAGE_OBJECT_DELETED",
      `Storage object ${storageObjectId} is deleted — cannot load binary`,
    );
  }

  if (obj.storageProvider !== "local") {
    throw new ExplicitProcessorFailure(
      "storage",
      "UNSUPPORTED_STORAGE_PROVIDER",
      `Storage provider '${obj.storageProvider}' is not yet supported for binary loading. Supported: local`,
    );
  }

  const filePath = path.join(STORAGE_LOCAL_BASE, obj.bucketName, obj.objectKey);

  if (!fs.existsSync(filePath)) {
    throw new ExplicitProcessorFailure(
      "storage",
      "FILE_NOT_FOUND",
      `Binary file not found at ${filePath}. Ensure STORAGE_LOCAL_BASE is correctly configured.`,
    );
  }

  const buffer = fs.readFileSync(filePath);

  return {
    buffer,
    mimeType: obj.mimeType ?? "application/octet-stream",
    filePath,
    storageObject: obj,
  };
}

// ─── assertSupportedMimeType ──────────────────────────────────────────────────

/**
 * Throw ExplicitProcessorFailure if mimeType is not supported for this processor.
 * INV-MPROC3: unsupported MIME types must fail explicitly.
 */
export function assertSupportedMimeType(
  processorName: string,
  mimeType: string,
): void {
  const allowed = SUPPORTED_MIME_TYPES[processorName] ?? [];
  if (!allowed.includes(mimeType)) {
    throw new ExplicitProcessorFailure(
      processorName,
      "UNSUPPORTED_MIME_TYPE",
      `MIME type '${mimeType}' is not supported for ${processorName}. Supported: ${allowed.join(", ")}`,
    );
  }
}

// ─── Text normalization helpers ───────────────────────────────────────────────

export function normalizeExtractedText(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().replace(/\s+/g, " ").replace(/\n{3,}/g, "\n\n");
}

export function normalizeCaptionText(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().replace(/\s+/g, " ");
}

export function normalizeTranscriptText(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ─── summarizeProcessorFailure ────────────────────────────────────────────────

export function summarizeProcessorFailure(
  processorName: string,
  error: unknown,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  const err = error as Error;
  const isExplicit = err instanceof ExplicitProcessorFailure;

  return {
    processorName,
    failureCode: isExplicit ? (err as ExplicitProcessorFailure).failureCode : "UNEXPECTED_ERROR",
    errorMessage: err.message,
    isExplicit,
    failedAt: new Date().toISOString(),
    context,
  };
}

// ─── safeEnqueueDownstreamJob ─────────────────────────────────────────────────

/**
 * Idempotently enqueue a downstream job.
 * Checks if a non-failed/non-cancelled job for this type+version already exists.
 * If it does, skips enqueueing.
 * INV-MPROC6: downstream job enqueueing must be idempotent.
 */
export async function safeEnqueueDownstreamJob(
  tenantId: string,
  assetId: string,
  assetVersionId: string | null,
  jobType: string,
  triggeredByJobId: string,
): Promise<{ enqueued: boolean; existingJobId?: string; newJobId?: string }> {
  // Check for existing active (queued/started/completed) job of this type for this version
  const existing = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
        eq(knowledgeAssetProcessingJobs.assetId, assetId),
        eq(knowledgeAssetProcessingJobs.jobType, jobType),
      ),
    )
    .limit(20);

  // Check if any non-failed, non-cancelled job already exists for this version
  const activeForVersion = existing.filter(
    (j) =>
      (!assetVersionId || j.assetVersionId === assetVersionId) &&
      !["failed", "cancelled", "skipped"].includes(j.jobStatus),
  );

  if (activeForVersion.length > 0) {
    return { enqueued: false, existingJobId: activeForVersion[0].id };
  }

  const job = await enqueueAssetProcessingJob({
    tenantId,
    assetId,
    assetVersionId: assetVersionId ?? null,
    jobType,
    metadata: {
      triggeredBy: triggeredByJobId,
      enqueuedBy: "multimodal-processor",
    },
  });

  return { enqueued: true, newJobId: job.id };
}

// ─── explainProcessingEnvironmentCapabilities ────────────────────────────────

export interface EnvironmentCapabilities {
  openai: {
    available: boolean;
    apiKeyConfigured: boolean;
    visionSupported: boolean;
    whisperSupported: boolean;
    details: string;
  };
  ffprobe: {
    available: boolean;
    version: string | null;
    details: string;
  };
  ffmpeg: {
    available: boolean;
    version: string | null;
    details: string;
  };
  localStorage: {
    basePath: string;
    basePathExists: boolean;
    details: string;
  };
  summary: {
    ocrCapable: boolean;
    transcriptionCapable: boolean;
    captionCapable: boolean;
    videoMetadataCapable: boolean;
    frameSamplingCapable: boolean;
  };
}

/**
 * Truthfully detect what processing capabilities are available.
 * INV-MPROC8: must NOT fake available capabilities.
 */
export function explainProcessingEnvironmentCapabilities(): EnvironmentCapabilities {
  // OpenAI capability — check by filesystem (avoid require() ESM incompatibility)
  const apiKeyConfigured = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10;
  let openaiAvailable = false;
  let openaiDetails = "Not tested";
  const openaiPackagePath = path.join(process.cwd(), "node_modules", "openai");
  const openaiPackageExists = fs.existsSync(openaiPackagePath);
  openaiAvailable = openaiPackageExists && apiKeyConfigured;
  if (openaiPackageExists) {
    openaiDetails = apiKeyConfigured
      ? "openai package present, OPENAI_API_KEY configured"
      : "openai package present but OPENAI_API_KEY not configured";
  } else {
    openaiDetails = "openai package not found in node_modules";
  }

  // ffprobe capability
  let ffprobeAvailable = false;
  let ffprobeVersion: string | null = null;
  let ffprobeDetails = "Not found";
  try {
    const result = child_process.execSync("ffprobe -version 2>&1", {
      timeout: 5000,
      encoding: "utf8",
    });
    ffprobeAvailable = true;
    const match = result.match(/ffprobe version ([\d.]+)/);
    ffprobeVersion = match ? match[1] : "unknown";
    ffprobeDetails = `Available: version ${ffprobeVersion}`;
  } catch {
    ffprobeDetails = "ffprobe not found in PATH";
  }

  // ffmpeg capability
  let ffmpegAvailable = false;
  let ffmpegVersion: string | null = null;
  let ffmpegDetails = "Not found";
  try {
    const result = child_process.execSync("ffmpeg -version 2>&1", {
      timeout: 5000,
      encoding: "utf8",
    });
    ffmpegAvailable = true;
    const match = result.match(/ffmpeg version ([\d.]+)/);
    ffmpegVersion = match ? match[1] : "unknown";
    ffmpegDetails = `Available: version ${ffmpegVersion}`;
  } catch {
    ffmpegDetails = "ffmpeg not found in PATH";
  }

  // Local storage capability
  const basePathExists = fs.existsSync(STORAGE_LOCAL_BASE);
  const localStorageDetails = basePathExists
    ? `Base path exists: ${STORAGE_LOCAL_BASE}`
    : `Base path does not exist: ${STORAGE_LOCAL_BASE} (create with mkdir -p)`;

  return {
    openai: {
      available: openaiAvailable,
      apiKeyConfigured,
      visionSupported: openaiAvailable,
      whisperSupported: openaiAvailable,
      details: openaiDetails,
    },
    ffprobe: {
      available: ffprobeAvailable,
      version: ffprobeVersion,
      details: ffprobeDetails,
    },
    ffmpeg: {
      available: ffmpegAvailable,
      version: ffmpegVersion,
      details: ffmpegDetails,
    },
    localStorage: {
      basePath: STORAGE_LOCAL_BASE,
      basePathExists,
      details: localStorageDetails,
    },
    summary: {
      ocrCapable: openaiAvailable,
      transcriptionCapable: openaiAvailable,
      captionCapable: openaiAvailable,
      videoMetadataCapable: ffprobeAvailable,
      frameSamplingCapable: ffmpegAvailable,
    },
  };
}
