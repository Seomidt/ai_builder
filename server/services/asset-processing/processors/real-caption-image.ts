/**
 * real-caption-image.ts — Phase 5K
 * Real image captioning using OpenAI vision API (GPT-4o).
 *
 * Replaces Phase 5I stub. Job type: caption_image
 *
 * Invariants enforced:
 *  INV-MPROC1: tenant-safe
 *  INV-MPROC2: requires valid version
 *  INV-MPROC3: unsupported MIME → explicit failure
 *  INV-MPROC4: empty caption → explicit failure
 *  INV-MPROC5: writes to metadata.caption only (does NOT overwrite OCR)
 *  INV-MPROC6: idempotent downstream scheduling
 *  INV-MPROC7: does not mark retrieval-ready
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
  normalizeCaptionText,
  summarizeProcessorFailure,
  safeEnqueueDownstreamJob,
  ExplicitProcessorFailure,
} from "../../../lib/ai/multimodal-processing-utils";
import { getNextJobType } from "../asset_processing_pipeline";

const PROCESSOR_NAME = "caption_image";
const ENGINE_NAME = "openai-vision";
const ENGINE_MODEL = "gpt-4o";

async function captionImage(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { job, asset, version, tenantId } = ctx;

  if (!version) {
    return {
      success: false,
      errorMessage: "No version linked to job — cannot generate caption (INV-MPROC2)",
    };
  }

  const existingMeta = (version.metadata ?? {}) as Record<string, unknown>;

  // Idempotency: skip if real caption already present
  const existingCaption = existingMeta.caption as Record<string, unknown> | undefined;
  if (existingCaption?.engine_name === ENGINE_NAME && existingCaption?.caption_text) {
    const nextJobType = getNextJobType(asset.assetType, job.jobType);
    return {
      success: true,
      nextJobType: nextJobType ?? undefined,
      outputMetadata: { skippedReason: "Real caption already completed (idempotent)" },
    };
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "OPENAI_KEY_MISSING",
        "OPENAI_API_KEY is not configured — image captioning unavailable (INV-MPROC8)",
      );
    }

    // Load binary (INV-MPROC1/12)
    const { buffer, mimeType } = await loadAssetBinaryForProcessing(
      version.storageObjectId ?? "",
      tenantId,
    );

    // Validate MIME type (INV-MPROC3)
    assertSupportedMimeType(PROCESSOR_NAME, mimeType);

    const base64Image = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
              text: "Provide a detailed, accurate description of this image. Describe what you see: subjects, objects, setting, colors, text visible, and any notable visual elements. Be specific and comprehensive.",
            },
          ],
        },
      ],
      max_tokens: 1024,
    });

    const rawCaption = response.choices[0]?.message?.content ?? "";
    const captionText = normalizeCaptionText(rawCaption);

    // INV-MPROC4: explicit failure on empty caption
    if (!captionText) {
      throw new ExplicitProcessorFailure(
        PROCESSOR_NAME,
        "EMPTY_CAPTION",
        "Vision model returned empty caption (INV-MPROC4)",
      );
    }

    // INV-MPROC5: additive write to metadata.caption only — does NOT overwrite metadata.ocr
    const captionMeta = {
      engine_name: ENGINE_NAME,
      engine_version: ENGINE_MODEL,
      caption_text: captionText,
      labels: [],
      processed_at: new Date().toISOString(),
    };

    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      caption: captionMeta,
    };

    // Only set parsedText if OCR hasn't already set it
    if (!existingMeta.parsedText) {
      updatedMeta.parsedText = captionText;
    }

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
        captionLength: captionText.length,
        downstreamJob: downstreamResult,
      },
    };
  } catch (err: unknown) {
    const failureSummary = summarizeProcessorFailure(PROCESSOR_NAME, err, {
      assetId: asset.id,
      versionId: version.id,
    });

    // INV-MPROC5: additive failure metadata in caption key only
    const failureMeta: Record<string, unknown> = {
      ...existingMeta,
      caption: {
        engine_name: ENGINE_NAME,
        engine_version: ENGINE_MODEL,
        caption_text: null,
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

registerProcessor(PROCESSOR_NAME, captionImage);
