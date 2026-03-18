/**
 * real-ocr-image.ts — Phase 5K
 * Real OCR processor using OpenAI vision API.
 *
 * Replaces the Phase 5I stub implementation.
 * Job type: ocr_image
 *
 * Invariants:
 *  INV-MPROC1: tenant-safe (storage loaded with tenantId)
 *  INV-MPROC2: validates asset version exists
 *  INV-MPROC3: unsupported MIME types fail explicitly
 *  INV-MPROC4: empty OCR text results in explicit failure
 *  INV-MPROC5: writes to metadata.ocr only (additive)
 *  INV-MPROC6: downstream job enqueue is idempotent
 *  INV-MPROC7: does NOT mark retrieval-ready
 *  INV-MPROC8: fails explicitly if OpenAI unavailable
 */

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
  normalizeExtractedText,
  summarizeProcessorFailure,
  safeEnqueueDownstreamJob,
  ExplicitProcessorFailure,
} from "../../../lib/ai/multimodal-processing-utils";
import { getNextJobType } from "../asset_processing_pipeline";

const PROCESSOR_NAME = "ocr_image";
const ENGINE_NAME = "openai-vision";
const ENGINE_MODEL = "gpt-4o";

async function runOcr(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  if (!version) {
    return {
      success: false,
      errorMessage: "No version linked to job — cannot run OCR (INV-MPROC2)",
    };
  }

  const existingMeta = (version.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if OCR already completed with real engine
  const existingOcr = existingMeta.ocr as Record<string, unknown> | undefined;
  if (existingOcr?.engine_name === ENGINE_NAME && existingOcr?.extracted_text) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "Real OCR already completed (idempotent)" },
    };
  }

  let failureSummary: Record<string, unknown> | null = null;

  try {
    // Load binary content (INV-MPROC1/12: tenant-safe)
    const { buffer, mimeType } = await loadAssetBinaryForProcessing(
      version.storageObjectId ?? "",
      tenantId,
    );

    // Validate MIME type (INV-MPROC3)
    assertSupportedMimeType(PROCESSOR_NAME, mimeType);

    // Encode to base64 for OpenAI vision API
    const base64Image = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    // Call OpenAI vision API
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    if (!process.env.OPENAI_API_KEY) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "OPENAI_KEY_MISSING",
        "OPENAI_API_KEY is not configured — OCR unavailable (INV-MPROC8)",
      );
    }

    const response = await openai.chat.completions.create({
      model: ENGINE_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl, detail: "high" },
            },
            {
              type: "text",
              text: "Extract ALL text from this image verbatim. Return only the extracted text content with no additional commentary. If the image contains no readable text, respond with exactly: [NO_TEXT_FOUND]",
            },
          ],
        },
      ],
      max_tokens: 4096,
    });

    const rawText = response.choices[0]?.message?.content ?? "";
    const extractedText = normalizeExtractedText(rawText);

    // INV-MPROC4: explicit failure if no text extracted
    if (!extractedText || extractedText === "[NO_TEXT_FOUND]") {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "NO_TEXT_EXTRACTED",
        "OCR completed but no text was found in the image (INV-MPROC4)",
      );
    }

    // Build OCR metadata (INV-MPROC5: only write to metadata.ocr)
    const ocrMeta = {
      engine_name: ENGINE_NAME,
      engine_version: ENGINE_MODEL,
      extracted_text: extractedText,
      average_confidence: null,
      block_count: null,
      processed_at: new Date().toISOString(),
    };

    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      ocr: ocrMeta,
      parsedText: extractedText,
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

    // Idempotent downstream job enqueue (INV-MPROC6)
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    let downstreamResult: { enqueued: boolean; existingJobId?: string; newJobId?: string } | null = null;
    if (nextJobType && extractedText) {
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
        extractedTextLength: extractedText.length,
        downstreamJob: downstreamResult,
      },
    };
  } catch (err: unknown) {
    failureSummary = summarizeProcessorFailure(PROCESSOR_NAME, err, {
      assetId: asset.id,
      versionId: version.id,
      tenantId,
    });

    // Write failure metadata (INV-MPROC5: additive)
    const failureMeta: Record<string, unknown> = {
      ...existingMeta,
      ocr: {
        engine_name: ENGINE_NAME,
        engine_version: ENGINE_MODEL,
        extracted_text: null,
        failure: failureSummary,
        processed_at: new Date().toISOString(),
      },
    };

    try {
      await db
        .update(knowledgeAssetVersions)
        .set({ metadata: failureMeta })
        .where(eq(knowledgeAssetVersions.id, version.id));
    } catch {
      // Don't mask original error
    }

    return {
      success: false,
      errorMessage: (err as Error).message,
      outputMetadata: { failure: failureSummary },
    };
  }
}

registerProcessor(PROCESSOR_NAME, runOcr);
