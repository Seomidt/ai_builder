/**
 * knowledge-asset-ingestion.ts — Phase 5J
 * Asset Ingestion Service Layer
 *
 * Exposes the canonical ingestion API:
 *   ingestKnowledgeAsset()         — new asset + first version
 *   ingestKnowledgeAssetVersion()  — new version for existing asset
 *   previewKnowledgeAssetIngestion() — preview without writes (INV-ING8)
 *   setCurrentAssetVersion()       — switch current version safely
 *   explainKnowledgeAssetIngestion() — observability explain
 *   explainAssetProcessingPlan()   — pipeline plan for asset type + mime
 *
 * Invariant enforcement:
 *   INV-ING1:  Every request is tenant-scoped
 *   INV-ING2:  New asset requires valid KB scope
 *   INV-ING3:  Versions are immutable/append-only
 *   INV-ING4:  current_version_id only points to same-asset same-tenant version
 *   INV-ING5:  Storage linkage is tenant-safe
 *   INV-ING6:  No cross-tenant storage reuse
 *   INV-ING7:  Processing jobs enqueued only for correct asset+version
 *   INV-ING8:  Preview endpoints perform no writes
 *   INV-ING9:  Duplicate checksum is informational — no silent merge
 *   INV-ING10: Deleted storage objects cannot become active versions
 *   INV-ING11: Failure leaves no half-linked state
 *   INV-ING12: Existing retrieval/document systems are untouched
 */

import { eq, and, sql, max } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeAssets,
  knowledgeAssetVersions,
  knowledgeBases,
  assetStorageObjects,
  knowledgeAssetProcessingJobs,
  type KnowledgeAsset,
  type KnowledgeAssetVersion,
} from "@shared/schema";
import {
  registerKnowledgeStorageObject,
  findKnowledgeStorageObjectByLocation,
  getKnowledgeStorageObjectById,
  type StorageProvider,
  type StorageClass,
  type RegisterKnowledgeStorageObjectInput,
} from "./knowledge-storage";
import {
  enqueueAssetProcessingJob,
  listAssetProcessingJobs,
} from "./knowledge-asset-processing";
import {
  getPipelineForAssetType,
  getPipelineEntryJob,
} from "../../services/asset-processing/asset_processing_pipeline";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type IngestStatus = "pending" | "registered" | "processing" | "ready" | "failed";

export interface StorageRegistrationInput {
  storageProvider: StorageProvider;
  bucketName: string;
  objectKey: string;
  storageClass?: StorageClass;
  sizeBytes: number;
  mimeType?: string;
  checksumSha256?: string;
  uploadedAt?: Date;
}

export interface IngestKnowledgeAssetInput {
  tenantId: string;
  knowledgeBaseId: string;
  assetType: string;
  sourceType: string;
  title?: string;
  storage: StorageRegistrationInput;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  autoSetCurrent?: boolean;
  autoEnqueueProcessing?: boolean;
}

export interface IngestKnowledgeAssetVersionInput {
  tenantId: string;
  assetId: string;
  storage: StorageRegistrationInput;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  autoSetCurrent?: boolean;
  autoEnqueueProcessing?: boolean;
}

export interface IngestionResult {
  success: boolean;
  assetId: string;
  versionId: string;
  versionNumber: number;
  storageObjectId: string;
  isNewAsset: boolean;
  currentVersionSet: boolean;
  processingJobsEnqueued: number;
  processingEntryJobType: string | null;
  ingestStatus: IngestStatus;
  duplicateChecksumDetected: boolean;
  existingStorageObjectReused: boolean;
  processingPlan: ProcessingPlanExplanation;
  errorMessage?: string;
}

export interface ProcessingPlanStep {
  jobType: string;
  position: number;
  status: "active" | "planned_not_active";
  isEntryPoint: boolean;
}

export interface ProcessingPlanExplanation {
  assetType: string;
  mimeType: string | null;
  sourceType: string | null;
  totalSteps: number;
  activeSteps: number;
  plannedSteps: number;
  entryJobType: string | null;
  steps: ProcessingPlanStep[];
  skippedFutureProcessors: string[];
}

