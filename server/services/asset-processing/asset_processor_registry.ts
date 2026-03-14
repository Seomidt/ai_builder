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
 */
export async function loadAllProcessors(): Promise<void> {
  await import("./processors/parse_document");
  await import("./processors/chunk_text");
  await import("./processors/embed_text");
  await import("./processors/index_asset");
  await import("./processors/ocr_image");
  await import("./processors/caption_image");
  await import("./processors/transcribe_audio");
}
