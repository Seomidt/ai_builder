/**
 * Phase 46 — Upload Integrity Validation
 *
 * Checksum, MIME verification, size validation.
 */

import { createHash } from "crypto";
import type { StorageCategory } from "./storage-policy";
import { assertMimeAllowed, assertSizeAllowed } from "./storage-policy";

// ─────────────────────────────────────────────────────────────────────────────
// Checksum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a buffer.
 * Used to verify integrity at rest and detect duplicate uploads.
 */
export function computeSha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify that a provided checksum matches the computed checksum of the data.
 */
export function verifyChecksum(data: Buffer, expectedChecksum: string): boolean {
  const actual = computeSha256(data);
  return actual === expectedChecksum;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize MIME type — strip parameters (e.g. "text/plain; charset=utf-8" → "text/plain").
 */
export function normalizeMimeType(mimeType: string): string {
  if (!mimeType || typeof mimeType !== "string") return "application/octet-stream";
  return mimeType.split(";")[0].trim().toLowerCase();
}

/**
 * Validate that a filename is safe (no path traversal, null bytes, overly long).
 */
export function assertSafeFilename(filename: string): void {
  if (!filename || filename.length === 0) {
    throw new IntegrityError("Filename must not be empty");
  }
  if (filename.length > 255) {
    throw new IntegrityError("Filename too long (max 255 chars)");
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new IntegrityError("Filename must not contain path separators");
  }
  if (filename.includes("\0")) {
    throw new IntegrityError("Filename must not contain null bytes");
  }
  if (filename.startsWith(".") && filename.length <= 1) {
    throw new IntegrityError("Filename must not be a bare dot");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full upload integrity assertion
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadIntegrityOptions {
  category:           StorageCategory;
  mimeType:           string;
  sizeBytes:          number;
  originalFilename:   string;
  providedChecksum?:  string;
  data?:              Buffer;
}

export interface UploadIntegrityResult {
  checksumSha256: string;
  normalizedMime: string;
  verified:       boolean;
}

/**
 * Assert all upload integrity requirements.
 * If `data` is provided, computes and optionally verifies checksum.
 * If only metadata is available (pre-upload), validates metadata only.
 */
export function assertUploadIntegrity(opts: UploadIntegrityOptions): UploadIntegrityResult {
  const normalizedMime = normalizeMimeType(opts.mimeType);

  assertSafeFilename(opts.originalFilename);
  assertMimeAllowed(opts.category, normalizedMime);
  assertSizeAllowed(opts.category, opts.sizeBytes);

  // Compute checksum from buffer if available
  if (opts.data) {
    const computed = computeSha256(opts.data);

    // If caller provided an expected checksum, verify it
    if (opts.providedChecksum && opts.providedChecksum !== computed) {
      throw new IntegrityError(
        `Checksum mismatch: expected ${opts.providedChecksum}, got ${computed}`
      );
    }

    // Verify size matches actual data
    if (opts.data.length !== opts.sizeBytes) {
      throw new IntegrityError(
        `Size mismatch: declared ${opts.sizeBytes} bytes, actual ${opts.data.length} bytes`
      );
    }

    return { checksumSha256: computed, normalizedMime, verified: true };
  }

  // Pre-upload metadata-only check: use provided checksum or placeholder
  const checksumSha256 = opts.providedChecksum ?? "pending";
  return { checksumSha256, normalizedMime, verified: false };
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