// ─── Active job types from Phase 5I ──────────────────────────────────────────

const ACTIVE_JOB_TYPES = new Set([
  "parse_document",
  "chunk_text",
  "embed_text",
  "index_asset",
  "ocr_image",
  "caption_image",
  "transcribe_audio",
]);

// Video processing jobs — planned, not yet active
const PLANNED_JOB_TYPES = new Set([
  "extract_video_metadata",
  "extract_audio",
  "sample_video_frames",
  "segment_video",
  "embed_image",
  "reindex_asset",
  "delete_index",
]);

// ─── explainAssetProcessingPlan ───────────────────────────────────────────────

/**
 * Explain the processing plan for an asset type + mime type.
 * Does NOT write anything (INV-ING8).
 */
export function explainAssetProcessingPlan(
  assetType: string,
  mimeType?: string | null,
  sourceType?: string | null,
): ProcessingPlanExplanation {
  const pipeline = getPipelineForAssetType(assetType);
  const steps: ProcessingPlanStep[] = pipeline.steps.map((jobType, idx) => ({
    jobType,
    position: idx + 1,
    status: ACTIVE_JOB_TYPES.has(jobType) ? "active" : "planned_not_active",
    isEntryPoint: idx === 0,
  }));

  const activeSteps = steps.filter((s) => s.status === "active");
  const plannedSteps = steps.filter((s) => s.status === "planned_not_active");
  const entryActive = activeSteps.length > 0 ? activeSteps[0] : null;

  return {
    assetType,
    mimeType: mimeType ?? null,
    sourceType: sourceType ?? null,
    totalSteps: steps.length,
    activeSteps: activeSteps.length,
    plannedSteps: plannedSteps.length,
    entryJobType: entryActive?.jobType ?? null,
    steps,
    skippedFutureProcessors: plannedSteps.map((s) => s.jobType),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function assertKnowledgeBaseExists(
  tenantId: string,
  knowledgeBaseId: string,
): Promise<void> {
  const [kb] = await db
    .select()
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, knowledgeBaseId),
        eq(knowledgeBases.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!kb) {
    throw new Error(
      `Knowledge base ${knowledgeBaseId} not found for tenant ${tenantId} (INV-ING2)`,
    );
  }
}

async function assertAssetExists(
  assetId: string,
  tenantId: string,
): Promise<KnowledgeAsset> {
  const [asset] = await db
    .select()
    .from(knowledgeAssets)
    .where(
      and(
        eq(knowledgeAssets.id, assetId),
        eq(knowledgeAssets.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!asset) {
    throw new Error(
      `Asset ${assetId} not found for tenant ${tenantId} (INV-ING1)`,
    );
  }
  return asset;
}

async function getNextVersionNumber(assetId: string): Promise<number> {
  const result = await db
    .select({ maxVersion: max(knowledgeAssetVersions.versionNumber) })
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.assetId, assetId));
  const currentMax = result[0]?.maxVersion ?? 0;
  return (currentMax as number) + 1;
}

async function resolveStorageObject(
  tenantId: string,
  storage: StorageRegistrationInput,
): Promise<{ storageObjectId: string; existingReused: boolean; duplicateChecksum: boolean }> {
  // Check for existing storage object at this location (same tenant)
  const existing = await findKnowledgeStorageObjectByLocation(
    tenantId,
    storage.bucketName,
    storage.objectKey,
  );

  if (existing) {
    // INV-ING10: reject deleted storage objects
    if (existing.storageClass === "deleted" || existing.deletedAt) {
      throw new Error(
        `Storage object at ${storage.bucketName}/${storage.objectKey} is deleted — cannot bind as version (INV-ING10)`,
      );
    }

    // Check for checksum duplicate detection (INV-ING9)
    let duplicateChecksum = false;
    if (storage.checksumSha256 && existing.checksumSha256 === storage.checksumSha256) {
      duplicateChecksum = true;
    }

    return { storageObjectId: existing.id, existingReused: true, duplicateChecksum };
  }

  // Register new storage object
  const newObj = await registerKnowledgeStorageObject({
    tenantId,
    storageProvider: storage.storageProvider,
    bucketName: storage.bucketName,
    objectKey: storage.objectKey,
    storageClass: storage.storageClass ?? "hot",
    sizeBytes: storage.sizeBytes,
    mimeType: storage.mimeType,
    checksumSha256: storage.checksumSha256,
    uploadedAt: storage.uploadedAt,
  });

  return { storageObjectId: newObj.id, existingReused: false, duplicateChecksum: false };
}

async function scheduleProcessingJobs(
  tenantId: string,
  assetId: string,
  versionId: string,
  assetType: string,
  createdBy?: string,
): Promise<{ count: number; entryJobType: string | null }> {
  const plan = explainAssetProcessingPlan(assetType);
  const entryJobType = plan.entryJobType;

  if (!entryJobType) {
    return { count: 0, entryJobType: null };
  }

  await enqueueAssetProcessingJob({
    tenantId,
    assetId,
    assetVersionId: versionId,
    jobType: entryJobType,
    metadata: {
      enqueuedBy: "ingestion-pipeline",
      createdBy: createdBy ?? null,
      pipeline: plan.steps.map((s) => s.jobType),
    },
  });

  return { count: 1, entryJobType };
}

// ─── ingestKnowledgeAsset ─────────────────────────────────────────────────────

/**
 * Full ingestion flow: create new asset + first version + optionally schedule processing.
 *
 * INV-ING1: tenantId required
 * INV-ING2: knowledgeBaseId required and validated
 * INV-ING3: version 1 is immutable
 * INV-ING5/6: storage resolved tenant-safely
 * INV-ING11: failure rolls back to clean state
 */
export async function ingestKnowledgeAsset(
  input: IngestKnowledgeAssetInput,
): Promise<IngestionResult> {
  if (!input.tenantId) throw new Error("tenantId is required (INV-ING1)");
  if (!input.knowledgeBaseId) throw new Error("knowledgeBaseId is required (INV-ING2)");
  if (!input.assetType) throw new Error("assetType is required");
  if (!input.sourceType) throw new Error("sourceType is required");

  // INV-ING2: validate KB scope
  await assertKnowledgeBaseExists(input.tenantId, input.knowledgeBaseId);

  // Resolve storage object (INV-ING5/6/10)
  const { storageObjectId, existingReused, duplicateChecksum } = await resolveStorageObject(
    input.tenantId,
    input.storage,
  );

  // Create asset
  const [asset] = await db
    .insert(knowledgeAssets)
    .values({
      tenantId: input.tenantId,
      knowledgeBaseId: input.knowledgeBaseId,
      assetType: input.assetType,
      sourceType: input.sourceType,
      title: input.title ?? null,
      processingState: "pending",
      lifecycleState: "active",
      metadata: (input.metadata ?? null) as any,
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
    })
    .returning();

  // Create first version (INV-ING3: immutable, version_number = 1)
  let version: KnowledgeAssetVersion;
  try {
    [version] = await db
      .insert(knowledgeAssetVersions)
      .values({
        assetId: asset.id,
        tenantId: input.tenantId,
        versionNumber: 1,
        storageObjectId,
        mimeType: input.storage.mimeType ?? null,
        sizeBytes: input.storage.sizeBytes,
        checksumSha256: input.storage.checksumSha256 ?? null,
        ingestStatus: "registered",
        metadata: (input.metadata ?? null) as any,
        createdBy: input.createdBy ?? null,
      })
      .returning();
  } catch (err: unknown) {
    // INV-ING11: clean up orphan asset if version creation fails
    await db.delete(knowledgeAssets).where(eq(knowledgeAssets.id, asset.id));
    throw new Error(
      `Version creation failed — asset rolled back: ${(err as Error).message}`,
    );
  }

  // Optionally set current version (INV-ING4)
  let currentVersionSet = false;
  if (input.autoSetCurrent !== false) {
    await db
      .update(knowledgeAssets)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(knowledgeAssets.id, asset.id));
    currentVersionSet = true;
  }

  // Optionally update ingest status and enqueue processing
  let jobsEnqueued = 0;
  let entryJobType: string | null = null;

  if (input.autoEnqueueProcessing !== false) {
    try {
      await db
        .update(knowledgeAssetVersions)
        .set({ ingestStatus: "processing" } as any)
        .where(eq(knowledgeAssetVersions.id, version.id));

      await db
        .update(knowledgeAssets)
        .set({ processingState: "processing", updatedAt: new Date() })
        .where(eq(knowledgeAssets.id, asset.id));

      const scheduled = await scheduleProcessingJobs(
        input.tenantId,
        asset.id,
        version.id,
        input.assetType,
        input.createdBy,
      );
      jobsEnqueued = scheduled.count;
      entryJobType = scheduled.entryJobType;
    } catch (err: unknown) {
      // Processing jobs failed — asset and version still exist but processing_state reflects reality
      await db
        .update(knowledgeAssets)
        .set({ processingState: "failed", updatedAt: new Date() })
        .where(eq(knowledgeAssets.id, asset.id));
      await db
        .update(knowledgeAssetVersions)
        .set({ ingestStatus: "failed" } as any)
        .where(eq(knowledgeAssetVersions.id, version.id));
    }
  } else {
    await db
      .update(knowledgeAssetVersions)
      .set({ ingestStatus: "registered" } as any)
      .where(eq(knowledgeAssetVersions.id, version.id));
  }

  const plan = explainAssetProcessingPlan(input.assetType, input.storage.mimeType, input.sourceType);

  return {
    success: true,
    assetId: asset.id,
    versionId: version.id,
    versionNumber: 1,
    storageObjectId,
    isNewAsset: true,
    currentVersionSet,
    processingJobsEnqueued: jobsEnqueued,
    processingEntryJobType: entryJobType,
    ingestStatus: jobsEnqueued > 0 ? "processing" : "registered",
    duplicateChecksumDetected: duplicateChecksum,
    existingStorageObjectReused: existingReused,
    processingPlan: plan,
  };
}

