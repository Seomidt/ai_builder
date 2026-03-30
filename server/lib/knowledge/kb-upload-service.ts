/**
 * KB Upload Service — Storage 1.8
 *
 * Owns all upload business logic for knowledge base assets.
 * Called by:
 *   - api/_src/kb.ts (Vercel thin handler, HTTP upload)
 *   - future: worker-driven ingestion, batch imports, chat-upload
 *
 * DESIGN PRINCIPLES:
 *   - No dependency on Express Request/Response or HTTP primitives
 *   - Inputs are plain data (Buffer + metadata), not HTTP objects
 *   - Self-contained idempotency: one source of truth for duplicate detection
 *   - All DB writes (document, version, storage object, jobs, chunks) in one place
 *   - Pipeline orchestration is centralized here, not scattered across routes
 *   - R2 upload, PDF extraction, inline chunking all owned by this service
 *
 * REUSE:
 *   To call from worker/batch: pass UploadInput directly, no HTTP layer needed.
 *   Caller is responsible for parsing multipart (if HTTP) or providing buffer directly.
 */

import { createHash } from "crypto";
import { db } from "../../db.ts";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeProcessingJobs,
  knowledgeStorageObjects,
  knowledgeChunks,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

// ── MIME type → document category map ────────────────────────────────────────
// Single source of truth for allowed MIME types across all ingestion paths.

export const ALLOWED_MIME_TYPES: Record<string, string> = {
  // Documents
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "text/plain": "document",
  "text/csv": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/rtf": "document",
  "text/html": "document",
  "text/markdown": "document",
  // Images
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/tiff": "image",
  "image/bmp": "image",
  // Video
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/x-msvideo": "video",
  "video/webm": "video",
  "video/mpeg": "video",
};

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// ── Input / Output types ──────────────────────────────────────────────────────

export interface UploadInput {
  tenantId: string;
  knowledgeBaseId: string;
  uploadedBy: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadResult {
  id: string;
  title: string;
  documentType: string;
  status: string;
  mimeType: string;
  fileSizeBytes: number;
  versionNumber: number;
  storageKey: string;
  pipeline: string[];
  chunksCreated: boolean;
  createdAt: Date;
  idempotent?: boolean;
}

// ── Typed service errors ──────────────────────────────────────────────────────
// Callers (HTTP handler, worker, batch) can switch on errorCode to decide
// which HTTP status or retry behavior to apply.

export class UploadServiceError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadServiceError";
  }
}

export const UPLOAD_ERRORS = {
  KB_NOT_FOUND:          "KB_NOT_FOUND",
  UNSUPPORTED_MIME:      "UNSUPPORTED_MIME",
  FILE_TOO_LARGE:        "FILE_TOO_LARGE",
} as const;

// ── Public service function ───────────────────────────────────────────────────

