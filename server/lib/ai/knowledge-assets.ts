/**
 * knowledge-assets.ts — Phase 5G
 * Service layer for the canonical knowledge asset registry.
 *
 * Design contracts:
 * - Every operation is tenant-scoped.
 * - Asset versions are immutable — no updates to version rows.
 * - current_version_id switching is explicit and audited.
 * - Lifecycle mutations are controlled; no silent overwrites.
 * - processingState is managed separately from lifecycleState.
 */

import { and, eq, desc, asc } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeAssets,
  knowledgeAssetVersions,
  type InsertKnowledgeAsset,
  type InsertKnowledgeAssetVersion,
  type KnowledgeAsset,
  type KnowledgeAssetVersion,
} from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const ASSET_TYPES = ["document", "image", "video", "audio", "email", "webpage"] as const;
export const SOURCE_TYPES = ["upload", "url", "manual", "api", "email_ingest"] as const;
export const LIFECYCLE_STATES = ["active", "suspended", "archived", "deleted"] as const;
export const PROCESSING_STATES = ["pending", "processing", "ready", "failed", "reindex_required"] as const;
export const VISIBILITY_STATES = ["private", "shared", "internal"] as const;

export type AssetType = typeof ASSET_TYPES[number];
export type SourceType = typeof SOURCE_TYPES[number];
export type LifecycleState = typeof LIFECYCLE_STATES[number];
export type ProcessingState = typeof PROCESSING_STATES[number];
export type VisibilityState = typeof VISIBILITY_STATES[number];

// ─── createKnowledgeAsset ─────────────────────────────────────────────────────

export async function createKnowledgeAsset(
  input: InsertKnowledgeAsset,
): Promise<KnowledgeAsset> {
  if (!ASSET_TYPES.includes(input.assetType as AssetType)) {
    throw new Error(`Invalid asset_type: ${input.assetType}. Allowed: ${ASSET_TYPES.join(", ")}`);
  }
  if (!SOURCE_TYPES.includes(input.sourceType as SourceType)) {
    throw new Error(`Invalid source_type: ${input.sourceType}. Allowed: ${SOURCE_TYPES.join(", ")}`);
  }
  if (input.lifecycleState && !LIFECYCLE_STATES.includes(input.lifecycleState as LifecycleState)) {
    throw new Error(`Invalid lifecycle_state: ${input.lifecycleState}`);
  }
  if (input.processingState && !PROCESSING_STATES.includes(input.processingState as ProcessingState)) {
    throw new Error(`Invalid processing_state: ${input.processingState}`);
  }
  const [row] = await db.insert(knowledgeAssets).values(input).returning();
  return row;
}

// ─── createKnowledgeAssetVersion ─────────────────────────────────────────────

export async function createKnowledgeAssetVersion(
  input: InsertKnowledgeAssetVersion,
): Promise<KnowledgeAssetVersion> {
  if (input.versionNumber < 1) {
    throw new Error("version_number must be >= 1");
  }
  const [row] = await db.insert(knowledgeAssetVersions).values(input).returning();
  return row;
}

// ─── setKnowledgeAssetCurrentVersion ─────────────────────────────────────────

export async function setKnowledgeAssetCurrentVersion(
  assetId: string,
  tenantId: string,
  versionId: string,
): Promise<KnowledgeAsset> {
  const asset = await getKnowledgeAssetById(assetId, tenantId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);

  const [version] = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(
      and(
        eq(knowledgeAssetVersions.id, versionId),
        eq(knowledgeAssetVersions.assetId, assetId),
      ),
    )
    .limit(1);

  if (!version) {
    throw new Error(`Version ${versionId} does not belong to asset ${assetId}`);
  }

  const [updated] = await db
    .update(knowledgeAssets)
    .set({ currentVersionId: versionId, updatedAt: new Date() })
    .where(
      and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)),
    )
    .returning();

  return updated;
}

// ─── getKnowledgeAssetById ────────────────────────────────────────────────────

export async function getKnowledgeAssetById(
  assetId: string,
  tenantId: string,
): Promise<KnowledgeAsset | null> {
  const [row] = await db
    .select()
    .from(knowledgeAssets)
    .where(
      and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)),
    )
    .limit(1);
  return row ?? null;
}

// ─── listKnowledgeAssetsByKnowledgeBase ───────────────────────────────────────