// ─── ingestKnowledgeAssetVersion ─────────────────────────────────────────────

/**
 * Add a new version to an existing asset.
 * INV-ING3: immutable append-only
 * INV-ING4: current_version_id safety
 */
export async function ingestKnowledgeAssetVersion(
  input: IngestKnowledgeAssetVersionInput,
): Promise<IngestionResult> {
  if (!input.tenantId) throw new Error("tenantId is required (INV-ING1)");
  if (!input.assetId) throw new Error("assetId is required");

  // Load and validate existing asset (INV-ING1)
  const asset = await assertAssetExists(input.assetId, input.tenantId);

  if (asset.lifecycleState === "deleted") {
    throw new Error(`Cannot add version to deleted asset: ${input.assetId}`);
  }

  // Resolve storage object (INV-ING5/6/10)
  const { storageObjectId, existingReused, duplicateChecksum } = await resolveStorageObject(
    input.tenantId,
    input.storage,
  );

  // Determine next version number (INV-ING3: monotonically increasing)
  const nextVersionNumber = await getNextVersionNumber(input.assetId);

  // Create version row (INV-ING3: immutable)
  const [version] = await db
    .insert(knowledgeAssetVersions)
    .values({
      assetId: input.assetId,
      tenantId: input.tenantId,
      versionNumber: nextVersionNumber,
      storageObjectId,
      mimeType: input.storage.mimeType ?? null,
      sizeBytes: input.storage.sizeBytes,
      checksumSha256: input.storage.checksumSha256 ?? null,
      ingestStatus: "registered",
      metadata: (input.metadata ?? null) as any,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  // Optionally set current version (INV-ING4: same asset + same tenant validated above)
  let currentVersionSet = false;
  if (input.autoSetCurrent) {
    await db
      .update(knowledgeAssets)
      .set({ currentVersionId: version.id, updatedAt: new Date(), updatedBy: input.createdBy ?? null } as any)
      .where(eq(knowledgeAssets.id, input.assetId));
    currentVersionSet = true;
  }

  // Optionally enqueue processing
  let jobsEnqueued = 0;
  let entryJobType: string | null = null;

  if (input.autoEnqueueProcessing !== false) {
    try {
      await db
        .update(knowledgeAssetVersions)
        .set({ ingestStatus: "processing" } as any)
        .where(eq(knowledgeAssetVersions.id, version.id));

      await db
        .update(knowledgeAssets)
        .set({ processingState: "processing", updatedAt: new Date() })
        .where(eq(knowledgeAssets.id, input.assetId));

      const scheduled = await scheduleProcessingJobs(
        input.tenantId,
        input.assetId,
        version.id,
        asset.assetType,
        input.createdBy,
      );
      jobsEnqueued = scheduled.count;
      entryJobType = scheduled.entryJobType;
    } catch {
      await db
        .update(knowledgeAssets)
        .set({ processingState: "failed", updatedAt: new Date() })
        .where(eq(knowledgeAssets.id, input.assetId));
      await db
        .update(knowledgeAssetVersions)
        .set({ ingestStatus: "failed" } as any)
        .where(eq(knowledgeAssetVersions.id, version.id));
    }
  }

  const plan = explainAssetProcessingPlan(asset.assetType, input.storage.mimeType, asset.sourceType);

  return {
    success: true,
    assetId: input.assetId,
    versionId: version.id,
    versionNumber: nextVersionNumber,
    storageObjectId,
    isNewAsset: false,
    currentVersionSet,
    processingJobsEnqueued: jobsEnqueued,
    processingEntryJobType: entryJobType,
    ingestStatus: jobsEnqueued > 0 ? "processing" : "registered",
    duplicateChecksumDetected: duplicateChecksum,
    existingStorageObjectReused: existingReused,
    processingPlan: plan,
  };
}

// ─── previewKnowledgeAssetIngestion ──────────────────────────────────────────

/**
 * Preview what would happen for a new asset ingestion.
 * INV-ING8: performs NO writes.
 */
export async function previewKnowledgeAssetIngestion(
  input: Partial<IngestKnowledgeAssetInput> & { tenantId: string },
): Promise<{
  wouldWrite: false;
  tenantId: string;
  knowledgeBaseId: string | null;
  kbExists: boolean;
  storageProvider: string | null;
  bucketName: string | null;
  objectKey: string | null;
  storageObjectExists: boolean;
  existingStorageObjectId: string | null;
  isDeletedStorageObject: boolean;
  duplicateChecksumCount: number;
  processingPlan: ProcessingPlanExplanation | null;
  validationErrors: string[];
}> {
  const errors: string[] = [];

  if (!input.tenantId) errors.push("tenantId is required");
  if (!input.knowledgeBaseId) errors.push("knowledgeBaseId is required");
  if (!input.assetType) errors.push("assetType is required");
  if (!input.sourceType) errors.push("sourceType is required");

  let kbExists = false;
  if (input.tenantId && input.knowledgeBaseId) {
    const [kb] = await db
      .select()
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.id, input.knowledgeBaseId),
          eq(knowledgeBases.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    kbExists = !!kb;
    if (!kbExists) errors.push(`Knowledge base ${input.knowledgeBaseId} not found for tenant ${input.tenantId}`);
  }

  let storageObjectExists = false;
  let existingStorageObjectId: string | null = null;
  let isDeletedStorageObject = false;
  let duplicateChecksumCount = 0;

  if (input.tenantId && input.storage?.bucketName && input.storage?.objectKey) {
    const existing = await findKnowledgeStorageObjectByLocation(
      input.tenantId,
      input.storage.bucketName,
      input.storage.objectKey,
    );
    if (existing) {
      storageObjectExists = true;
      existingStorageObjectId = existing.id;
      isDeletedStorageObject = existing.storageClass === "deleted" || !!existing.deletedAt;
      if (isDeletedStorageObject) {
        errors.push("Storage object is deleted — cannot bind (INV-ING10)");
      }
    }

    if (input.storage?.checksumSha256 && input.tenantId) {
      const dupes = await db
        .select()
        .from(assetStorageObjects)
        .where(
          and(
            eq(assetStorageObjects.tenantId, input.tenantId),
            eq(assetStorageObjects.checksumSha256, input.storage.checksumSha256),
          ),
        );
      duplicateChecksumCount = dupes.length;
    }
  }

  const plan = input.assetType
    ? explainAssetProcessingPlan(input.assetType, input.storage?.mimeType, input.sourceType)
    : null;

  return {
    wouldWrite: false,
    tenantId: input.tenantId,
    knowledgeBaseId: input.knowledgeBaseId ?? null,
    kbExists,
    storageProvider: input.storage?.storageProvider ?? null,
    bucketName: input.storage?.bucketName ?? null,
    objectKey: input.storage?.objectKey ?? null,
    storageObjectExists,
    existingStorageObjectId,
    isDeletedStorageObject,
    duplicateChecksumCount,
    processingPlan: plan,
    validationErrors: errors,
  };
}

// ─── setCurrentAssetVersion ───────────────────────────────────────────────────

/**
 * Safely set the current version for an asset.
 * INV-ING4: version must belong to the same asset + same tenant
 * INV-ING10: version's storage object must not be deleted
 */
export async function setCurrentAssetVersion(
  assetId: string,
  versionId: string,
  tenantId: string,
): Promise<KnowledgeAsset> {
  // Validate asset belongs to tenant
  const asset = await assertAssetExists(assetId, tenantId);

  // Validate version belongs to same asset (INV-ING4)
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
    throw new Error(
      `Version ${versionId} does not belong to asset ${assetId} (INV-ING4)`,
    );
  }

  // Check storage object is not deleted (INV-ING10)
  if (version.storageObjectId) {
    const storageObj = await getKnowledgeStorageObjectById(version.storageObjectId, tenantId);
    if (storageObj && (storageObj.storageClass === "deleted" || storageObj.deletedAt)) {
      throw new Error(
        `Storage object for version ${versionId} is deleted — cannot set as current version (INV-ING10)`,
      );
    }
  }

  const [updated] = await db
    .update(knowledgeAssets)
    .set({ currentVersionId: versionId, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeAssets.id, assetId),
        eq(knowledgeAssets.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── explainKnowledgeAssetIngestion ──────────────────────────────────────────

/**
 * Explain the ingestion state of an asset — full observability.
 */
export async function explainKnowledgeAssetIngestion(
  assetId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const asset = await assertAssetExists(assetId, tenantId);

  const versions = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.assetId, assetId))
    .orderBy(knowledgeAssetVersions.versionNumber);

  const jobs = await listAssetProcessingJobs(tenantId, { assetId });

  const jobsByStatus = jobs.reduce(
    (acc, j) => {
      acc[j.jobStatus] = (acc[j.jobStatus] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const plan = explainAssetProcessingPlan(
    asset.assetType,
    versions[versions.length - 1]?.mimeType,
    asset.sourceType,
  );

  return {
    assetId,
    tenantId,
    assetType: asset.assetType,
    sourceType: asset.sourceType,
    title: asset.title,
    lifecycleState: asset.lifecycleState,
    processingState: asset.processingState,
    currentVersionId: asset.currentVersionId,
    versionCount: versions.length,
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      ingestStatus: (v as any).ingestStatus ?? null,
      storageObjectId: v.storageObjectId,
      mimeType: v.mimeType,
      sizeBytes: v.sizeBytes,
      checksumSha256: v.checksumSha256,
      createdAt: v.createdAt,
    })),
    processingJobs: {
      total: jobs.length,
      byStatus: jobsByStatus,
    },
    processingPlan: plan,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    explanation: [
      `Asset ${assetId} — ${asset.assetType} (${asset.sourceType})`,
      `Lifecycle: ${asset.lifecycleState} | Processing: ${asset.processingState}`,
      `Versions: ${versions.length} | Current: ${asset.currentVersionId ?? "none"}`,
      `Jobs: ${jobs.length} total — ${JSON.stringify(jobsByStatus)}`,
    ],
  };
}

// ─── listKnowledgeAssetVersions ───────────────────────────────────────────────

export async function listKnowledgeAssetVersions(
  assetId: string,
  tenantId: string,
): Promise<KnowledgeAssetVersion[]> {
  // Validate asset belongs to tenant first
  await assertAssetExists(assetId, tenantId);

  return db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.assetId, assetId))
    .orderBy(knowledgeAssetVersions.versionNumber);
}
