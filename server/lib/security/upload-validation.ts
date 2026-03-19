/**
 * Phase 7 — Upload Validation & File Security
 * INV-SEC7: Upload validation must reject unsafe files.
 */

// ─── Allowed MIME types ───────────────────────────────────────────────────────

export const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  document: ["application/pdf", "text/plain", "text/csv", "application/json"],
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  spreadsheet: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ],
  code: ["text/plain", "application/json", "text/markdown"],
};

export const ALL_ALLOWED_TYPES = Array.from(
  new Set(Object.values(ALLOWED_MIME_TYPES).flat()),
);

// ─── Magic bytes ──────────────────────────────────────────────────────────────

const MAGIC_SIGNATURES: Array<{
  mimeType: string;
  bytes: number[];
  offset?: number;
}> = [
  { mimeType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mimeType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF...WEBP
  { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP (XLSX)
];

function checkMagicBytes(buffer: Buffer, expectedMime: string): boolean {
  const sig = MAGIC_SIGNATURES.find((s) => s.mimeType === expectedMime);
  if (!sig) return true; // No signature known — allow (text/plain, JSON, etc.)
  const offset = sig.offset ?? 0;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

// ─── PDF bomb protection ──────────────────────────────────────────────────────

function hasPdfBombPattern(content: string): boolean {
  const objectMatches = (content.match(/\d+ \d+ obj/g) ?? []).length;
  if (objectMatches > 10000) return true;
  const streamMatches = (content.match(/stream\r?\n/g) ?? []).length;
  if (streamMatches > 1000) return true;
  return false;
}

// ─── ZIP bomb protection ──────────────────────────────────────────────────────

function isZipBomb(buffer: Buffer): boolean {
  // Basic check: compressed size vs buffer size ratio
  // A real implementation would parse the ZIP end-of-central-directory record.
  // Here we check if the first 4 bytes are PK signature and flag > 100:1 suspicious content.
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    // Read uncompressed size from local file header (offset 22, 4 bytes LE)
    if (buffer.length >= 26) {
      const uncompressedSize = buffer.readUInt32LE(22);
      const ratio = uncompressedSize / buffer.length;
      if (ratio > 500) return true;
    }
  }
  return false;
}

// ─── SVG sanitization ────────────────────────────────────────────────────────

function isSvgSafe(content: string): { safe: boolean; reason?: string } {
  const lower = content.toLowerCase();
  const dangerous = ["<script", "javascript:", "on error", "onload", "onerror", "eval(", "<iframe", "<object"];
  for (const d of dangerous) {
    if (lower.includes(d)) return { safe: false, reason: `SVG contains dangerous pattern: ${d}` };
  }
  return { safe: true };
}

// ─── validateUpload ───────────────────────────────────────────────────────────

export interface UploadValidationResult {
  valid: boolean;
  mimeType: string;
  fileSize: number;
  rejectionReason?: string;
  checks: {
    mimeTypeAllowed: boolean;
    magicBytesValid: boolean;
    sizeLimitOk: boolean;
    pdfBombClean: boolean;
    zipBombClean: boolean;
    svgSafe: boolean;
  };
  note: string;
}

export interface ValidateUploadParams {
  buffer: Buffer;
  claimedMimeType: string;
  filename?: string;
  maxSizeBytes?: number;
  allowedMimeTypes?: string[];
}

export function validateUpload(params: ValidateUploadParams): UploadValidationResult {
  const {
    buffer,
    claimedMimeType,
    filename,
    maxSizeBytes = 10 * 1024 * 1024, // 10MB default
    allowedMimeTypes = ALL_ALLOWED_TYPES,
  } = params;

  const fileSize = buffer.length;
  const checks = {
    mimeTypeAllowed: false,
    magicBytesValid: false,
    sizeLimitOk: false,
    pdfBombClean: true,
    zipBombClean: true,
    svgSafe: true,
  };

  // 1. MIME type allowed
  checks.mimeTypeAllowed = allowedMimeTypes.includes(claimedMimeType);
  if (!checks.mimeTypeAllowed) {
    return {
      valid: false,
      mimeType: claimedMimeType,
      fileSize,
      rejectionReason: `MIME type not allowed: ${claimedMimeType}`,
      checks,
      note: "INV-SEC7: Upload rejected — MIME type not allowed.",
    };
  }

  // 2. File size
  checks.sizeLimitOk = fileSize <= maxSizeBytes;
  if (!checks.sizeLimitOk) {
    return {
      valid: false,
      mimeType: claimedMimeType,
      fileSize,
      rejectionReason: `File too large: ${fileSize} bytes (max ${maxSizeBytes})`,
      checks,
      note: "INV-SEC7: Upload rejected — size limit exceeded.",
    };
  }

  // 3. Magic bytes
  if (buffer.length >= 4) {
    checks.magicBytesValid = checkMagicBytes(buffer, claimedMimeType);
    if (!checks.magicBytesValid) {
      return {
        valid: false,
        mimeType: claimedMimeType,
        fileSize,
        rejectionReason: `Magic bytes do not match claimed MIME type: ${claimedMimeType}`,
        checks,
        note: "INV-SEC7: Upload rejected — magic byte mismatch.",
      };
    }
  } else {
    checks.magicBytesValid = true;
  }

  // 4. PDF bomb check
  if (claimedMimeType === "application/pdf") {
    const text = buffer.subarray(0, Math.min(buffer.length, 65536)).toString("utf8", 0, Math.min(buffer.length, 65536));
    checks.pdfBombClean = !hasPdfBombPattern(text);
    if (!checks.pdfBombClean) {
      return {
        valid: false,
        mimeType: claimedMimeType,
        fileSize,
        rejectionReason: "PDF bomb pattern detected",
        checks,
        note: "INV-SEC7: Upload rejected — PDF bomb protection.",
      };
    }
  }

  // 5. ZIP bomb check
  if (
    claimedMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    claimedMimeType === "application/zip"
  ) {
    checks.zipBombClean = !isZipBomb(buffer);
    if (!checks.zipBombClean) {
      return {
        valid: false,
        mimeType: claimedMimeType,
        fileSize,
        rejectionReason: "ZIP bomb pattern detected",
        checks,
        note: "INV-SEC7: Upload rejected — ZIP bomb protection.",
      };
    }
  }

  // 6. SVG sanitization
  if (claimedMimeType === "image/svg+xml" || filename?.endsWith(".svg")) {
    const content = buffer.toString("utf8");
    const svgCheck = isSvgSafe(content);
    checks.svgSafe = svgCheck.safe;
    if (!checks.svgSafe) {
      return {
        valid: false,
        mimeType: claimedMimeType,
        fileSize,
        rejectionReason: svgCheck.reason ?? "SVG contains dangerous content",
        checks,
        note: "INV-SEC7: Upload rejected — SVG sanitization failed.",
      };
    }
  }

  return {
    valid: true,
    mimeType: claimedMimeType,
    fileSize,
    checks,
    note: "INV-SEC7: All upload checks passed.",
  };
}

// ─── requestSizeLimitMiddleware ────────────────────────────────────────────────

export function requestSizeLimitMiddleware(opts: {
  maxJsonBytes?: number;
  maxMultipartBytes?: number;
}) {
  const maxJson = opts.maxJsonBytes ?? 1 * 1024 * 1024; // 1MB
  const maxMultipart = opts.maxMultipartBytes ?? 50 * 1024 * 1024; // 50MB

  return (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void => {
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
    const contentType = req.headers["content-type"] ?? "";

    if (contentType.includes("application/json") && contentLength > maxJson) {
      res.status(413).json({
        error: "Request body too large",
        maxBytes: maxJson,
        receivedBytes: contentLength,
        reasonCode: "REQUEST_TOO_LARGE",
      });
      return;
    }

    if (contentType.includes("multipart/") && contentLength > maxMultipart) {
      res.status(413).json({
        error: "Upload too large",
        maxBytes: maxMultipart,
        receivedBytes: contentLength,
        reasonCode: "UPLOAD_TOO_LARGE",
      });
      return;
    }

    next();
  };
}
