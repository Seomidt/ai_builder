/**
 * retrieval-provenance.ts — Phase 5M
 *
 * Canonical retrieval provenance and explainability model.
 *
 * Connects the full chain:
 *   retrieval_run → candidate → chunk → asset_version → asset
 *
 * INV-PROV1: All provenance records are tenant-safe
 * INV-PROV2: Every selected context entry is traceable to asset + version + source type
 * INV-PROV3: Exclusion reasons are explicit
 * INV-PROV4: Inclusion reasons are explicit
 * INV-PROV5: Ranking/dedup/token decisions are explainable
 * INV-PROV6: All functions in this module perform NO writes
 * INV-PROV7: Multimodal source distinctions are preserved
 * INV-PROV8: No cross-tenant lineage
 * INV-PROV9: Retrieval results remain deterministic
 * INV-PROV10: Trust-signal semantics from 5F remain intact
 * INV-PROV11: Embedding lifecycle semantics from 5L remain intact
 * INV-PROV12: Context-window provenance matches final selected entries exactly
 */

import { db } from "../../db";
import {
  knowledgeRetrievalRuns,
  knowledgeRetrievalCandidates,
  knowledgeChunks,
  knowledgeAssets,
  knowledgeAssetVersions,
  knowledgeAssetEmbeddings,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

// ── Reason code registry ──────────────────────────────────────────────────────

export const EXCLUSION_REASONS = {
  TENANT_MISMATCH: "tenant_mismatch",
  KNOWLEDGE_BASE_MISMATCH: "knowledge_base_mismatch",
  INACTIVE_CHUNK: "inactive_chunk",
  NON_CURRENT_VERSION: "non_current_version",
  INDEX_NOT_READY: "index_not_ready",
  SIMILARITY_BELOW_THRESHOLD: "similarity_below_threshold",
  DUPLICATE_CHUNK: "duplicate_chunk",
  DUPLICATE_DOCUMENT_LIMIT: "duplicate_document_limit",
  TOKEN_BUDGET_EXCEEDED: "token_budget_exceeded",
  STALE_EMBEDDING: "stale_embedding",
  LIFECYCLE_EXCLUDED: "lifecycle_excluded",
  TRUST_POLICY_EXCLUDED: "trust_policy_excluded",
  // Phase 5N — Hybrid search exclusion reasons (INV-HYB3/4)
  LEXICAL_BELOW_THRESHOLD: "lexical_below_threshold",
  FUSED_BELOW_THRESHOLD: "fused_below_threshold",
  RERANK_BELOW_CUTOFF: "rerank_below_cutoff",
  LEXICAL_DUPLICATE: "lexical_duplicate",
  VECTOR_DUPLICATE: "vector_duplicate",
  // Phase 5O — Advanced reranking exclusion reasons (INV-RER4/5)
  NOT_IN_RERANK_SHORTLIST: "not_in_rerank_shortlist",
  RERANK_SCORE_BELOW_CUTOFF: "rerank_below_cutoff",
  RERANK_TIMEOUT_FALLBACK: "rerank_timeout_fallback",
  RERANK_PROVIDER_FAILURE: "rerank_provider_failure",
  TOKEN_BUDGET_EXCEEDED_AFTER_RERANK: "token_budget_exceeded_after_rerank",
  DUPLICATE_DOCUMENT_LIMIT_AFTER_RERANK: "duplicate_document_limit_after_rerank",
} as const;

export const INCLUSION_REASONS = {
  PASSED_SCOPE_FILTERS: "passed_scope_filters",
  PASSED_SIMILARITY_THRESHOLD: "passed_similarity_threshold",
  SURVIVED_DEDUP: "survived_dedup",
  RANKED_IN_TOP_SET: "ranked_in_top_set",
  INCLUDED_IN_CONTEXT_BUDGET: "included_in_context_budget",
  SELECTED_FOR_SOURCE_DIVERSITY: "selected_for_source_diversity",
  SELECTED_FOR_DOCUMENT_COVERAGE: "selected_for_document_coverage",
  // Phase 5N — Hybrid channel inclusion reasons (INV-HYB4)
  SELECTED_BY_VECTOR_CHANNEL: "selected_by_vector_channel",
  SELECTED_BY_LEXICAL_CHANNEL: "selected_by_lexical_channel",
  SELECTED_BY_BOTH_CHANNELS: "selected_by_both_channels",
  PROMOTED_BY_FUSION: "promoted_by_fusion",
  PROMOTED_BY_RERANK: "promoted_by_rerank",
  // Phase 5O — Advanced reranking inclusion reasons (INV-RER4/5)
  INCLUDED_IN_RERANK_SHORTLIST: "included_in_rerank_shortlist",
  PROMOTED_BY_ADVANCED_RERANK: "promoted_by_advanced_rerank",
  RETAINED_BY_ADVANCED_RERANK: "retained_by_advanced_rerank",
  RETAINED_BY_FALLBACK_RERANK: "retained_by_fallback_rerank",
  INCLUDED_IN_FINAL_CONTEXT_AFTER_RERANK: "included_in_final_context_after_rerank",
} as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[keyof typeof EXCLUSION_REASONS];
export type InclusionReason = (typeof INCLUSION_REASONS)[keyof typeof INCLUSION_REASONS];

// ── Source type derivation from chunk flags ───────────────────────────────────

export function deriveChunkSourceType(chunkRow: {
  imageChunk?: boolean | null;
  transcriptChunk?: boolean | null;
  tableChunk?: boolean | null;
  emailChunk?: boolean | null;
  htmlChunk?: boolean | null;
}): string {
  if (chunkRow.transcriptChunk) return "transcript_text";
  if (chunkRow.imageChunk) return "ocr_text";
  if (chunkRow.emailChunk) return "imported_text";
  if (chunkRow.htmlChunk) return "parsed_text";
  if (chunkRow.tableChunk) return "parsed_text";
  return "parsed_text";
}

// ── Retrieval run fetch helper ────────────────────────────────────────────────

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(knowledgeRetrievalRuns)
    .where(eq(knowledgeRetrievalRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

// ── TASK 2: Build provenance for a run (INV-PROV6: no writes) ─────────────────

export async function buildRetrievalProvenanceForRun(runId: string): Promise<{
  runId: string;
  tenantId: string;
  knowledgeBaseId: string;
  totalCandidates: number;
  selectedCount: number;
  excludedCount: number;
  candidates: Array<{
    candidateId: string;
    chunkId: string | null;
    filterStatus: string;
    exclusionReason: string | null;
    inclusionReason: string | null;
    similarityScore: string | null;
    candidateRank: number | null;
    finalRank: number | null;
    sourceType: string | null;
    assetId: string | null;
    assetVersionId: string | null;
    tokenCountEstimate: number | null;
  }>;
  provenanceNote: string;
}> {
  const run = await getRunById(runId);
  if (!run) throw new Error(`Retrieval run not found: ${runId}`);

  const candidates = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const selected = candidates.filter((c) => c.filterStatus === "selected");
  const excluded = candidates.filter((c) => c.filterStatus === "excluded");

  const provenanceNote =
    candidates.length === 0
      ? "No candidate records found for this run — candidates are persisted only when persistRun=true was set during retrieval"
      : `${candidates.length} candidate records found`;

  return {
    runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    totalCandidates: candidates.length,
    selectedCount: selected.length,
    excludedCount: excluded.length,
    candidates: candidates.map((c) => ({
      candidateId: c.id,
      chunkId: c.chunkId ?? null,
      filterStatus: c.filterStatus,
      exclusionReason: c.exclusionReason ?? null,
      inclusionReason: c.inclusionReason ?? null,
      similarityScore: c.similarityScore ?? null,
      candidateRank: c.candidateRank ?? null,
      finalRank: c.finalRank ?? null,
      sourceType: c.sourceType ?? null,
      assetId: c.knowledgeAssetId ?? null,
      assetVersionId: c.knowledgeAssetVersionId ?? null,
      tokenCountEstimate: c.tokenCountEstimate ?? null,
    })),
    provenanceNote,
  };
}

// ── TASK 2: Build chunk provenance (INV-PROV6: no writes) ────────────────────

export async function buildChunkProvenance(chunkId: string): Promise<{
  chunkId: string;
  tenantId: string | null;
  documentId: string | null;
  documentVersionId: string | null;
  knowledgeBaseId: string | null;
  chunkText: string | null;
  chunkKey: string;
  chunkIndex: number;
  sourceType: string;
  isActive: boolean;
  imageChunk: boolean;
  transcriptChunk: boolean;
  tableChunk: boolean;
  ocr_confidence: string | null;
  assetVersionLink: string | null;
  note: string;
}> {
  const chunkRows = await db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.id, chunkId))
    .limit(1);

  if (!chunkRows.length) throw new Error(`Chunk not found: ${chunkId}`);
  const chunk = chunkRows[0];
  const sourceType = deriveChunkSourceType(chunk);

  // Check if there's an asset embedding linked to this chunk (via chunk text hash match)
  let assetVersionLink: string | null = null;
  if (chunk.chunkHash) {
    const embRows = await db
      .select({ assetVersionId: knowledgeAssetEmbeddings.assetVersionId })
      .from(knowledgeAssetEmbeddings)
      .where(and(
        eq(knowledgeAssetEmbeddings.tenantId, chunk.tenantId ?? ""),
        eq(knowledgeAssetEmbeddings.sourceChecksum, chunk.chunkHash),
      ))
      .limit(1);
    assetVersionLink = embRows[0]?.assetVersionId ?? null;
  }

  return {
    chunkId,
    tenantId: chunk.tenantId ?? null,
    documentId: chunk.knowledgeDocumentId,
    documentVersionId: chunk.knowledgeDocumentVersionId,
    knowledgeBaseId: chunk.knowledgeBaseId,
    chunkText: chunk.chunkText ?? null,
    chunkKey: chunk.chunkKey,
    chunkIndex: chunk.chunkIndex,
    sourceType,
    isActive: chunk.chunkActive,
    imageChunk: chunk.imageChunk,
    transcriptChunk: chunk.transcriptChunk,
    tableChunk: chunk.tableChunk,
    ocr_confidence: chunk.ocrConfidence?.toString() ?? null,
    assetVersionLink,
    note: assetVersionLink
      ? `Linked to asset version ${assetVersionLink} via chunk content hash`
      : "No asset version link found via content hash",
  };
}

// ── TASK 2: Build asset version lineage (INV-PROV2,6) ────────────────────────

export async function buildAssetVersionLineage(assetVersionId: string): Promise<{
  assetVersionId: string;
  versionNumber: number | null;
  assetId: string | null;
  tenantId: string | null;
  assetType: string | null;
  assetTitle: string | null;
  knowledgeBaseId: string | null;
  mimeType: string | null;
  ingestStatus: string | null;
  embeddingStatus: string | null;
  indexLifecycleState: string | null;
  storageObjectId: string | null;
  processorOutputs: string[];
  embeddings: Array<{
    id: string;
    sourceType: string;
    embeddingStatus: string;
    isActive: boolean;
    indexedAt: Date | null;
  }>;
}> {
  const versionRows = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.id, assetVersionId))
    .limit(1);
  if (!versionRows.length) throw new Error(`AssetVersion not found: ${assetVersionId}`);
  const version = versionRows[0];

  const assetRows = await db
    .select()
    .from(knowledgeAssets)
    .where(eq(knowledgeAssets.id, version.assetId))
    .limit(1);
  const asset = assetRows[0] ?? null;

  const embeddingRows = await db
    .select({
      id: knowledgeAssetEmbeddings.id,
      sourceType: knowledgeAssetEmbeddings.sourceType,
      embeddingStatus: knowledgeAssetEmbeddings.embeddingStatus,
      isActive: knowledgeAssetEmbeddings.isActive,
      indexedAt: knowledgeAssetEmbeddings.indexedAt,
    })
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  // Extract processor outputs from metadata
  const meta = (version.metadata ?? {}) as Record<string, unknown>;
  const processorOutputs: string[] = [];
  if (meta.ocr) processorOutputs.push("ocr");
  if (meta.transcript) processorOutputs.push("transcript");
  if (meta.caption) processorOutputs.push("caption");
  if (meta.video_frames) processorOutputs.push("video_frames");
  if (meta.imported_text) processorOutputs.push("imported_text");

  return {
    assetVersionId,
    versionNumber: version.versionNumber,
    assetId: version.assetId,
    tenantId: version.tenantId ?? null,
    assetType: asset?.assetType ?? null,
    assetTitle: asset?.title ?? null,
    knowledgeBaseId: asset?.knowledgeBaseId ?? null,
    mimeType: version.mimeType ?? null,
    ingestStatus: version.ingestStatus ?? null,
    embeddingStatus: version.embeddingStatus ?? null,
    indexLifecycleState: version.indexLifecycleState ?? null,
    storageObjectId: version.storageObjectId ?? null,
    processorOutputs,
    embeddings: embeddingRows.map((e) => ({
      id: e.id,
      sourceType: e.sourceType,
      embeddingStatus: e.embeddingStatus,
      isActive: e.isActive,
      indexedAt: e.indexedAt,
    })),
  };
}

