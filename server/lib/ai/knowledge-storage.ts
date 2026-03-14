/**
 * knowledge-storage.ts — Phase 5G + Phase 5J
 * Service layer for the physical storage object registry (asset_storage_objects).
 * Distinct from Phase 5B knowledge_storage_objects (document-version-linked).
 *
 * Design contracts:
 * - No actual R2/S3/Supabase integration in this phase — DB registry only.
 * - storage_class transitions are explicit.
 * - Dedup preparation: checksum_sha256 is indexed per tenant for future lookups.
 * - Tenant isolation is enforced on every query.
 */

import { and, eq, desc, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  assetStorageObjects,
  type InsertAssetStorageObject,
  type AssetStorageObject,
} from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const STORAGE_PROVIDERS = ["r2", "s3", "supabase", "local"] as const;
export const STORAGE_CLASSES = ["hot", "cold", "archive", "deleted"] as const;

export type StorageProvider = typeof STORAGE_PROVIDERS[number];
export type StorageClass = typeof STORAGE_CLASSES[number];

// ─── registerStorageObject ────────────────────────────────────────────────────

export async function registerStorageObject(
  input: InsertAssetStorageObject,
): Promise<AssetStorageObject> {
  if (!STORAGE_PROVIDERS.includes(input.storageProvider as StorageProvider)) {
    throw new Error(`Invalid storage_provider: ${input.storageProvider}. Allowed: ${STORAGE_PROVIDERS.join(", ")}`);
  }
  if (input.storageClass && !STORAGE_CLASSES.includes(input.storageClass as StorageClass)) {
    throw new Error(`Invalid storage_class: ${input.storageClass}. Allowed: ${STORAGE_CLASSES.join(", ")}`);
  }
  if (input.sizeBytes < 0) {
    throw new Error("size_bytes must be >= 0");
  }

  const [row] = await db.insert(assetStorageObjects).values(input).returning();
  return row;
}

// ─── getStorageObjectById ─────────────────────────────────────────────────────

