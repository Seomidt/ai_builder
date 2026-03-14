/**
 * knowledge-storage.ts — Phase 5G
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