export async function uploadAssetToKb(input: UploadInput): Promise<UploadResult> {
  const { tenantId, knowledgeBaseId: kbId, uploadedBy, filename, mimeType, buffer } = input;

  // ── 1. Validate MIME type ──────────────────────────────────────────────────
  const documentType = ALLOWED_MIME_TYPES[mimeType] ?? "";
  if (!documentType) {
    throw new UploadServiceError(
      UPLOAD_ERRORS.UNSUPPORTED_MIME,
      `Filtypen "${mimeType}" understøttes ikke. Upload PDF, Word, Excel, billede eller video.`,
    );
  }

  // ── 2. Validate file size ──────────────────────────────────────────────────
  const sizeBytes = buffer.length;
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadServiceError(
      UPLOAD_ERRORS.FILE_TOO_LARGE,
      `Filen overstiger den maksimale størrelse på ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
  }

  // ── 3. Verify knowledge base belongs to tenant ─────────────────────────────
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenantId)));

  if (!kb) {
    throw new UploadServiceError(UPLOAD_ERRORS.KB_NOT_FOUND, "Datakilde ikke fundet");
  }

  // ── 4. Idempotency check ───────────────────────────────────────────────────
  // SHA-256 of (tenantId, kbId, filename, size, mimeType) — deterministic per upload attempt.
  const idempotencyKey = createHash("sha256")
    .update(`${tenantId}:${kbId}:${filename}:${sizeBytes}:${mimeType}`)
    .digest("hex");

  const existingJob = await db
    .select({
      id: knowledgeProcessingJobs.id,
      knowledgeDocumentId: knowledgeProcessingJobs.knowledgeDocumentId,
    })
    .from(knowledgeProcessingJobs)
    .where(eq(knowledgeProcessingJobs.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existingJob[0]) {
    const [existingDoc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, existingJob[0].knowledgeDocumentId));

    if (existingDoc) {
      return {
        id: existingDoc.id,
        title: existingDoc.title,
        documentType: existingDoc.documentType,
        status: existingDoc.documentStatus,
        mimeType,
        fileSizeBytes: sizeBytes,
        versionNumber: 1,
        storageKey: (existingDoc.metadata as { storageKey?: string })?.storageKey ?? "",
        pipeline: [],
        chunksCreated: false,
        createdAt: existingDoc.createdAt,
        idempotent: true,
      };
    }
  }

  // ── 5. Upload to R2 object storage ─────────────────────────────────────────
  const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, "-").slice(0, 200);
  const storageKey = `tenants/${tenantId}/uploads/${kbId}/${Date.now()}-${safeFilename}`;
  let r2Uploaded = false;
  let R2_BUCKET = "";

  const { R2_CONFIGURED, R2_BUCKET: bucket, r2Client } = await import("../r2/r2-client");
  R2_BUCKET = bucket;

  if (R2_CONFIGURED) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: mimeType,
      Metadata: { tenantId, kbId, originalFilename: filename },
    }));
    r2Uploaded = true;
    console.log(`[kb-upload] R2 OK: ${storageKey} (${sizeBytes} bytes)`);
  } else {
    console.warn("[kb-upload] R2 ikke konfigureret — gemmer kun metadata");
  }

  // ── 6. Synchronous text extraction (documents only) ───────────────────────
  // PDF: use pdf-parse for immediate text availability.
  // Plain text formats: read buffer directly.
  // Images/video: no synchronous extraction (handled by worker OCR/transcript jobs).
  let extractedText: string | null = null;

  if (documentType === "document") {
    if (mimeType === "application/pdf") {
      try {
        const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text?.trim() || null;
      } catch (pdfErr) {
        console.warn("[kb-upload] pdf-parse fejlede:", (pdfErr as Error).message);
      }
    } else if (["text/plain", "text/csv", "text/html", "text/markdown"].includes(mimeType)) {
      extractedText = buffer.toString("utf-8").trim();
    }
  }

  // ── 7. Create document record ──────────────────────────────────────────────
  const [doc] = await db.insert(knowledgeDocuments).values({
    tenantId,
    knowledgeBaseId: kbId,
    title: filename,
    documentType,
    sourceType: "upload",
    lifecycleState: "active",
    documentStatus: "processing",
    latestVersionNumber: 1,
    createdBy: uploadedBy,
    updatedBy: uploadedBy,
    metadata: { storageKey, originalFilename: filename } as never,
  }).returning();

  // ── 8. Create version record ───────────────────────────────────────────────
  const [ver] = await db.insert(knowledgeDocumentVersions).values({
    tenantId,
    knowledgeDocumentId: doc.id,
    versionNumber: 1,
    mimeType,
    fileSizeBytes: sizeBytes,
    isCurrent: true,
    versionStatus: "uploaded",
    sourceLabel: filename,
    uploadedAt: new Date(),
    createdBy: uploadedBy,
    parseStatus:      documentType === "document" ? "pending" : null,
    ocrStatus:        documentType === "image"    ? "pending" : null,
    transcriptStatus: documentType === "video"    ? "pending" : null,
    metadata: {
      storageKey,
      r2Uploaded,
      extractedText: extractedText ? extractedText.slice(0, 500) : null,
    } as never,
  }).returning();

  // Link current version back to document
  await db.update(knowledgeDocuments)
    .set({ currentVersionId: ver.id, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, doc.id));

  // ── 9. Create storage object record ───────────────────────────────────────
  await db.insert(knowledgeStorageObjects).values({
    tenantId,
    knowledgeDocumentVersionId: ver.id,
    storageProvider: r2Uploaded ? "r2" : "local",
    bucketName: r2Uploaded ? R2_BUCKET : null,
    objectKey: storageKey,
    originalFilename: filename,
    mimeType,
    fileSizeBytes: sizeBytes,
    uploadStatus: r2Uploaded ? "uploaded" : "pending",
    uploadedAt: r2Uploaded ? new Date() : null,
    metadata: { kbId, extractedLength: extractedText?.length ?? 0 } as never,
  });

  // ── 10. Build processing pipeline ─────────────────────────────────────────
  // Pipeline order: parse/ocr/transcript → chunk → embed → index
  // Documents where text was already extracted synchronously skip straight to chunk.
  const primaryJobType =
    documentType === "video" ? "transcript_parse" :
    documentType === "image" ? "ocr_parse" :
    "parse";

  const fullPipeline = [
    { jobType: primaryJobType,       priority: 100, payload: { documentType, mimeType, storageKey, stage: "extract" } },
    { jobType: "chunk",              priority: 90,  payload: { documentType, mimeType, storageKey, stage: "chunk",   dependsOn: primaryJobType } },
    { jobType: "embedding_generate", priority: 80,  payload: { documentType, mimeType, storageKey, stage: "embed",  dependsOn: "chunk" } },
    { jobType: "index",              priority: 70,  payload: { documentType, mimeType, storageKey, stage: "index",  dependsOn: "embedding_generate" } },
  ];

  // Skip parse step when text was already extracted (fast path for small plain docs)
  const skipParse = documentType === "document" && !!extractedText;
  const jobsToEnqueue = skipParse ? fullPipeline.slice(1) : fullPipeline;

  for (const j of jobsToEnqueue) {
    await db.insert(knowledgeProcessingJobs).values({
      tenantId,
      knowledgeDocumentId: doc.id,
      knowledgeDocumentVersionId: ver.id,
      jobType: j.jobType,
      status: "queued",
      priority: j.priority,
      idempotencyKey: j === jobsToEnqueue[0] ? idempotencyKey : null,
      payload: {
        ...j.payload,
        extractedText: j.jobType === "chunk" && extractedText ? extractedText : undefined,
      } as never,
    });
  }

  // ── 11. Inline chunking fast path ──────────────────────────────────────────
  // For small documents (<50KB text), create chunks immediately so the document
  // is searchable right away without waiting for the background worker.
  // This does NOT replace the worker — the chunk job is still enqueued for
  // consistency checking and embedding generation.
  let chunksCreated = false;

  if (extractedText && extractedText.length > 0 && extractedText.length < 50_000) {
    try {
      chunksCreated = await _inlineChunk({
        tenantId,
        kbId,
        docId: doc.id,
        versionId: ver.id,
        text: extractedText,
      });

      if (chunksCreated) {
        await db.update(knowledgeDocuments)
          .set({ documentStatus: "processing", updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, doc.id));
      }
    } catch (chunkErr) {
      console.warn("[kb-upload] Inline chunking fejlede (ikke kritisk):", (chunkErr as Error).message);
    }
  }

  console.log(
    `[kb-upload] ${tenantId}/${kbId}: "${filename}" (${documentType}, ${sizeBytes}B)` +
    ` → pipeline: ${jobsToEnqueue.map((j) => j.jobType).join(" → ")}`,
  );

  return {
    id: doc.id,
    title: doc.title,
    documentType: doc.documentType,
    status: doc.documentStatus,
    mimeType,
    fileSizeBytes: sizeBytes,
    versionNumber: 1,
    storageKey,
    pipeline: jobsToEnqueue.map((j) => j.jobType),
    chunksCreated,
    createdAt: doc.createdAt,
  };
}

// ── Inline chunking helper ────────────────────────────────────────────────────
// Word-window strategy — identical to the worker's chunking approach.
// Private to this service; callers use uploadAssetToKb().

const CHUNK_SIZE = 1000; // words per chunk
const OVERLAP = 100;     // overlapping words between adjacent chunks

interface InlineChunkArgs {
  tenantId: string;
  kbId: string;
  docId: string;
  versionId: string;
  text: string;
}

async function _inlineChunk(args: InlineChunkArgs): Promise<boolean> {
  const { tenantId, kbId, docId, versionId, text } = args;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const chunkTexts: string[] = [];
  for (let i = 0; i < words.length; i += CHUNK_SIZE - OVERLAP) {
    chunkTexts.push(words.slice(i, i + CHUNK_SIZE).join(" "));
    if (i + CHUNK_SIZE >= words.length) break;
  }

  for (let idx = 0; idx < chunkTexts.length; idx++) {
    const chunkText = chunkTexts[idx];
    const chunkHash = createHash("sha256").update(chunkText).digest("hex").slice(0, 32);

    await db.insert(knowledgeChunks).values({
      tenantId,
      knowledgeBaseId: kbId,
      knowledgeDocumentId: docId,
      knowledgeDocumentVersionId: versionId,
      chunkIndex: idx,
      chunkKey: `${docId}:${idx}`,
      chunkText,
      chunkHash,
      chunkActive: true,
      tokenEstimate: Math.ceil(chunkText.length / 4),
      chunkStrategy: "word-window",
      chunkVersion: "1.0",
      overlapCharacters: OVERLAP,
    }).onConflictDoNothing();
  }

  console.log(`[kb-upload] ${chunkTexts.length} chunks oprettet for doc ${docId}`);
  return true;
}