export async function getStorageObjectById(
  objectId: string,
  tenantId: string,
): Promise<AssetStorageObject | null> {
  const [row] = await db
    .select()
    .from(assetStorageObjects)
    .where(
      and(
        eq(assetStorageObjects.id, objectId),
        eq(assetStorageObjects.tenantId, tenantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── listStorageObjectsByTenant ───────────────────────────────────────────────

export async function listStorageObjectsByTenant(
  tenantId: string,
  options?: {
    storageClass?: StorageClass;
    storageProvider?: StorageProvider;
    excludeDeleted?: boolean;
    limit?: number;
  },
): Promise<AssetStorageObject[]> {
  const conditions = [eq(assetStorageObjects.tenantId, tenantId)];

  if (options?.storageClass) {
    conditions.push(eq(assetStorageObjects.storageClass, options.storageClass));
  }
  if (options?.storageProvider) {
    conditions.push(eq(assetStorageObjects.storageProvider, options.storageProvider));
  }
  if (options?.excludeDeleted) {
    conditions.push(isNull(assetStorageObjects.deletedAt));
  }

  return db
    .select()
    .from(assetStorageObjects)
    .where(and(...conditions))
    .orderBy(desc(assetStorageObjects.createdAt))
    .limit(options?.limit ?? 100);
}

// ─── markStorageObjectArchived ────────────────────────────────────────────────

export async function markStorageObjectArchived(
  objectId: string,
  tenantId: string,
): Promise<AssetStorageObject> {
  const obj = await getStorageObjectById(objectId, tenantId);
  if (!obj) throw new Error(`Storage object not found: ${objectId}`);
  if (obj.deletedAt) throw new Error(`Cannot archive deleted storage object: ${objectId}`);
  if (obj.archivedAt) throw new Error(`Cannot archive already-archived storage object: ${objectId}`);

  const [updated] = await db
    .update(assetStorageObjects)
    .set({ storageClass: "archive", archivedAt: new Date() })
    .where(
      and(
        eq(assetStorageObjects.id, objectId),
        eq(assetStorageObjects.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── markStorageObjectDeleted ─────────────────────────────────────────────────

export async function markStorageObjectDeleted(
  objectId: string,
  tenantId: string,
): Promise<AssetStorageObject> {
  const obj = await getStorageObjectById(objectId, tenantId);
  if (!obj) throw new Error(`Storage object not found: ${objectId}`);

  const [updated] = await db
    .update(assetStorageObjects)
    .set({ storageClass: "deleted", deletedAt: new Date() })
    .where(
      and(
        eq(assetStorageObjects.id, objectId),
        eq(assetStorageObjects.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── Phase 5J additions ───────────────────────────────────────────────────────

export interface RegisterKnowledgeStorageObjectInput {
  tenantId: string;
  storageProvider: StorageProvider;
  bucketName: string;
  objectKey: string;
  storageClass?: StorageClass;
  sizeBytes: number;
  mimeType?: string;
  checksumSha256?: string;
  uploadedAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Phase 5J: Register a storage object — enforces tenant isolation via unique constraint.
 * Use findKnowledgeStorageObjectByLocation first if you want to reuse an existing row.
 *
 * INV-ING5: tenantId required
 * INV-ING6: unique constraint prevents cross-tenant collision
 */
export async function registerKnowledgeStorageObject(
  input: RegisterKnowledgeStorageObjectInput,
): Promise<AssetStorageObject> {
  if (!input.tenantId) throw new Error("tenantId is required (INV-ING5)");
  if (!input.bucketName) throw new Error("bucketName is required");
  if (!input.objectKey) throw new Error("objectKey is required");
  if (!input.storageProvider) throw new Error("storageProvider is required");
  if (input.sizeBytes < 0) throw new Error("sizeBytes must be >= 0");

  if (!STORAGE_PROVIDERS.includes(input.storageProvider as StorageProvider)) {
    throw new Error(`Invalid storageProvider: ${input.storageProvider}. Allowed: ${STORAGE_PROVIDERS.join(", ")}`);
  }

  const [obj] = await db
    .insert(assetStorageObjects)
    .values({
      tenantId: input.tenantId,
      storageProvider: input.storageProvider,
      bucketName: input.bucketName,
      objectKey: input.objectKey,
      storageClass: input.storageClass ?? "hot",
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType ?? null,
      checksumSha256: input.checksumSha256 ?? null,
      uploadedAt: input.uploadedAt ?? null,
      metadata: (input.metadata ?? null) as any,
    })
    .returning();

  return obj;
}

/**
 * Phase 5J: Get storage object by ID with tenant scope.
 * Named alias for getStorageObjectById.
 */
export async function getKnowledgeStorageObjectById(
  id: string,
  tenantId: string,
): Promise<AssetStorageObject | null> {
  return getStorageObjectById(id, tenantId);
}

/**
 * Phase 5J: Find storage object by tenant + bucket + key (exact location).
 * Returns null if not found for this tenant.
 *
 * INV-ING6: tenant-scoped lookup only
 */
export async function findKnowledgeStorageObjectByLocation(
  tenantId: string,
  bucketName: string,
  objectKey: string,
): Promise<AssetStorageObject | null> {
  const [obj] = await db
    .select()
    .from(assetStorageObjects)
    .where(
      and(
        eq(assetStorageObjects.tenantId, tenantId),
        eq(assetStorageObjects.bucketName, bucketName),
        eq(assetStorageObjects.objectKey, objectKey),
      ),
    )
    .limit(1);
  return obj ?? null;
}

/**
 * Phase 5J: Synchronous explain for a loaded storage object.
 * Does not perform a DB lookup — caller must load first.
 */
export function explainKnowledgeStorageObjectData(
  obj: AssetStorageObject,
): Record<string, unknown> {
  const isDeleted = obj.storageClass === "deleted" || obj.deletedAt !== null;
  const isArchived = (obj.storageClass === "archive" || obj.archivedAt !== null) && !isDeleted;
  const isUsable = !isDeleted;

  return {
    id: obj.id,
    tenantId: obj.tenantId,
    storageProvider: obj.storageProvider,
    bucketName: obj.bucketName,
    objectKey: obj.objectKey,
    location: `${obj.bucketName}/${obj.objectKey}`,
    storageClass: obj.storageClass,
    sizeBytes: obj.sizeBytes,
    mimeType: obj.mimeType ?? null,
    checksumSha256: obj.checksumSha256 ?? null,
    uploadedAt: (obj as any).uploadedAt ?? null,
    createdAt: obj.createdAt,
    archivedAt: obj.archivedAt ?? null,
    deletedAt: obj.deletedAt ?? null,
    isDeleted,
    isArchived,
    isUsableAsActiveVersion: isUsable,
    explanation: [
      `${obj.storageProvider}: ${obj.bucketName}/${obj.objectKey}`,
      `Class: ${obj.storageClass} | Deleted: ${isDeleted} | Archived: ${isArchived}`,
      isDeleted ? "WARNING: cannot bind as active version (INV-ING10)" : "Available for binding",
    ],
  };
}

/**
 * Phase 5J: Preview storage binding — no writes (INV-ING8).
 */
export async function previewStorageBinding(input: RegisterKnowledgeStorageObjectInput): Promise<{
  tenantId: string;
  bucketName: string;
  objectKey: string;
  storageProvider: string;
  storageClass: string;
  sizeBytes: number;
  existingObjectId: string | null;
  isNew: boolean;
  duplicateChecksumDetected: boolean;
  duplicateChecksumCount: number;
  wouldWrite: false;
}> {
  const existing = await findKnowledgeStorageObjectByLocation(
    input.tenantId,
    input.bucketName,
    input.objectKey,
  );

  let duplicateCount = 0;
  if (input.checksumSha256) {
    const dupes = await db
      .select()
      .from(assetStorageObjects)
      .where(
        and(
          eq(assetStorageObjects.tenantId, input.tenantId),
          eq(assetStorageObjects.checksumSha256, input.checksumSha256),
        ),
      );
    duplicateCount = dupes.length;
  }

  return {
    tenantId: input.tenantId,
    bucketName: input.bucketName,
    objectKey: input.objectKey,
    storageProvider: input.storageProvider,
    storageClass: input.storageClass ?? "hot",
    sizeBytes: input.sizeBytes,
    existingObjectId: existing?.id ?? null,
    isNew: existing === null,
    duplicateChecksumDetected: duplicateCount > 0,
    duplicateChecksumCount: duplicateCount,
    wouldWrite: false,
  };
}

// ─── explainStorageObject ─────────────────────────────────────────────────────

export async function explainStorageObject(
  objectId: string,
  tenantId: string,
): Promise<{
  object: AssetStorageObject;
  isActive: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  dedupReady: boolean;
  explanation: string[];
}> {
  const object = await getStorageObjectById(objectId, tenantId);
  if (!object) throw new Error(`Storage object not found: ${objectId}`);

  const isDeleted = object.deletedAt !== null;
  const isArchived = object.archivedAt !== null && !isDeleted;
  const isActive = !isDeleted && !isArchived;
  const dedupReady = object.checksumSha256 !== null && (object.checksumSha256?.length ?? 0) === 64;

  const explanation: string[] = [
    `AssetStorageObject ${objectId} | provider=${object.storageProvider} | class=${object.storageClass}`,
    `Bucket: ${object.bucketName} | Key: ${object.objectKey}`,
    `Size: ${object.sizeBytes} bytes | MIME: ${object.mimeType ?? "unknown"}`,
    `State: active=${isActive} archived=${isArchived} deleted=${isDeleted}`,
    `Dedup-ready (SHA-256 present and valid): ${dedupReady}`,
    `Tenant: ${object.tenantId}`,
  ];

  return { object, isActive, isArchived, isDeleted, dedupReady, explanation };
}
