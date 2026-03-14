/**
 * context-window.ts — Phase 5H
 *
 * Public entry point for context window assembly.
 * Re-exports all context window utilities from context-window-builder.ts
 * so Phase 5H consumers can import from a single canonical path.
 *
 * Core responsibilities (implemented in context-window-builder.ts):
 *   - Assembles ordered, deduplicated chunk text into an LLM-ready context window
 *   - Preserves chunk ordering and document grouping
 *   - Tracks token usage against an enforced budget
 *   - Attaches full traceable metadata per chunk (INV-RET10)
 */

export {
  buildContextWindow,
  summarizeContextWindow,
  type ContextChunkMetadata,
  type ContextWindowEntry,
  type ContextWindow,
  type ContextWindowOptions,
} from "./context-window-builder";