// ── TASK 2: Explain why chunk was included in a retrieval run (INV-PROV4,6) ──

export async function explainChunkInclusionInRun(
  runId: string,
  chunkId: string,
): Promise<{
  found: boolean;
  filterStatus: string | null;
  inclusionReason: string | null;
  similarityScore: string | null;
  finalRank: number | null;
  tokenCountEstimate: number | null;
  sourceType: string | null;
  explanation: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(
      and(
        eq(knowledgeRetrievalCandidates.retrievalRunId, runId),
        eq(knowledgeRetrievalCandidates.chunkId, chunkId),
        eq(knowledgeRetrievalCandidates.filterStatus, "selected"),
      ),
    )
    .limit(1);

  if (!rows.length) {
    return {
      found: false,
      filterStatus: null,
      inclusionReason: null,
      similarityScore: null,
      finalRank: null,
      tokenCountEstimate: null,
      sourceType: null,
      explanation: `No 'selected' candidate record found for chunk ${chunkId} in run ${runId}. Candidates are persisted only when persistRun=true.`,
    };
  }

  const c = rows[0];
  return {
    found: true,
    filterStatus: c.filterStatus,
    inclusionReason: c.inclusionReason ?? null,
    similarityScore: c.similarityScore ?? null,
    finalRank: c.finalRank ?? null,
    tokenCountEstimate: c.tokenCountEstimate ?? null,
    sourceType: c.sourceType ?? null,
    explanation: c.inclusionReason
      ? `Chunk included because: ${c.inclusionReason}. Similarity: ${c.similarityScore ?? "N/A"}, final rank: ${c.finalRank ?? "N/A"}.`
      : "Chunk was selected but no explicit inclusion reason was recorded.",
  };
}

