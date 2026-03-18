/**
 * knowledge-asset-compat.ts — Phase 5G
 * Backward-compatibility and migration-explainability layer.
 *
 * This phase introduces a generalized asset registry alongside the existing
 * document-centric tables. This file provides helpers to:
 *   1. Explain the migration strategy from legacy document tables to asset registry.
 *   2. Preview how existing document rows map to future asset rows.
 *   3. Report on the current registry state.
 *
 * Design rules:
 * - No destructive changes to existing tables.
 * - No forced migration in Phase 5G.
 * - Coexistence: legacy document tables + new asset tables both remain valid.
 */

import { count, eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeDocuments,
  knowledgeBases,
  knowledgeAssets,
  knowledgeAssetVersions,
  assetStorageObjects,
  knowledgeAssetProcessingJobs,
  type KnowledgeDocument,
} from "@shared/schema";

// ─── explainDocumentToAssetMigrationStrategy ──────────────────────────────────

export function explainDocumentToAssetMigrationStrategy(): {
  strategy: string;
  phases: string[];
  mappings: Record<string, string>;
  warnings: string[];
  recommendation: string;
} {
  return {
    strategy: "additive-coexistence",
    phases: [
      "Phase 5G: New asset registry tables created alongside existing document tables. No migration performed.",
      "Phase 5H (future): Optional backfill — create knowledge_asset rows for each existing knowledge_document row.",
      "Phase 5I (future): knowledge_asset_versions linked to existing knowledge_document_versions.",
      "Phase 5J (future): knowledge_storage_objects (new) linked to legacy knowledge_storage_objects (old).",
      "Phase 5K (future): Deprecate direct document table access in retrieval layer; route through asset registry.",
      "Phase 5L (future): Legacy tables become read-only archive. No hard delete.",
    ],
    mappings: {
      "knowledge_documents.id":              "→ knowledge_assets.id (future backfill)",
      "knowledge_documents.tenant_id":        "→ knowledge_assets.tenant_id",
      "knowledge_documents.knowledge_base_id":"→ knowledge_assets.knowledge_base_id",
      "knowledge_documents.title":            "→ knowledge_assets.title",
      "knowledge_documents.document_status":  "→ knowledge_assets.processing_state (mapped: ready→ready, processing→processing, failed→failed)",
      "knowledge_documents.lifecycle_state":  "→ knowledge_assets.lifecycle_state (direct mapping)",
      "knowledge_document_versions.id":       "→ knowledge_asset_versions.id (future backfill)",
      "knowledge_document_versions.version_number": "→ knowledge_asset_versions.version_number",
      "knowledge_storage_objects (legacy)":   "→ knowledge_storage_objects (new) — separate provider-agnostic registry",
      "knowledge_processing_jobs (legacy)":   "→ knowledge_asset_processing_jobs (new) — multimodal job types",
    },
    warnings: [
      "Do NOT delete legacy document tables during or after Phase 5G.",
      "Do NOT assume knowledge_assets.id == knowledge_documents.id until backfill is explicitly run.",
      "Retrieval pipeline (Phase 5A–5F) continues to use legacy document tables unmodified.",
      "New multimodal assets (image, video, audio) must use the new asset registry exclusively.",
    ],
    recommendation:
      "Proceed with Phase 5G asset registry for all new (non-document) asset types. " +
      "Run the backfill migration only in a future dedicated phase with explicit tenant consent. " +
      "The retrieval pipeline remains document-table-based until the backfill is complete and validated.",
  };
}

// ─── previewLegacyDocumentCompatibility ──────────────────────────────────────

