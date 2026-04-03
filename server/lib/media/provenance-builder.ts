/**
 * Phase 5Z.1 — Provenance Builder
 *
 * Builds deterministic chunk keys and provenance metadata so that:
 *  - Chunks can be traced through job → document version → chunk lineage.
 *  - Superseded chunks can be found and deactivated with precision.
 *  - Future citation rendering has reliable source offsets.
 *
 * INV-PROV1: chunkKey is deterministic for (docVersionId, chunkIndex, strategy, version).
 * INV-PROV2: chunkHash is a deterministic fingerprint of chunk text.
 * INV-PROV3: All provenance fields are tenant-scoped — no cross-tenant leakage.
 */

import { createHash } from "node:crypto";
import type { ChunkSpan } from "./retrieval-chunker.ts";

// ── Chunk provenance record ────────────────────────────────────────────────────

export interface ChunkProvenance {
  tenantId:                string;
  knowledgeBaseId:         string;
  knowledgeDocumentId:     string;
  knowledgeDocumentVersionId: string;
  jobId:                   string;
  chunkIndex:              number;
  chunkKey:                string;
  chunkHash:               string;
  chunkStrategy:           string;
  chunkVersion:            string;
  characterStart:          number;
  characterEnd:            number;
  tokenEstimate:           number;
  overlapCharacters:       number;
  sourcePageStart?:        number;
  sourcePageEnd?:          number;
  sourceHeadingPath?:      string;
  sourceSectionLabel?:     string;
}

// ── buildChunkKey ──────────────────────────────────────────────────────────────
// Deterministic string key identifying a logical chunk position in a version.
// INV-PROV1: same inputs → same key.

export function buildChunkKey(params: {
  documentVersionId: string;
  chunkIndex:        number;
  strategy:          string;
  version:           string;
}): string {
  return [
    params.documentVersionId,
    params.strategy,
    params.version,
    String(params.chunkIndex),
  ].join(":");
}

// ── buildChunkHash ─────────────────────────────────────────────────────────────
// SHA-256 fingerprint of normalised chunk text.
// INV-PROV2: same text → same hash (case/whitespace preserved as-is).

export function buildChunkHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── buildChunkProvenance ───────────────────────────────────────────────────────
// Construct the full provenance record for a ChunkSpan.

export function buildChunkProvenance(params: {
  tenantId:                string;
  knowledgeBaseId:         string;
  knowledgeDocumentId:     string;
  knowledgeDocumentVersionId: string;
  jobId:                   string;
  span:                    ChunkSpan;
  strategy:                string;
  version:                 string;
  sourcePageStart?:        number;
  sourcePageEnd?:          number;
  sourceHeadingPath?:      string;
  sourceSectionLabel?:     string;
}): ChunkProvenance {
  const {
    tenantId, knowledgeBaseId, knowledgeDocumentId,
    knowledgeDocumentVersionId, jobId, span,
    strategy, version,
    sourcePageStart, sourcePageEnd,
    sourceHeadingPath, sourceSectionLabel,
  } = params;

  const chunkKey  = buildChunkKey({ documentVersionId: knowledgeDocumentVersionId, chunkIndex: span.chunkIndex, strategy, version });
  const chunkHash = buildChunkHash(span.text);

  return {
    tenantId,
    knowledgeBaseId,
    knowledgeDocumentId,
    knowledgeDocumentVersionId,
    jobId,
    chunkIndex:           span.chunkIndex,
    chunkKey,
    chunkHash,
    chunkStrategy:        strategy,
    chunkVersion:         version,
    characterStart:       span.characterStart,
    characterEnd:         span.characterEnd,
    tokenEstimate:        span.tokenEstimate,
    overlapCharacters:    span.overlapCharacters,
    sourcePageStart,
    sourcePageEnd,
    sourceHeadingPath,
    sourceSectionLabel,
  };
}

// ── buildSupersessionWhere ─────────────────────────────────────────────────────
// Returns the SQL fragment needed to find chunks that should be superseded
// when a new chunking run completes for a given document version.
//
// Usage: all active chunks for this (tenantId, docVersionId, strategy, version)
// that do NOT belong to the current jobId should be deactivated.

export function buildSupersessionParams(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
  currentJobId:            string;
  strategy:                string;
  version:                 string;
}): {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
  currentJobId:            string;
  strategy:                string;
  version:                 string;
} {
  return { ...params };
}