// ── TASK 2: Explain why chunk was excluded from a retrieval run (INV-PROV3,6) ─

export async function explainChunkExclusionFromRun(
  runId: string,
  chunkId: string,
): Promise<{
  found: boolean;
  filterStatus: string | null;
  exclusionReason: string | null;
  dedupReason: string | null;
  similarityScore: string | null;
  explanation: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(
      and(
        eq(knowledgeRetrievalCandidates.retrievalRunId, runId),
        eq(knowledgeRetrievalCandidates.chunkId, chunkId),
        eq(knowledgeRetrievalCandidates.filterStatus, "excluded"),
      ),
    )
    .limit(1);

  if (!rows.length) {
    return {
      found: false,
      filterStatus: null,
      exclusionReason: null,
      dedupReason: null,
      similarityScore: null,
      explanation: `No 'excluded' candidate record found for chunk ${chunkId} in run ${runId}.`,
    };
  }

  const c = rows[0];
  const reasonParts: string[] = [];
  if (c.exclusionReason) reasonParts.push(`exclusion_reason: ${c.exclusionReason}`);
  if (c.dedupReason) reasonParts.push(`dedup_reason: ${c.dedupReason}`);

  return {
    found: true,
    filterStatus: c.filterStatus,
    exclusionReason: c.exclusionReason ?? null,
    dedupReason: c.dedupReason ?? null,
    similarityScore: c.similarityScore ?? null,
    explanation: reasonParts.length
      ? `Chunk excluded because: ${reasonParts.join("; ")}.`
      : "Chunk was excluded but no explicit exclusion reason was recorded.",
  };
}

