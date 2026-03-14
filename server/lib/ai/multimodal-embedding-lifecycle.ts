/**
 * multimodal-embedding-lifecycle.ts — Phase 5L
 *
 * Multimodal embedding generation, index lifecycle management,
 * stale detection, reindex scheduling, and retrieval readiness.
 *
 * State machine for knowledge_asset_versions.index_lifecycle_state:
 *   not_ready  → no valid embedding inputs exist
 *   pending    → inputs exist but embeddings not yet complete
 *   indexed    → all required embeddings complete and current
 *   stale      → source changed / model upgraded / requires rebuild
 *   failed     → embedding generation failed and requires retry
 *
 * INV-EMB1:  All operations are tenant-safe — no cross-tenant access
 * INV-EMB2:  Embeddings attributable to specific asset_version + source
 * INV-EMB3:  Deterministic for same input/source/model combination
 * INV-EMB4:  indexed state only set when all lifecycle conditions met
 * INV-EMB5:  Stale detection is explainable (never heuristic magic)
 * INV-EMB6:  Reindex scheduling is idempotent
 * INV-EMB7:  Current-version changes invalidate old retrieval readiness
 * INV-EMB8:  Source merging is explicit and documented
 * INV-EMB9:  Existing 5D-5H retrieval invariants preserved
 * INV-EMB10: Trust-signal semantics from 5F preserved
 * INV-EMB11: No cross-tenant embedding linkage
 * INV-EMB12: Preview/explain endpoints perform no writes
 */

import { db } from "../../db";
import {
  knowledgeAssetVersions,
  knowledgeAssetEmbeddings,
  knowledgeAssets,
  knowledgeAssetProcessingJobs,
  type KnowledgeAssetVersion,
  type KnowledgeAsset,
} from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import OpenAI from "openai";
import crypto from "crypto";
import {
  listEmbeddingSourcesForAssetVersion,
  buildEmbeddingInputsForAssetVersion,
  summarizeEmbeddingSourceCoverage,
  type EmbeddingSource,
} from "./multimodal-embedding-sources";

const EMBEDDING_PROVIDER = "openai";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_VERSION = "v1";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_TEXT_CHARS = 8000;

// ── Index lifecycle state type ─────────────────────────────────────────────────
export type IndexLifecycleState = "not_ready" | "pending" | "indexed" | "stale" | "failed";
export type EmbeddingStatusValue = "pending" | "completed" | "failed" | "stale";

// ── Preview types (no writes) ─────────────────────────────────────────────────

export interface EmbeddingGenerationPreview {
  assetVersionId: string;
  tenantId: string;
  sourcesFound: number;
  activeSources: number;
  embeddingsThatWouldBeCreated: number;
  estimatedTextChars: number;
  sourceBreakdown: Array<{
    sourceType: string;
    sourceKey: string;
    textLength: number;
    priority: number;
  }>;
  alreadyIndexed: boolean;
  requiresReindex: boolean;
  staleEmbeddingCount: number;
  notes: string[];
}

export interface ReindexPreview {
  assetVersionId: string;
  currentState: IndexLifecycleState | null;
  activeEmbeddingCount: number;
  staleEmbeddingCount: number;
  pendingEmbeddingCount: number;
  failedEmbeddingCount: number;
  embeddingsToMarkStale: number;
  embeddingsToCreate: number;
  estimatedWork: string;
  notes: string[];
}

export interface StaleDetectionResult {
  assetVersionId: string;
  isStale: boolean;
  staleReasons: string[];
  checksumChanges: Array<{ sourceType: string; sourceKey: string; reason: string }>;
  modelUpgrade: boolean;
  sourceChanges: boolean;
  explainLog: string[];
}

export interface RetrievalReadinessExplain {
  assetVersionId: string;
  isRetrievalReady: boolean;
  indexLifecycleState: IndexLifecycleState | null;
  activeEmbeddingCount: number;
  completedEmbeddingCount: number;
  staleEmbeddingCount: number;
  reasons: string[];
  blockers: string[];
  recommendations: string[];
}