export async function previewLegacyDocumentCompatibility(
  tenantId: string,
  options?: { knowledgeBaseId?: string; limit?: number },
): Promise<{
  tenantId: string;
  legacyDocumentCount: number;
  newAssetCount: number;
  overlapNote: string;
  previewDocuments: Array<{
    documentId: string;
    title: string | null;
    lifecycleState: string;
    documentStatus: string;
    proposedAssetType: "document";
    proposedLifecycleState: string;
    proposedProcessingState: string;
  }>;
}> {
  const docConditions = [eq(knowledgeDocuments.tenantId, tenantId)];
  if (options?.knowledgeBaseId) {
    docConditions.push(eq(knowledgeDocuments.knowledgeBaseId, options.knowledgeBaseId));
  }

  const legacyDocs = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(...docConditions))
    .limit(options?.limit ?? 20);

  const assetCountResult = await db
    .select({ c: count() })
    .from(knowledgeAssets)
    .where(eq(knowledgeAssets.tenantId, tenantId));

  const newAssetCount = Number(assetCountResult[0]?.c ?? 0);

  const documentStatusToProcessingState: Record<string, string> = {
    pending:    "pending",
    processing: "processing",
    ready:      "ready",
    failed:     "failed",
    reindex:    "reindex_required",
  };

  const previewDocuments = legacyDocs.map((doc) => ({
    documentId: doc.id,
    title: doc.title ?? null,
    lifecycleState: doc.lifecycleState,
    documentStatus: doc.documentStatus,
    proposedAssetType: "document" as const,
    proposedLifecycleState: doc.lifecycleState,
    proposedProcessingState:
      documentStatusToProcessingState[doc.documentStatus] ?? "pending",
  }));

  return {
    tenantId,
    legacyDocumentCount: legacyDocs.length,
    newAssetCount,
    overlapNote:
      "Legacy documents and new assets coexist. No backfill performed in Phase 5G. " +
      "Backfill is a future phase operation.",
    previewDocuments,
  };
}

// ─── explainCurrentRegistryState ─────────────────────────────────────────────

export async function explainCurrentRegistryState(): Promise<{
  legacyTables: {
    knowledge_documents: number;
    knowledge_bases: number;
  };
  newAssetRegistryTables: {
    knowledge_assets: number;
    knowledge_asset_versions: number;
    knowledge_storage_objects: number;
    knowledge_asset_processing_jobs: number;
  };
  migrationPhase: string;
  readinessLevel: string;
  explanation: string[];
}> {
  const [docCount] = await db.select({ c: count() }).from(knowledgeDocuments);
  const [kbCount] = await db.select({ c: count() }).from(knowledgeBases);
  const [assetCount] = await db.select({ c: count() }).from(knowledgeAssets);
  const [versionCount] = await db.select({ c: count() }).from(knowledgeAssetVersions);
  const [storageCount] = await db.select({ c: count() }).from(assetStorageObjects);
  const [jobCount] = await db.select({ c: count() }).from(knowledgeAssetProcessingJobs);

  const legacyDocuments = Number(docCount?.c ?? 0);
  const newAssets = Number(assetCount?.c ?? 0);

  return {
    legacyTables: {
      knowledge_documents: legacyDocuments,
      knowledge_bases: Number(kbCount?.c ?? 0),
    },
    newAssetRegistryTables: {
      knowledge_assets: newAssets,
      knowledge_asset_versions: Number(versionCount?.c ?? 0),
      knowledge_storage_objects: Number(storageCount?.c ?? 0),
      knowledge_asset_processing_jobs: Number(jobCount?.c ?? 0),
    },
    migrationPhase: "5G — coexistence (no backfill performed)",
    readinessLevel:
      legacyDocuments > 0 && newAssets === 0
        ? "legacy-only"
        : newAssets > 0 && legacyDocuments > 0
        ? "mixed"
        : newAssets > 0
        ? "new-registry-only"
        : "empty",
    explanation: [
      `Legacy knowledge_documents: ${legacyDocuments}`,
      `New knowledge_assets: ${newAssets}`,
      `Asset versions: ${Number(versionCount?.c ?? 0)}`,
      `Storage objects (new registry): ${Number(storageCount?.c ?? 0)}`,
      `Asset processing jobs: ${Number(jobCount?.c ?? 0)}`,
      "Phase 5G strategy: additive coexistence — no destructive migration.",
      "Retrieval pipeline continues to use legacy document tables.",
      "New multimodal assets (image, video, audio) use asset registry only.",
    ],
  };
}