// ── TASK 8: Summarize retrieval run provenance (INV-PROV5,6) ─────────────────

export async function summarizeRetrievalProvenance(runId: string): Promise<{
  retrievalRunId: string;
  tenantId: string;
  knowledgeBaseId: string;
  embeddingVersion: string | null;
  retrievalVersion: string | null;
  totalCandidates: number;
  totalExcluded: number;
  totalSelected: number;
  exclusionBreakdown: Record<string, number>;
  inclusionBreakdown: Record<string, number>;
  sourceTypeBreakdown: Record<string, number>;
  dominantSourceTypes: string[];
  dominantExclusionReasons: string[];
  provenanceCompleteness: "full" | "partial" | "none";
  provenanceCompletenessNote: string;
}> {
  const run = await getRunById(runId);
  if (!run) throw new Error(`Retrieval run not found: ${runId}`);

  const candidates = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const selected = candidates.filter((c) => c.filterStatus === "selected");
  const excluded = candidates.filter((c) => c.filterStatus === "excluded");

  // Breakdowns
  const exclusionBreakdown: Record<string, number> = {};
  for (const c of excluded) {
    const r = c.exclusionReason ?? "unknown";
    exclusionBreakdown[r] = (exclusionBreakdown[r] ?? 0) + 1;
  }

  const inclusionBreakdown: Record<string, number> = {};
  for (const c of selected) {
    const r = c.inclusionReason ?? "unknown";
    inclusionBreakdown[r] = (inclusionBreakdown[r] ?? 0) + 1;
  }

  const sourceTypeBreakdown: Record<string, number> = {};
  for (const c of candidates) {
    const st = c.sourceType ?? "unknown";
    sourceTypeBreakdown[st] = (sourceTypeBreakdown[st] ?? 0) + 1;
  }

  const dominantSourceTypes = Object.entries(sourceTypeBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const dominantExclusionReasons = Object.entries(exclusionBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const expectedCandidates = run.candidatesFound;
  const provenanceCompleteness: "full" | "partial" | "none" =
    candidates.length === 0
      ? "none"
      : candidates.length >= expectedCandidates
      ? "full"
      : "partial";

  const provenanceCompletenessNote =
    provenanceCompleteness === "none"
      ? "No candidate records found — run was not persisted with persistRun=true"
      : provenanceCompleteness === "partial"
      ? `${candidates.length}/${expectedCandidates} candidates have provenance records`
      : `All ${candidates.length} candidates have provenance records`;

  return {
    retrievalRunId: runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    embeddingVersion: run.embeddingVersion ?? null,
    retrievalVersion: run.retrievalVersion ?? null,
    totalCandidates: candidates.length,
    totalExcluded: excluded.length,
    totalSelected: selected.length,
    exclusionBreakdown,
    inclusionBreakdown,
    sourceTypeBreakdown,
    dominantSourceTypes,
    dominantExclusionReasons,
    provenanceCompleteness,
    provenanceCompletenessNote,
  };
}

// ── TASK 2: List context sources for a run (INV-PROV2,6) ─────────────────────

export async function listContextSourcesForRun(runId: string): Promise<{
  runId: string;
  entries: Array<{
    chunkId: string | null;
    finalRank: number | null;
    tokenCountEstimate: number | null;
    sourceType: string | null;
    sourceKey: string | null;
    assetId: string | null;
    assetVersionId: string | null;
    inclusionReason: string | null;
    similarityScore: string | null;
  }>;
  count: number;
  note: string;
}> {
  const run = await getRunById(runId);
  if (!run) throw new Error(`Retrieval run not found: ${runId}`);

  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(
      and(
        eq(knowledgeRetrievalCandidates.retrievalRunId, runId),
        eq(knowledgeRetrievalCandidates.filterStatus, "selected"),
      ),
    );

  const sorted = [...rows].sort((a, b) => (a.finalRank ?? 999) - (b.finalRank ?? 999));

  return {
    runId,
    entries: sorted.map((c) => ({
      chunkId: c.chunkId ?? null,
      finalRank: c.finalRank ?? null,
      tokenCountEstimate: c.tokenCountEstimate ?? null,
      sourceType: c.sourceType ?? null,
      sourceKey: c.sourceKey ?? null,
      assetId: c.knowledgeAssetId ?? null,
      assetVersionId: c.knowledgeAssetVersionId ?? null,
      inclusionReason: c.inclusionReason ?? null,
      similarityScore: c.similarityScore ?? null,
    })),
    count: rows.length,
    note:
      rows.length === 0
        ? "No selected candidates found — run may not have been persisted with persistRun=true"
        : `${rows.length} selected context entries`,
  };
}

// ── TASK 8: Summarize retrieval run explainability ────────────────────────────

export async function summarizeRetrievalRunExplainability(runId: string): Promise<{
  retrievalRunId: string;
  tenantId: string;
  knowledgeBaseId: string;
  embeddingVersion: string | null;
  retrievalVersion: string | null;
  totalCandidates: number;
  totalExcluded: number;
  totalSelected: number;
  totalContextEntries: number;
  totalContextTokens: number;
  dominantSourceTypes: string[];
  dominantAssets: string[];
  provenanceCompleteness: string;
  explainabilityCompletenessStatus: "complete" | "partial" | "unavailable";
  notes: string[];
}> {
  const run = await getRunById(runId);
  if (!run) throw new Error(`Retrieval run not found: ${runId}`);

  const candidates = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const selected = candidates.filter((c) => c.filterStatus === "selected");
  const excluded = candidates.filter((c) => c.filterStatus === "excluded");

  const sourceTypeCounts: Record<string, number> = {};
  const assetCounts: Record<string, number> = {};
  for (const c of selected) {
    if (c.sourceType) sourceTypeCounts[c.sourceType] = (sourceTypeCounts[c.sourceType] ?? 0) + 1;
    if (c.knowledgeAssetId) assetCounts[c.knowledgeAssetId] = (assetCounts[c.knowledgeAssetId] ?? 0) + 1;
  }

  const dominantSourceTypes = Object.entries(sourceTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const dominantAssets = Object.entries(assetCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const totalContextTokens = selected.reduce(
    (sum, c) => sum + (c.tokenCountEstimate ?? 0),
    0,
  );

  const hasExclusionReasons = excluded.every((c) => c.exclusionReason !== null);
  const hasInclusionReasons = selected.every((c) => c.inclusionReason !== null);

  const explainabilityCompletenessStatus: "complete" | "partial" | "unavailable" =
    candidates.length === 0
      ? "unavailable"
      : hasExclusionReasons && hasInclusionReasons
      ? "complete"
      : "partial";

  const notes: string[] = [];
  if (candidates.length === 0) {
    notes.push("No candidate records — run was not executed with persistRun=true");
  }
  if (!hasExclusionReasons && excluded.length > 0) {
    notes.push("Some excluded candidates are missing explicit reason codes");
  }
  if (!hasInclusionReasons && selected.length > 0) {
    notes.push("Some selected candidates are missing explicit inclusion reason codes");
  }

  return {
    retrievalRunId: runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    embeddingVersion: run.embeddingVersion ?? null,
    retrievalVersion: run.retrievalVersion ?? null,
    totalCandidates: candidates.length,
    totalExcluded: excluded.length,
    totalSelected: selected.length,
    totalContextEntries: run.chunksSelected,
    totalContextTokens: totalContextTokens || run.contextTokensUsed,
    dominantSourceTypes,
    dominantAssets,
    provenanceCompleteness:
      candidates.length === 0 ? "none" : candidates.length >= run.candidatesFound ? "full" : "partial",
    explainabilityCompletenessStatus,
    notes,
  };
}