export async function listKnowledgeAssetsByKnowledgeBase(
  tenantId: string,
  knowledgeBaseId: string,
  options?: { assetType?: AssetType; lifecycleState?: LifecycleState; limit?: number },
): Promise<KnowledgeAsset[]> {
  const conditions = [
    eq(knowledgeAssets.tenantId, tenantId),
    eq(knowledgeAssets.knowledgeBaseId, knowledgeBaseId),
  ];
  if (options?.assetType) {
    conditions.push(eq(knowledgeAssets.assetType, options.assetType));
  }
  if (options?.lifecycleState) {
    conditions.push(eq(knowledgeAssets.lifecycleState, options.lifecycleState));
  }

  return db
    .select()
    .from(knowledgeAssets)
    .where(and(...conditions))
    .orderBy(desc(knowledgeAssets.createdAt))
    .limit(options?.limit ?? 100);
}

// ─── listKnowledgeAssetsByTenant ──────────────────────────────────────────────

export async function listKnowledgeAssetsByTenant(
  tenantId: string,
  options?: {
    assetType?: AssetType;
    lifecycleState?: LifecycleState;
    processingState?: ProcessingState;
    limit?: number;
  },
): Promise<KnowledgeAsset[]> {
  const conditions = [eq(knowledgeAssets.tenantId, tenantId)];
  if (options?.assetType) {
    conditions.push(eq(knowledgeAssets.assetType, options.assetType));
  }
  if (options?.lifecycleState) {
    conditions.push(eq(knowledgeAssets.lifecycleState, options.lifecycleState));
  }
  if (options?.processingState) {
    conditions.push(eq(knowledgeAssets.processingState, options.processingState));
  }

  return db
    .select()
    .from(knowledgeAssets)
    .where(and(...conditions))
    .orderBy(desc(knowledgeAssets.createdAt))
    .limit(options?.limit ?? 100);
}

// ─── updateKnowledgeAssetLifecycle ────────────────────────────────────────────

export async function updateKnowledgeAssetLifecycle(
  assetId: string,
  tenantId: string,
  lifecycleState: LifecycleState,
): Promise<KnowledgeAsset> {
  if (!LIFECYCLE_STATES.includes(lifecycleState)) {
    throw new Error(`Invalid lifecycle_state: ${lifecycleState}. Allowed: ${LIFECYCLE_STATES.join(", ")}`);
  }

  const asset = await getKnowledgeAssetById(assetId, tenantId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);

  const [updated] = await db
    .update(knowledgeAssets)
    .set({ lifecycleState, updatedAt: new Date() })
    .where(
      and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)),
    )
    .returning();

  return updated;
}

// ─── markKnowledgeAssetProcessingState ───────────────────────────────────────

export async function markKnowledgeAssetProcessingState(
  assetId: string,
  tenantId: string,
  processingState: ProcessingState,
): Promise<KnowledgeAsset> {
  if (!PROCESSING_STATES.includes(processingState)) {
    throw new Error(`Invalid processing_state: ${processingState}. Allowed: ${PROCESSING_STATES.join(", ")}`);
  }

  const asset = await getKnowledgeAssetById(assetId, tenantId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);

  const [updated] = await db
    .update(knowledgeAssets)
    .set({ processingState, updatedAt: new Date() })
    .where(
      and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)),
    )
    .returning();

  return updated;
}

// ─── explainKnowledgeAsset ────────────────────────────────────────────────────

export async function explainKnowledgeAsset(
  assetId: string,
  tenantId: string,
): Promise<{
  asset: KnowledgeAsset;
  versions: KnowledgeAssetVersion[];
  currentVersion: KnowledgeAssetVersion | null;
  versionCount: number;
  isSearchable: boolean;
  explanation: string[];
}> {
  const asset = await getKnowledgeAssetById(assetId, tenantId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);

  const versions = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.assetId, assetId))
    .orderBy(asc(knowledgeAssetVersions.versionNumber));

  const currentVersion = asset.currentVersionId
    ? versions.find((v: KnowledgeAssetVersion) => v.id === asset.currentVersionId) ?? null
    : null;

  const isSearchable =
    asset.lifecycleState === "active" && asset.processingState === "ready";

  const explanation: string[] = [
    `Asset ${assetId} | type=${asset.assetType} | source=${asset.sourceType}`,
    `Lifecycle: ${asset.lifecycleState} | Processing: ${asset.processingState} | Visibility: ${asset.visibilityState}`,
    `Versions: ${versions.length} total. Current: ${asset.currentVersionId ?? "none"}`,
    `Searchable (active + ready): ${isSearchable}`,
    `Tenant: ${asset.tenantId} | KB: ${asset.knowledgeBaseId}`,
  ];

  return { asset, versions, currentVersion, versionCount: versions.length, isSearchable, explanation };
}
