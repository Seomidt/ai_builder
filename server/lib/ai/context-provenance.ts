/**
 * context-provenance.ts — Phase 5M
 *
 * Context window provenance and per-entry explainability.
 *
 * This module provides the foundation for future UI citations,
 * audit trails, and enterprise debugging of context assembly.
 *
 * INV-PROV6:  All functions in this module perform NO writes
 * INV-PROV12: Context-window provenance matches final selected entries exactly
 * INV-PROV2:  Every entry is traceable to asset + version + source type
 * INV-PROV7:  Multimodal source distinctions are preserved
 */

import { db } from "../../db";
import {
  knowledgeRetrievalCandidates,
  knowledgeRetrievalRuns,
  knowledgeChunks,
  knowledgeAssets,
  knowledgeAssetVersions,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { deriveChunkSourceType } from "./retrieval-provenance";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContextEntry {
  finalRank: number | null;
  chunkId: string | null;
  chunkKey: string | null;
  chunkIndex: number | null;
  tokenEstimate: number | null;
  similarityScore: string | null;
  sourceType: string | null;
  sourceKey: string | null;
  assetId: string | null;
  assetTitle: string | null;
  assetVersionId: string | null;
  assetVersionNumber: number | null;
  knowledgeBaseId: string | null;
  inclusionReason: string | null;
  provenanceComplete: boolean;
  provenanceNote: string;
}

export interface ContextWindowProvenance {
  runId: string;
  tenantId: string;
  knowledgeBaseId: string;
  totalContextEntries: number;
  totalContextTokens: number;
  entries: ContextEntry[];
  sourceTypeBreakdown: Record<string, number>;
  assetBreakdown: Record<string, string>; // assetId → title
  provenanceCompleteness: "full" | "partial" | "none";
  note: string;
}

// ── TASK 6: Build context window provenance (INV-PROV12,6) ───────────────────

export async function buildContextWindowProvenance(
  runId: string,
): Promise<ContextWindowProvenance> {
  const runRows = await db
    .select()
    .from(knowledgeRetrievalRuns)
    .where(eq(knowledgeRetrievalRuns.id, runId))
    .limit(1);
  if (!runRows.length) throw new Error(`Retrieval run not found: ${runId}`);
  const run = runRows[0];

  const candidates = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(
      and(
        eq(knowledgeRetrievalCandidates.retrievalRunId, runId),
        eq(knowledgeRetrievalCandidates.filterStatus, "selected"),
      ),
    );

  const sorted = [...candidates].sort((a, b) => (a.finalRank ?? 999) - (b.finalRank ?? 999));
  const totalTokens = sorted.reduce((sum, c) => sum + (c.tokenCountEstimate ?? 0), 0);

  const entries: ContextEntry[] = [];
  const sourceTypeBreakdown: Record<string, number> = {};
  const assetBreakdown: Record<string, string> = {};

  for (const c of sorted) {
    let chunkKey: string | null = null;
    let chunkIndex: number | null = null;
    let assetTitle: string | null = null;
    let assetVersionNumber: number | null = null;
    let resolvedSourceType = c.sourceType;
    let provenanceComplete = true;
    const provenanceParts: string[] = [];

    // Resolve chunk details
    if (c.chunkId) {
      const chunkRows = await db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.id, c.chunkId))
        .limit(1);
      if (chunkRows.length) {
        chunkKey = chunkRows[0].chunkKey;
        chunkIndex = chunkRows[0].chunkIndex;
        if (!resolvedSourceType) {
          resolvedSourceType = deriveChunkSourceType(chunkRows[0]);
        }
      } else {
        provenanceComplete = false;
        provenanceParts.push("chunk not found");
      }
    }

    // Resolve asset title
    if (c.knowledgeAssetId) {
      const assetRows = await db
        .select({ title: knowledgeAssets.title })
        .from(knowledgeAssets)
        .where(eq(knowledgeAssets.id, c.knowledgeAssetId))
        .limit(1);
      assetTitle = assetRows[0]?.title ?? null;
      if (assetTitle) assetBreakdown[c.knowledgeAssetId] = assetTitle;
    }

    // Resolve asset version number
    if (c.knowledgeAssetVersionId) {
      const versionRows = await db
        .select({ versionNumber: knowledgeAssetVersions.versionNumber })
        .from(knowledgeAssetVersions)
        .where(eq(knowledgeAssetVersions.id, c.knowledgeAssetVersionId))
        .limit(1);
      assetVersionNumber = versionRows[0]?.versionNumber ?? null;
    }

    if (!c.knowledgeAssetId) {
      provenanceComplete = false;
      provenanceParts.push("no asset_id linked");
    }
    if (!resolvedSourceType) {
      provenanceComplete = false;
      provenanceParts.push("source_type undetermined");
    }

    const provenanceNote = provenanceComplete
      ? "Full provenance available"
      : `Partial provenance: ${provenanceParts.join(", ")}`;

    const st = resolvedSourceType ?? "unknown";
    sourceTypeBreakdown[st] = (sourceTypeBreakdown[st] ?? 0) + 1;

    entries.push({
      finalRank: c.finalRank ?? null,
      chunkId: c.chunkId ?? null,
      chunkKey,
      chunkIndex,
      tokenEstimate: c.tokenCountEstimate ?? null,
      similarityScore: c.similarityScore ?? null,
      sourceType: resolvedSourceType ?? null,
      sourceKey: c.sourceKey ?? null,
      assetId: c.knowledgeAssetId ?? null,
      assetTitle,
      assetVersionId: c.knowledgeAssetVersionId ?? null,
      assetVersionNumber,
      knowledgeBaseId: run.knowledgeBaseId,
      inclusionReason: c.inclusionReason ?? null,
      provenanceComplete,
      provenanceNote,
    });
  }

  const provenanceCompleteness: "full" | "partial" | "none" =
    entries.length === 0
      ? "none"
      : entries.every((e) => e.provenanceComplete)
      ? "full"
      : "partial";

  return {
    runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    totalContextEntries: entries.length,
    totalContextTokens: totalTokens || run.contextTokensUsed,
    entries,
    sourceTypeBreakdown,
    assetBreakdown,
    provenanceCompleteness,
    note:
      entries.length === 0
        ? "No selected candidates found — run may not have been persisted with persistRun=true"
        : `${entries.length} context entries with ${provenanceCompleteness} provenance`,
  };
}