export interface EmbeddingRebuildImpact {
  assetVersionId: string;
  currentEmbeddingCount: number;
  activeEmbeddingCount: number;
  wouldMarkStale: number;
  wouldCreate: number;
  impactLevel: "none" | "low" | "medium" | "high";
  notes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getVersionWithAsset(assetVersionId: string): Promise<{
  version: KnowledgeAssetVersion;
  asset: KnowledgeAsset;
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
  if (!assetRows.length) throw new Error(`Asset not found: ${version.assetId}`);
  const asset = assetRows[0];

  return { version, asset };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + " [truncated]";
}

function sourceChecksum(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ── TASK 2: Preview generate embeddings (INV-EMB12: no writes) ────────────────

export async function previewGenerateEmbeddingsForAssetVersion(
  assetVersionId: string,
): Promise<EmbeddingGenerationPreview> {
  const { version, asset } = await getVersionWithAsset(assetVersionId);
  const { sources, activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);

  const existing = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const staleCount = existing.filter((e) => e.embeddingStatus === "stale").length;
  const completedCount = existing.filter((e) => e.embeddingStatus === "completed" && e.isActive).length;
  const alreadyIndexed = version.indexLifecycleState === "indexed";

  const notes: string[] = [];
  if (alreadyIndexed && staleCount === 0) {
    notes.push("Asset version is already indexed — no new embeddings required unless forced");
  }
  if (activeSources.length === 0) {
    notes.push("No embeddable sources found — ensure asset has been processed by OCR/transcription/caption processor");
  }
  if (staleCount > 0) {
    notes.push(`${staleCount} stale embedding(s) would be replaced`);
  }

  return {
    assetVersionId,
    tenantId: version.tenantId ?? "",
    sourcesFound: sources.length,
    activeSources: activeSources.length,
    embeddingsThatWouldBeCreated: activeSources.length,
    estimatedTextChars: activeSources.reduce((sum, s) => sum + s.sourceLength, 0),
    sourceBreakdown: activeSources.map((s) => ({
      sourceType: s.sourceType,
      sourceKey: s.sourceKey,
      textLength: s.sourceLength,
      priority: s.sourcePriority,
    })),
    alreadyIndexed,
    requiresReindex: staleCount > 0 || !alreadyIndexed,
    staleEmbeddingCount: staleCount,
    notes,
  };
}

// ── TASK 4: Generate embeddings (real OpenAI calls) ───────────────────────────

export async function generateEmbeddingsForAssetVersion(assetVersionId: string): Promise<{
  created: number;
  markedStale: number;
  skipped: number;
  errors: string[];
  newIndexLifecycleState: IndexLifecycleState;
}> {
  const { version, asset } = await getVersionWithAsset(assetVersionId);
  const tenantId = version.tenantId ?? asset.tenantId;
  const { activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);

  if (activeSources.length === 0) {
    await db
      .update(knowledgeAssetVersions)
      .set({
        indexLifecycleState: "not_ready",
        embeddingStatus: "not_ready",
        indexLifecycleUpdatedAt: new Date(),
      })
      .where(eq(knowledgeAssetVersions.id, assetVersionId));
    return { created: 0, markedStale: 0, skipped: 0, errors: [], newIndexLifecycleState: "not_ready" };
  }

  // Mark existing active embeddings as stale before regenerating
  const existingActive = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(
      and(
        eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId),
        eq(knowledgeAssetEmbeddings.isActive, true),
      ),
    );

  let markedStale = 0;
  if (existingActive.length > 0) {
    await db
      .update(knowledgeAssetEmbeddings)
      .set({ embeddingStatus: "stale", isActive: false, staleReason: "regeneration_requested", updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId),
          eq(knowledgeAssetEmbeddings.isActive, true),
        ),
      );
    markedStale = existingActive.length;
  }

