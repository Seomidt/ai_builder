/**
 * asset_processor_registry.ts — Phase 5I
 * Asset Processor Registry
 *
 * Maps job types to processor implementations.
 * Processors self-register on load via registerProcessor().
 *
 * If a job type has no registered processor, getProcessor() throws
 * a safe ProcessorNotFoundError.
 */

import type { KnowledgeAssetProcessingJob } from "@shared/schema";
import type { KnowledgeAsset, KnowledgeAssetVersion } from "@shared/schema";

// ─── Processor context ─────────────────────────────────────────────────────────

export interface ProcessorContext {
  job: KnowledgeAssetProcessingJob;
  asset: KnowledgeAsset;
  version: KnowledgeAssetVersion | null;
  tenantId: string;
}

export interface ProcessorResult {
  success: boolean;
  nextJobType?: string;
  outputMetadata?: Record<string, unknown>;
  errorMessage?: string;
}

export type AssetProcessor = (ctx: ProcessorContext) => Promise<ProcessorResult>;

// ─── Registry ─────────────────────────────────────────────────────────────────

export class ProcessorNotFoundError extends Error {
  constructor(jobType: string) {
    super(`No processor registered for job type: ${jobType}`);
    this.name = "ProcessorNotFoundError";
  }
}

const registry = new Map<string, AssetProcessor>();

export function registerProcessor(jobType: string, processor: AssetProcessor): void {
  registry.set(jobType, processor);
}

export function getProcessor(jobType: string): AssetProcessor {
  const processor = registry.get(jobType);
  if (!processor) {
    throw new ProcessorNotFoundError(jobType);
  }
  return processor;
}

export function listRegisteredProcessors(): string[] {
  return Array.from(registry.keys()).sort();
}

export function hasProcessor(jobType: string): boolean {
  return registry.has(jobType);
}

/**
 * Load all processors — triggers self-registration via side effects.
 * Call once at application startup or before dispatching.
 *
 * Phase 5K: real processors are loaded AFTER stubs to ensure they
 * override stub registrations for the same job types.
 * Stub files remain for reference but are superseded by real processors.
 */
export async function loadAllProcessors(): Promise<void> {
  // Core pipeline processors (stubs — stable, no replacement needed)
  await import("./processors/parse_document");
  await import("./processors/chunk_text");
  await import("./processors/embed_text");
  await import("./processors/index_asset");

  // Phase 5K: real multimodal processors (override Phase 5I stubs)
  // Import real processors — they self-register, overriding any stub registration
  await import("./processors/real-ocr-image");
  await import("./processors/real-caption-image");
  await import("./processors/real-transcribe-audio");
  await import("./processors/real-extract-video-metadata");
  await import("./processors/real-sample-video-frames");
}

/**
 * Load stub processors only — for testing / fallback environments.
 * Do NOT call this in production alongside loadAllProcessors().
 */
export async function loadStubProcessors(): Promise<void> {
  await import("./processors/parse_document");
  await import("./processors/chunk_text");
  await import("./processors/embed_text");
  await import("./processors/index_asset");
  await import("./processors/ocr_image");
  await import("./processors/caption_image");
  await import("./processors/transcribe_audio");
}