// ── TASK 6: Summarize context window sources (INV-PROV7,6) ───────────────────

export async function summarizeContextWindowSources(runId: string): Promise<{
  runId: string;
  sourceTypeBreakdown: Record<string, number>;
  assetContributions: Array<{ assetId: string; assetTitle: string | null; chunkCount: number }>;
  multimodalSourcesPresent: boolean;
  dominantSourceType: string | null;
  totalContextEntries: number;
}> {
  const prov = await buildContextWindowProvenance(runId);

  const assetMap = new Map<string, { assetTitle: string | null; chunkCount: number }>();
  for (const e of prov.entries) {
    if (e.assetId) {
      const existing = assetMap.get(e.assetId) ?? { assetTitle: e.assetTitle, chunkCount: 0 };
      existing.chunkCount++;
      assetMap.set(e.assetId, existing);
    }
  }

  const assetContributions = Array.from(assetMap.entries()).map(([assetId, v]) => ({
    assetId,
    assetTitle: v.assetTitle,
    chunkCount: v.chunkCount,
  }));

  const nonParsedSources = Object.keys(prov.sourceTypeBreakdown).filter(
    (k) => k !== "parsed_text" && k !== "unknown",
  );

  const dominantSourceType =
    Object.entries(prov.sourceTypeBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    runId,
    sourceTypeBreakdown: prov.sourceTypeBreakdown,
    assetContributions,
    multimodalSourcesPresent: nonParsedSources.length > 0,
    dominantSourceType,
    totalContextEntries: prov.totalContextEntries,
  };
}

// ── TASK 6: Explain a context entry (INV-PROV4,6,12) ────────────────────────

export async function explainContextEntry(
  runId: string,
  chunkId: string,
): Promise<{
  found: boolean;
  finalRank: number | null;
  inclusionReason: string | null;
  sourceType: string | null;
  similarityScore: string | null;
  tokenEstimate: number | null;
  assetId: string | null;
  assetTitle: string | null;
  assetVersionId: string | null;
  assetVersionNumber: number | null;
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
      finalRank: null,
      inclusionReason: null,
      sourceType: null,
      similarityScore: null,
      tokenEstimate: null,
      assetId: null,
      assetTitle: null,
      assetVersionId: null,
      assetVersionNumber: null,
      explanation: `Chunk ${chunkId} not found in final context for run ${runId}.`,
    };
  }

  const c = rows[0];
  let assetTitle: string | null = null;
  let assetVersionNumber: number | null = null;

  if (c.knowledgeAssetId) {
    const assetRows = await db
      .select({ title: knowledgeAssets.title })
      .from(knowledgeAssets)
      .where(eq(knowledgeAssets.id, c.knowledgeAssetId))
      .limit(1);
    assetTitle = assetRows[0]?.title ?? null;
  }
  if (c.knowledgeAssetVersionId) {
    const versionRows = await db
      .select({ versionNumber: knowledgeAssetVersions.versionNumber })
      .from(knowledgeAssetVersions)
      .where(eq(knowledgeAssetVersions.id, c.knowledgeAssetVersionId))
      .limit(1);
    assetVersionNumber = versionRows[0]?.versionNumber ?? null;
  }

  const explanation = [
    `Chunk included at final rank ${c.finalRank ?? "N/A"}.`,
    c.inclusionReason ? `Inclusion reason: ${c.inclusionReason}.` : "",
    c.sourceType ? `Source type: ${c.sourceType}.` : "",
    c.similarityScore ? `Similarity score: ${c.similarityScore}.` : "",
    assetTitle ? `Asset: "${assetTitle}"` : (c.knowledgeAssetId ? `Asset ID: ${c.knowledgeAssetId}` : ""),
    assetVersionNumber != null ? `Version #${assetVersionNumber}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    found: true,
    finalRank: c.finalRank ?? null,
    inclusionReason: c.inclusionReason ?? null,
    sourceType: c.sourceType ?? null,
    similarityScore: c.similarityScore ?? null,
    tokenEstimate: c.tokenCountEstimate ?? null,
    assetId: c.knowledgeAssetId ?? null,
    assetTitle,
    assetVersionId: c.knowledgeAssetVersionId ?? null,
    assetVersionNumber,
    explanation,
  };
}

// ── TASK 6: List final context entries (INV-PROV12,6) ────────────────────────

export async function listFinalContextEntries(runId: string): Promise<ContextEntry[]> {
  const prov = await buildContextWindowProvenance(runId);
  return prov.entries;
}
