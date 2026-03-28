/**
 * KB R2 Asset Registration
 *
 * Registers an already-uploaded R2 object as a knowledge base asset.
 * Called when a file has been uploaded directly from the browser to R2
 * via a presigned URL — so the file is already in R2, we just need to
 * create the DB records and queue ingestion jobs.
 *
 * This reuses the same DB schema as kb-upload-service.ts but skips the
 * buffer/upload step since the file is already in R2.
 */

import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeStorageObjects,
  knowledgeProcessingJobs,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { createHash } from "crypto";
import { ALLOWED_MIME_TYPES } from "./kb-upload-service";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegisterR2AssetInput {
  tenantId:        string;
  uploadedBy:      string;
  knowledgeBaseId: string;
  objectKey:       string;
  filename:        string;
  mimeType:        string;
  fileSizeBytes:   number;
}

export interface RegisterR2AssetResult {
  id:           string;
  title:        string;
  documentType: string;
  status:       string;
  mimeType:     string;
  fileSizeBytes: number;
  objectKey:    string;
  idempotent?:  boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function registerR2Asset(
  input: RegisterR2AssetInput,
): Promise<RegisterR2AssetResult> {
  const {
    tenantId, uploadedBy, knowledgeBaseId: kbId,
    objectKey, filename, mimeType, fileSizeBytes,
  } = input;

  // Validate mime type
  const documentType = ALLOWED_MIME_TYPES[mimeType] ?? "";
  if (!documentType) {
    throw new Error(`Filtypen "${mimeType}" understøttes ikke`);
  }

  // Verify KB belongs to tenant
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenantId)));

  if (!kb) {
    throw new Error("Datakilde ikke fundet");
  }

  // Idempotency check — same key as kb-upload-service
  const idempotencyKey = createHash("sha256")
    .update(`${tenantId}:${kbId}:${filename}:${fileSizeBytes}:${mimeType}`)
    .digest("hex");

  const existingJob = await db
    .select({ id: knowledgeProcessingJobs.id, knowledgeDocumentId: knowledgeProcessingJobs.knowledgeDocumentId })
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
        id:           existingDoc.id,
        title:        existingDoc.title,
        documentType: existingDoc.documentType,
        status:       existingDoc.documentStatus,
        mimeType,
        fileSizeBytes,
        objectKey,
        idempotent: true,
      };
    }
  }

  // R2 bucket name
  const { R2_BUCKET } = await import("../r2/r2-client");

  // Create document record
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
    metadata: { storageKey: objectKey, originalFilename: filename, uploadedViaPresignedUrl: true } as never,
  }).returning();

  // Create version record
  const [ver] = await db.insert(knowledgeDocumentVersions).values({
    tenantId,
    knowledgeDocumentId: doc.id,
    versionNumber: 1,
    mimeType,
    fileSizeBytes,
    isCurrent: true,
    versionStatus: "uploaded",
    sourceLabel: filename,
    uploadedAt: new Date(),
    createdBy: uploadedBy,
    parseStatus:      documentType === "document" ? "pending" : null,
    ocrStatus:        documentType === "image"    ? "pending" : null,
    transcriptStatus: documentType === "video"    ? "pending" : null,
    metadata: {
      storageKey: objectKey,
      r2Uploaded: true,
      uploadedViaPresignedUrl: true,
    } as never,
  }).returning();

  // Link version to doc
  await db.update(knowledgeDocuments)
    .set({ currentVersionId: ver.id, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, doc.id));

  // Create storage object record
  await db.insert(knowledgeStorageObjects).values({
    tenantId,
    knowledgeDocumentVersionId: ver.id,
    storageProvider: "r2",
    bucketName: R2_BUCKET,
    objectKey,
    originalFilename: filename,
    mimeType,
    fileSizeBytes,
    uploadStatus: "uploaded",
    uploadedAt: new Date(),
    metadata: { kbId, uploadedViaPresignedUrl: true } as never,
  });

  // Create processing job
  await db.insert(knowledgeProcessingJobs).values({
    tenantId,
    knowledgeDocumentId: doc.id,
    knowledgeDocumentVersionId: ver.id,
    idempotencyKey,
    jobType:   "full_ingestion",
    jobStatus: "pending",
    priority:  5,
    payload: { objectKey, filename, mimeType, fileSizeBytes, uploadedViaPresignedUrl: true } as never,
    createdBy: uploadedBy,
  });

  console.log(`[kb-r2-asset] registered: doc=${doc.id} key=${objectKey} mime=${mimeType} size=${fileSizeBytes}`);

  return {
    id:           doc.id,
    title:        filename,
    documentType,
    status:       "processing",
    mimeType,
    fileSizeBytes,
    objectKey,
  };
}
