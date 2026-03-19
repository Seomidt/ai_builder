/**
 * Phase 46 — Storage Category Policy Model
 *
 * Defines per-category upload and download rules.
 * Every upload must pass through policy enforcement before a signed URL is issued.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StorageCategory =
  | "checkin_photo"
  | "client_document"
  | "program_asset"
  | "export"
  | "system_backup"
  | "ai_import";

export type StorageVisibility = "private" | "tenant_internal";

export interface StoragePolicy {
  category:              StorageCategory;
  allowedMimeTypes:      string[];
  maxSizeBytes:          number;
  requiresClientId:      boolean;
  requiresMalwareScan:   boolean;
  visibility:            StorageVisibility;
  blockDownloadUntilClean: boolean;
  retentionHintDays:     number | null;
  allowedUploaderRoles:  string[];
  description:           string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy Definitions
// ─────────────────────────────────────────────────────────────────────────────

const POLICIES: Record<StorageCategory, StoragePolicy> = {
  checkin_photo: {
    category:              "checkin_photo",
    allowedMimeTypes:      ["image/jpeg", "image/png", "image/webp", "image/heic"],
    maxSizeBytes:          15 * 1024 * 1024, // 15 MB
    requiresClientId:      true,
    requiresMalwareScan:   true,
    visibility:            "private",
    blockDownloadUntilClean: true,
    retentionHintDays:     365 * 3, // 3 years
    allowedUploaderRoles:  ["coach", "admin", "client"],
    description:           "Client check-in photos — private, requires scan, client-scoped",
  },
  client_document: {
    category:              "client_document",
    allowedMimeTypes:      [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "image/jpeg",
      "image/png",
    ],
    maxSizeBytes:          25 * 1024 * 1024, // 25 MB
    requiresClientId:      true,
    requiresMalwareScan:   true,
    visibility:            "private",
    blockDownloadUntilClean: true,
    retentionHintDays:     365 * 7, // 7 years (GDPR retention)
    allowedUploaderRoles:  ["coach", "admin"],
    description:           "Client documents — private, requires scan, client-scoped",
  },
  program_asset: {
    category:              "program_asset",
    allowedMimeTypes:      [
      "image/jpeg", "image/png", "image/webp", "image/svg+xml",
      "video/mp4", "video/webm",
      "application/pdf",
      "text/plain",
    ],
    maxSizeBytes:          200 * 1024 * 1024, // 200 MB
    requiresClientId:      false,
    requiresMalwareScan:   false,
    visibility:            "tenant_internal",
    blockDownloadUntilClean: false,
    retentionHintDays:     null, // retained as long as program exists
    allowedUploaderRoles:  ["coach", "admin"],
    description:           "Program images, videos, documents — tenant_internal, no scan required",
  },
  export: {
    category:              "export",
    allowedMimeTypes:      [
      "text/csv",
      "application/json",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
    ],
    maxSizeBytes:          100 * 1024 * 1024, // 100 MB
    requiresClientId:      false,
    requiresMalwareScan:   false,
    visibility:            "private",
    blockDownloadUntilClean: false,
    retentionHintDays:     30, // auto-expire after 30 days
    allowedUploaderRoles:  ["admin", "service_role"],
    description:           "Data exports — private, generated server-side, short retention",
  },
  system_backup: {
    category:              "system_backup",
    allowedMimeTypes:      [
      "application/json",
      "application/octet-stream",
      "application/gzip",
      "application/zip",
    ],
    maxSizeBytes:          5 * 1024 * 1024 * 1024, // 5 GB
    requiresClientId:      false,
    requiresMalwareScan:   false,
    visibility:            "private",
    blockDownloadUntilClean: false,
    retentionHintDays:     90,
    allowedUploaderRoles:  ["service_role"],
    description:           "System backups — service_role only, no tenant access",
  },
  ai_import: {
    category:              "ai_import",
    allowedMimeTypes:      [
      "text/plain",
      "text/csv",
      "application/json",
      "application/pdf",
      "text/markdown",
    ],
    maxSizeBytes:          50 * 1024 * 1024, // 50 MB
    requiresClientId:      false,
    requiresMalwareScan:   true,
    visibility:            "private",
    blockDownloadUntilClean: true,
    retentionHintDays:     180,
    allowedUploaderRoles:  ["admin", "coach", "service_role"],
    description:           "AI training/import data — private, requires scan before use",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getStoragePolicy(category: StorageCategory): StoragePolicy {
  return POLICIES[category];
}

export function getAllCategories(): StorageCategory[] {
  return Object.keys(POLICIES) as StorageCategory[];
}

export function isValidCategory(category: string): category is StorageCategory {
  return category in POLICIES;
}

export function categoryRequiresScan(category: StorageCategory): boolean {
  return POLICIES[category].requiresMalwareScan;
}

export function categoryBlocksDownloadUntilClean(category: StorageCategory): boolean {
  return POLICIES[category].blockDownloadUntilClean;
}

export function assertStorageUploadAllowed(
  category:     StorageCategory,
  mimeType:     string,
  sizeBytes:    number,
  uploaderRole: string,
  hasClientId:  boolean,
): void {
  const policy = POLICIES[category];

  assertMimeAllowed(category, mimeType);
  assertSizeAllowed(category, sizeBytes);

  if (!policy.allowedUploaderRoles.includes(uploaderRole)) {
    throw new StoragePolicyError(
      `Role '${uploaderRole}' is not allowed to upload to category '${category}'. ` +
      `Allowed: ${policy.allowedUploaderRoles.join(", ")}`
    );
  }

  if (policy.requiresClientId && !hasClientId) {
    throw new StoragePolicyError(
      `Category '${category}' requires a client_id — none provided`
    );
  }
}

export function assertMimeAllowed(category: StorageCategory, mimeType: string): void {
  const policy = POLICIES[category];
  const normalized = normalizeMimeType(mimeType);
  if (!policy.allowedMimeTypes.includes(normalized)) {
    throw new StoragePolicyError(
      `MIME type '${normalized}' is not allowed for category '${category}'. ` +
      `Allowed: ${policy.allowedMimeTypes.join(", ")}`
    );
  }
}

export function assertSizeAllowed(category: StorageCategory, sizeBytes: number): void {
  const policy = POLICIES[category];
  if (sizeBytes > policy.maxSizeBytes) {
    throw new StoragePolicyError(
      `File size ${sizeBytes} bytes exceeds maximum ${policy.maxSizeBytes} bytes ` +
      `for category '${category}'`
    );
  }
  if (sizeBytes <= 0) {
    throw new StoragePolicyError("File size must be greater than 0");
  }
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

export class StoragePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePolicyError";
  }
}
