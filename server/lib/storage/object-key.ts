/**
 * Phase 46 — Tenant-Scoped Object Key Generation
 *
 * Clients NEVER choose object keys.
 * All keys are generated server-side with deterministic tenant-safe structure.
 *
 * Pattern:
 *   org/{organization_id}/{category_path}/{file_id}.{ext}
 *
 * Examples:
 *   org/abc123/checkins/clients/cli456/file_uuid.jpg
 *   org/abc123/documents/clients/cli456/file_uuid.pdf
 *   org/abc123/program-assets/file_uuid.mp4
 *   org/abc123/exports/2026/03/file_uuid.csv
 *   org/abc123/ai-imports/file_uuid.txt
 *   platform/system/backups/2026/03/file_uuid.json
 */

import { randomUUID } from "crypto";
import type { StorageCategory } from "./storage-policy";

// ─────────────────────────────────────────────────────────────────────────────
// MIME → extension map
// ─────────────────────────────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg":         "jpg",
  "image/png":          "png",
  "image/webp":         "webp",
  "image/heic":         "heic",
  "image/svg+xml":      "svg",
  "video/mp4":          "mp4",
  "video/webm":         "webm",
  "application/pdf":    "pdf",
  "application/json":   "json",
  "application/gzip":   "gz",
  "application/zip":    "zip",
  "application/octet-stream": "bin",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain":         "txt",
  "text/csv":           "csv",
  "text/markdown":      "md",
};

const SAFE_EXT_PATTERN = /^[a-z0-9]{1,10}$/;
const SAFE_PATH_COMPONENT = /^[a-zA-Z0-9_\-]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateKeyOptions {
  organizationId: string;
  category:       StorageCategory;
  mimeType:       string;
  clientId?:      string;
  fileId?:        string;
}

/**
 * Generate a tenant-scoped, server-controlled object key.
 * Returns { objectKey, fileId }
 */
export function generateObjectKey(opts: GenerateKeyOptions): { objectKey: string; fileId: string } {
  assertSafePathComponent(opts.organizationId, "organizationId");
  if (opts.clientId) assertSafePathComponent(opts.clientId, "clientId");

  const fileId = opts.fileId ?? randomUUID();
  const ext    = normalizeExtension(opts.mimeType);
  const now    = new Date();
  const yyyy   = now.getUTCFullYear();
  const mm     = String(now.getUTCMonth() + 1).padStart(2, "0");

  let key: string;

  switch (opts.category) {
    case "checkin_photo":
      if (!opts.clientId) throw new ObjectKeyError("checkin_photo requires clientId");
      key = `org/${opts.organizationId}/checkins/clients/${opts.clientId}/${fileId}.${ext}`;
      break;

    case "client_document":
      if (!opts.clientId) throw new ObjectKeyError("client_document requires clientId");
      key = `org/${opts.organizationId}/documents/clients/${opts.clientId}/${fileId}.${ext}`;
      break;

    case "program_asset":
      key = `org/${opts.organizationId}/program-assets/${fileId}.${ext}`;
      break;

    case "export":
      key = `org/${opts.organizationId}/exports/${yyyy}/${mm}/${fileId}.${ext}`;
      break;

    case "system_backup":
      // System backups are not org-scoped — they live under platform/system
      key = `platform/system/backups/${yyyy}/${mm}/${fileId}.${ext}`;
      break;

    case "ai_import":
      key = `org/${opts.organizationId}/ai-imports/${fileId}.${ext}`;
      break;

    default:
      throw new ObjectKeyError(`Unknown category: ${opts.category}`);
  }

  assertSafeObjectKey(key);
  return { objectKey: key, fileId };
}

/**
 * Normalize MIME type to a safe file extension.
 * Falls back to filename extension, then "bin".
 */
export function normalizeExtension(mimeType: string, fallbackFilename?: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  const fromMime   = MIME_TO_EXT[normalized];
  if (fromMime) return fromMime;

  // Fallback: extract from original filename if safe
  if (fallbackFilename) {
    const parts = fallbackFilename.split(".");
    if (parts.length > 1) {
      const ext = parts[parts.length - 1].toLowerCase().slice(0, 10);
      if (SAFE_EXT_PATTERN.test(ext)) return ext;
    }
  }

  return "bin";
}

/**
 * Validate that an object key only contains safe characters and structure.
 * Prevents path traversal, null bytes, and uncontrolled key formats.
 */
export function assertSafeObjectKey(key: string): void {
  if (!key || key.length === 0) throw new ObjectKeyError("Object key must not be empty");
  if (key.length > 1024)        throw new ObjectKeyError("Object key too long (max 1024 chars)");
  if (key.includes(".."))       throw new ObjectKeyError("Object key must not contain '..'");
  if (key.includes("\0"))       throw new ObjectKeyError("Object key must not contain null bytes");
  if (key.startsWith("/"))      throw new ObjectKeyError("Object key must not start with '/'");
  if (!/^[a-zA-Z0-9_\-./]+$/.test(key)) {
    throw new ObjectKeyError(`Object key contains invalid characters: ${key}`);
  }
}

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectKeyError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function assertSafePathComponent(value: string, field: string): void {
  if (!SAFE_PATH_COMPONENT.test(value)) {
    throw new ObjectKeyError(
      `Unsafe ${field}: '${value}' — must match [a-zA-Z0-9_-]{1,128}`
    );
  }
}