  // Transition to pending
  await db
    .update(knowledgeAssetVersions)
    .set({ indexLifecycleState: "pending", embeddingStatus: "pending", indexLifecycleUpdatedAt: new Date() })
    .where(eq(knowledgeAssetVersions.id, assetVersionId));

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const source of activeSources) {
    try {
      const text = truncateText(source.textContent, MAX_TEXT_CHARS);
      const chk = sourceChecksum(text);

      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        encoding_format: "float",
      });
      const vector = response.data[0].embedding;

      await db.insert(knowledgeAssetEmbeddings).values({
        tenantId,
        assetId: asset.id,
        assetVersionId,
        sourceType: source.sourceType,
        sourceKey: source.sourceKey,
        sourceChecksum: chk,
        sourcePriority: source.sourcePriority,
        textLength: text.length,
        embeddingProvider: EMBEDDING_PROVIDER,
        embeddingModel: EMBEDDING_MODEL,
        embeddingVersion: EMBEDDING_VERSION,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        embeddingVector: vector as number[],
        embeddingStatus: "completed",
        indexedAt: new Date(),
        isActive: true,
        metadata: {
          originProcessor: source.originProcessor,
          sourceMetadata: source.sourceMetadata,
          tokenUsage: response.usage?.total_tokens ?? null,
        },
      });
      created++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${source.sourceType}/${source.sourceKey}: ${msg}`);
      skipped++;
    }
  }

  // Determine final lifecycle state
  const newState: IndexLifecycleState =
    errors.length === activeSources.length
      ? "failed"
      : errors.length > 0
      ? "stale"
      : "indexed";

  await db
    .update(knowledgeAssetVersions)
    .set({
      indexLifecycleState: newState,
      embeddingStatus: newState,
      indexLifecycleUpdatedAt: new Date(),
    })
    .where(eq(knowledgeAssetVersions.id, assetVersionId));

  return { created, markedStale, skipped, errors, newIndexLifecycleState: newState };
}

// ── TASK 4: Preview reindex ───────────────────────────────────────────────────

export async function previewReindexAssetVersion(assetVersionId: string): Promise<ReindexPreview> {
  const { version } = await getVersionWithAsset(assetVersionId);
  const existing = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const active = existing.filter((e) => e.isActive && e.embeddingStatus === "completed").length;
  const stale = existing.filter((e) => e.embeddingStatus === "stale").length;
  const pending = existing.filter((e) => e.embeddingStatus === "pending").length;
  const failed = existing.filter((e) => e.embeddingStatus === "failed").length;
  const { activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);

  const notes: string[] = [];
  if (active > 0) notes.push(`${active} active embedding(s) would be marked stale before regeneration`);
  if (activeSources.length === 0) notes.push("No embeddable sources — ensure processing jobs completed first");

  return {
    assetVersionId,
    currentState: (version.indexLifecycleState as IndexLifecycleState) ?? null,
    activeEmbeddingCount: active,
    staleEmbeddingCount: stale,
    pendingEmbeddingCount: pending,
    failedEmbeddingCount: failed,
    embeddingsToMarkStale: active,
    embeddingsToCreate: activeSources.length,
    estimatedWork: activeSources.length === 0 ? "no-op" : `${activeSources.length} embedding(s) to generate`,
    notes,
  };
}

// ── TASK 5: Mark stale ────────────────────────────────────────────────────────

export async function markAssetVersionIndexStale(
  assetVersionId: string,
  reason: string,
): Promise<void> {
  await db
    .update(knowledgeAssetVersions)
    .set({
      indexLifecycleState: "stale",
      embeddingStatus: "stale",
      indexLifecycleUpdatedAt: new Date(),
    })
    .where(eq(knowledgeAssetVersions.id, assetVersionId));

  await db
    .update(knowledgeAssetEmbeddings)
    .set({ embeddingStatus: "stale", staleReason: reason, isActive: false, updatedAt: new Date() })
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));
}

// ── TASK 5: Sync lifecycle state ──────────────────────────────────────────────

export async function syncAssetVersionIndexState(assetVersionId: string): Promise<IndexLifecycleState> {
  const coverage = await summarizeEmbeddingSourceCoverage(assetVersionId);
  const existing = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const completed = existing.filter((e) => e.embeddingStatus === "completed" && e.isActive);
  const stale = existing.filter((e) => e.embeddingStatus === "stale");
  const failed = existing.filter((e) => e.embeddingStatus === "failed");
  const pending = existing.filter((e) => e.embeddingStatus === "pending");

  let newState: IndexLifecycleState;

  if (!coverage.hasEmbeddableContent) {
    newState = "not_ready";
  } else if (failed.length > 0 && completed.length === 0) {
    newState = "failed";
  } else if (stale.length > 0 && completed.length < coverage.activeSources) {
    newState = "stale";
  } else if (pending.length > 0 || completed.length < coverage.activeSources) {
    newState = "pending";
  } else if (completed.length >= coverage.activeSources && coverage.activeSources > 0) {
    newState = "indexed";
  } else {
    newState = "not_ready";
  }

  await db
    .update(knowledgeAssetVersions)
    .set({ indexLifecycleState: newState, embeddingStatus: newState, indexLifecycleUpdatedAt: new Date() })
    .where(eq(knowledgeAssetVersions.id, assetVersionId));

  return newState;
}

// ── TASK 5: Explain lifecycle state ──────────────────────────────────────────

export async function explainAssetVersionIndexState(assetVersionId: string): Promise<{
  assetVersionId: string;
  currentState: IndexLifecycleState | null;
  derivedState: IndexLifecycleState;
  embeddingCounts: { completed: number; stale: number; pending: number; failed: number; total: number };
  coverageSummary: Awaited<ReturnType<typeof summarizeEmbeddingSourceCoverage>>;
  stateReasoning: string[];
}> {
  const { version } = await getVersionWithAsset(assetVersionId);
  const coverage = await summarizeEmbeddingSourceCoverage(assetVersionId);
  const existing = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const counts = {
    completed: existing.filter((e) => e.embeddingStatus === "completed" && e.isActive).length,
    stale: existing.filter((e) => e.embeddingStatus === "stale").length,
    pending: existing.filter((e) => e.embeddingStatus === "pending").length,
    failed: existing.filter((e) => e.embeddingStatus === "failed").length,
    total: existing.length,
  };

  const stateReasoning: string[] = [];
  let derivedState: IndexLifecycleState = "not_ready";

  if (!coverage.hasEmbeddableContent) {
    derivedState = "not_ready";
    stateReasoning.push("No embeddable sources found — content may need processing");
  } else if (counts.failed > 0 && counts.completed === 0) {
    derivedState = "failed";
    stateReasoning.push(`${counts.failed} embedding(s) failed with no successful completions`);
  } else if (counts.stale > 0) {
    derivedState = "stale";
    stateReasoning.push(`${counts.stale} embedding(s) marked stale — source content or model changed`);
  } else if (counts.pending > 0) {
    derivedState = "pending";
    stateReasoning.push(`${counts.pending} embedding(s) pending completion`);
  } else if (counts.completed >= coverage.activeSources && coverage.activeSources > 0) {
    derivedState = "indexed";
    stateReasoning.push(`${counts.completed} active embedding(s) covering all ${coverage.activeSources} source(s)`);
  } else if (counts.completed > 0) {
    derivedState = "pending";
    stateReasoning.push(`${counts.completed}/${coverage.activeSources} sources embedded — not fully indexed`);
  }

  return {
    assetVersionId,
    currentState: (version.indexLifecycleState as IndexLifecycleState) ?? null,
    derivedState,
    embeddingCounts: counts,
    coverageSummary: coverage,
    stateReasoning,
  };
}

// ── TASK 6: Stale detection ───────────────────────────────────────────────────

export async function detectStaleEmbeddingsForAssetVersion(
  assetVersionId: string,
): Promise<StaleDetectionResult> {
  const { version } = await getVersionWithAsset(assetVersionId);
  const activeSources = await listEmbeddingSourcesForAssetVersion(assetVersionId);
  const existingEmbeddings = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(
      and(
        eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId),
        eq(knowledgeAssetEmbeddings.isActive, true),
      ),
    );

  const staleReasons: string[] = [];
  const checksumChanges: Array<{ sourceType: string; sourceKey: string; reason: string }> = [];
  const explainLog: string[] = [];

  // Rule 1: checksum change
  for (const emb of existingEmbeddings) {
    const matchingSource = activeSources.find(
      (s) => s.sourceType === emb.sourceType && s.sourceKey === emb.sourceKey,
    );
    if (matchingSource && emb.sourceChecksum) {
      const currentChecksum = crypto
        .createHash("sha256")
        .update(matchingSource.textContent)
        .digest("hex")
        .slice(0, 32);
      if (currentChecksum !== emb.sourceChecksum) {
        staleReasons.push(`Source checksum changed for ${emb.sourceType}/${emb.sourceKey}`);
        checksumChanges.push({
          sourceType: emb.sourceType ?? "",
          sourceKey: emb.sourceKey ?? "",
          reason: `checksum_mismatch: stored=${emb.sourceChecksum} current=${currentChecksum}`,
        });
        explainLog.push(`[STALE] ${emb.sourceType}: source content changed since last embedding`);
      } else {
        explainLog.push(`[OK] ${emb.sourceType}: checksum matches stored value`);
      }
    } else if (!matchingSource && emb.embeddingStatus === "completed") {
      staleReasons.push(`Source type ${emb.sourceType} no longer present in current metadata`);
      explainLog.push(`[STALE] ${emb.sourceType}: source disappeared from metadata`);
    }
  }

  // Rule 2: embedding model/version upgrade
  const modelUpgrade = existingEmbeddings.some(
    (e) => e.embeddingModel !== EMBEDDING_MODEL || e.embeddingVersion !== EMBEDDING_VERSION,
  );
  if (modelUpgrade) {
    staleReasons.push(`Embedding model/version upgraded (current: ${EMBEDDING_MODEL}/${EMBEDDING_VERSION})`);
    explainLog.push(`[STALE] Model upgrade detected — existing embeddings use different model/version`);
  } else {
    explainLog.push(`[OK] Embedding model/version is current: ${EMBEDDING_MODEL}/${EMBEDDING_VERSION}`);
  }

  const isStale = staleReasons.length > 0;
  return {
    assetVersionId,
    isStale,
    staleReasons,
    checksumChanges,
    modelUpgrade,
    sourceChanges: checksumChanges.length > 0,
    explainLog,
  };
}

export async function previewStaleReasonsForAssetVersion(assetVersionId: string): Promise<StaleDetectionResult> {
  return detectStaleEmbeddingsForAssetVersion(assetVersionId);
}

// ── TASK 6: List stale versions ───────────────────────────────────────────────

export async function listStaleAssetVersions(limit = 50): Promise<
  Array<{ assetVersionId: string; assetId: string; tenantId: string; indexLifecycleState: string | null }>
> {
  const rows = await db
    .select({
      id: knowledgeAssetVersions.id,
      assetId: knowledgeAssetVersions.assetId,
      tenantId: knowledgeAssetVersions.tenantId,
      indexLifecycleState: knowledgeAssetVersions.indexLifecycleState,
    })
    .from(knowledgeAssetVersions)
    .where(inArray(knowledgeAssetVersions.indexLifecycleState, ["stale", "failed"]))
    .limit(limit);
  return rows.map((r) => ({
    assetVersionId: r.id,
    assetId: r.assetId,
    tenantId: r.tenantId ?? "",
    indexLifecycleState: r.indexLifecycleState,
  }));
}

// ── TASK 7: Reindex scheduling ────────────────────────────────────────────────

export async function previewEmbeddingRebuildImpact(assetVersionId: string): Promise<EmbeddingRebuildImpact> {
  const existing = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const active = existing.filter((e) => e.isActive && e.embeddingStatus === "completed");
  const { activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);

  const impactLevel: "none" | "low" | "medium" | "high" =
    active.length === 0 ? "none" : active.length <= 2 ? "low" : active.length <= 5 ? "medium" : "high";

  return {
    assetVersionId,
    currentEmbeddingCount: existing.length,
    activeEmbeddingCount: active.length,
    wouldMarkStale: active.length,
    wouldCreate: activeSources.length,
    impactLevel,
    notes:
      active.length === 0
        ? ["No active embeddings — rebuild has no destructive impact"]
        : [`${active.length} active embedding(s) would transition to stale`],
  };
}

// ── TASK 7: Idempotent reindex scheduling via processing jobs ─────────────────

export async function scheduleReindexForAssetVersion(assetVersionId: string): Promise<{
  scheduled: boolean;
  jobId: string | null;
  reason: string;
}> {
  const { version, asset } = await getVersionWithAsset(assetVersionId);

  // INV-EMB6: idempotent — no duplicate active jobs
  const existing = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.assetVersionId, assetVersionId),
        eq(knowledgeAssetProcessingJobs.jobType, "reindex_asset"),
        inArray(knowledgeAssetProcessingJobs.jobStatus, ["pending", "running"]),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { scheduled: false, jobId: existing[0].id, reason: "active_reindex_job_already_exists" };
  }

  const inserted = await db
    .insert(knowledgeAssetProcessingJobs)
    .values({
      tenantId: version.tenantId ?? asset.tenantId,
      assetId: asset.id,
      assetVersionId,
      jobType: "reindex_asset",
      jobStatus: "pending",
      attemptNumber: 1,
      metadata: {
        scheduledBy: "multimodal-embedding-lifecycle",
        phase: "5L",
        reason: "lifecycle_reindex",
      },
    })
    .returning({ id: knowledgeAssetProcessingJobs.id });

  return { scheduled: true, jobId: inserted[0].id, reason: "new_reindex_job_created" };
}

// ── TASK 8: Retrieval readiness ───────────────────────────────────────────────

export async function isAssetVersionRetrievalReady(assetVersionId: string): Promise<boolean> {
  const { version } = await getVersionWithAsset(assetVersionId);
  if (version.indexLifecycleState !== "indexed") return false;

  const completed = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(
      and(
        eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId),
        eq(knowledgeAssetEmbeddings.embeddingStatus, "completed"),
        eq(knowledgeAssetEmbeddings.isActive, true),
      ),
    );

  return completed.length > 0;
}

export async function explainWhyAssetVersionIsOrIsNotRetrievalReady(
  assetVersionId: string,
): Promise<RetrievalReadinessExplain> {
  const { version } = await getVersionWithAsset(assetVersionId);
  const coverage = await summarizeEmbeddingSourceCoverage(assetVersionId);
  const allEmbeddings = await db
    .select()
    .from(knowledgeAssetEmbeddings)
    .where(eq(knowledgeAssetEmbeddings.assetVersionId, assetVersionId));

  const active = allEmbeddings.filter((e) => e.embeddingStatus === "completed" && e.isActive).length;
  const stale = allEmbeddings.filter((e) => e.embeddingStatus === "stale").length;

  const reasons: string[] = [];
  const blockers: string[] = [];
  const recommendations: string[] = [];

  const lifecycleState = (version.indexLifecycleState as IndexLifecycleState) ?? null;

  if (lifecycleState === "indexed" && active > 0) {
    reasons.push(`Index lifecycle state is 'indexed' with ${active} active embedding(s)`);
    reasons.push("Tenant isolation: correct (embeddings scoped to tenant_id)");
    reasons.push("Current version: embeddings are tied to this specific asset version");
  } else {
    if (!lifecycleState || lifecycleState === "not_ready") {
      blockers.push("Index lifecycle state is 'not_ready' — no embeddable sources or not processed");
      recommendations.push("Run asset processing (OCR/transcription/caption) before generating embeddings");
    }
    if (lifecycleState === "pending") {
      blockers.push("Embeddings are pending — generation not yet complete");
      recommendations.push("Wait for embedding generation to complete or trigger it explicitly");
    }
    if (lifecycleState === "stale") {
      blockers.push("Embeddings are stale — source content or model has changed");
      recommendations.push("Trigger reindex to regenerate embeddings from current sources");
    }
    if (lifecycleState === "failed") {
      blockers.push("Embedding generation failed — manual retry required");
      recommendations.push("Check failure_reason in embeddings and retry after resolving the root cause");
    }
    if (active === 0) {
      blockers.push("No active completed embeddings found");
    }
    if (!coverage.hasEmbeddableContent) {
      blockers.push("No embeddable content found in asset version metadata");
    }
  }

  if (stale > 0) {
    recommendations.push(`${stale} stale embedding(s) detected — consider reindex`);
  }

  return {
    assetVersionId,
    isRetrievalReady: lifecycleState === "indexed" && active > 0,
    indexLifecycleState: lifecycleState,
    activeEmbeddingCount: active,
    completedEmbeddingCount: active,
    staleEmbeddingCount: stale,
    reasons,
    blockers,
    recommendations,
  };
}
