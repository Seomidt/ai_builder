/**
 * asset_processing_pipeline.ts — Phase 5I
 * Deterministic pipeline definitions per asset type.
 *
 * Each pipeline is an ordered sequence of job types.
 * The engine executes them in order: each processor may
 * enqueue the next step.
 *
 * INV-PROC-4: pipeline order must remain deterministic.
 */

export interface PipelineDefinition {
  steps: string[];
  description: string;
}

export const ASSET_PIPELINES: Record<string, PipelineDefinition> = {
  document: {
    steps: ["parse_document", "chunk_text", "embed_text", "index_asset"],
    description: "Full document processing: parse → chunk → embed → index",
  },
  image: {
    steps: ["ocr_image", "chunk_text", "embed_text", "index_asset"],
    description: "Image OCR pipeline: ocr → chunk → embed → index",
  },
  image_with_caption: {
    steps: ["caption_image", "chunk_text", "embed_text", "index_asset"],
    description: "Image captioning pipeline: caption → chunk → embed → index",
  },
  audio: {
    steps: ["transcribe_audio", "chunk_text", "embed_text", "index_asset"],
    description: "Audio transcription pipeline: transcribe → chunk → embed → index",
  },
  // Phase 5K: video pipeline with real processors
  video: {
    steps: ["extract_video_metadata", "sample_video_frames", "index_asset"],
    description: "Video processing: metadata extraction → frame sampling → index",
  },
  webpage: {
    steps: ["parse_document", "chunk_text", "embed_text", "index_asset"],
    description: "Webpage processing (same as document): parse → chunk → embed → index",
  },
  email: {
    steps: ["parse_document", "chunk_text", "embed_text", "index_asset"],
    description: "Email processing: parse → chunk → embed → index",
  },
};

/**
 * Returns the pipeline steps for a given asset type.
 * Falls back to document pipeline if type is not explicitly mapped.
 */
export function getPipelineForAssetType(assetType: string): PipelineDefinition {
  return ASSET_PIPELINES[assetType] ?? ASSET_PIPELINES["document"];
}

/**
 * Returns the next job type in the pipeline after the given step.
 * Returns null if current step is the last one.
 */
export function getNextJobType(assetType: string, currentJobType: string): string | null {
  const pipeline = getPipelineForAssetType(assetType);
  const idx = pipeline.steps.indexOf(currentJobType);
  if (idx === -1 || idx === pipeline.steps.length - 1) return null;
  return pipeline.steps[idx + 1];
}

/**
 * Returns the first job type for a pipeline (entry point).
 */
export function getPipelineEntryJob(assetType: string): string {
  return getPipelineForAssetType(assetType).steps[0];
}

/**
 * Explain the pipeline for observability.
 */
export function explainPipeline(assetType: string): Record<string, unknown> {
  const pipeline = getPipelineForAssetType(assetType);
  return {
    assetType,
    pipeline: pipeline.description,
    stepCount: pipeline.steps.length,
    steps: pipeline.steps.map((step, idx) => ({
      position: idx + 1,
      jobType: step,
      isEntry: idx === 0,
      isFinal: idx === pipeline.steps.length - 1,
    })),
  };
}
