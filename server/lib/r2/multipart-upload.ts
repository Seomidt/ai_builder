/**
 * R2 Multipart Upload — Task 5
 * Supports large file uploads via S3-compatible multipart API.
 * Use for files > 100 MB; parts must be >= 5 MB (except last).
 */

import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client, R2_BUCKET } from "./r2-client";

export interface MultipartUploadSession {
  uploadId:    string;
  key:         string;
  bucket:      string;
  initiatedAt: string;
}

export interface PartUploadUrl {
  uploadId:   string;
  key:        string;
  partNumber: number;
  url:        string;       // presigned PUT URL — valid 1 hour
  expiresAt:  string;
}

export interface CompletedUpload {
  key:      string;
  etag:     string | undefined;
  location: string | undefined;
}

// ── Create multipart upload session ──────────────────────────────────────────

export async function createMultipartUpload(
  key:         string,
  contentType: string = "application/octet-stream",
  metadata?:   Record<string, string>,
): Promise<MultipartUploadSession> {
  const resp = await r2Client.send(new CreateMultipartUploadCommand({
    Bucket:      R2_BUCKET,
    Key:         key,
    ContentType: contentType,
    Metadata:    metadata,
  }));

  if (!resp.UploadId) throw new Error("Failed to create multipart upload — no UploadId returned");

  return {
    uploadId:    resp.UploadId,
    key,
    bucket:      R2_BUCKET,
    initiatedAt: new Date().toISOString(),
  };
}

// ── Generate presigned URL for a single part ──────────────────────────────────

export async function createMultipartPartUrl(
  key:        string,
  uploadId:   string,
  partNumber: number,
  expiresIn:  number = 3600,
): Promise<PartUploadUrl> {
  if (partNumber < 1 || partNumber > 10_000) {
    throw new Error(`partNumber must be between 1 and 10000 (got ${partNumber})`);
  }

  const url = await getSignedUrl(
    r2Client,
    new UploadPartCommand({
      Bucket:     R2_BUCKET,
      Key:        key,
      UploadId:   uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn },
  );

  return {
    uploadId,
    key,
    partNumber,
    url,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

// ── Complete multipart upload ─────────────────────────────────────────────────

export async function completeMultipartUpload(
  key:      string,
  uploadId: string,
  parts:    CompletedPart[],     // [{ PartNumber, ETag }]
): Promise<CompletedUpload> {
  if (!parts.length) throw new Error("At least one part is required to complete a multipart upload");

  const sorted = [...parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));

  const resp = await r2Client.send(new CompleteMultipartUploadCommand({
    Bucket:          R2_BUCKET,
    Key:             key,
    UploadId:        uploadId,
    MultipartUpload: { Parts: sorted },
  }));

  return {
    key,
    etag:     resp.ETag,
    location: resp.Location,
  };
}

// ── Abort multipart upload ────────────────────────────────────────────────────

export async function abortMultipartUpload(
  key:      string,
  uploadId: string,
): Promise<void> {
  await r2Client.send(new AbortMultipartUploadCommand({
    Bucket:   R2_BUCKET,
    Key:      key,
    UploadId: uploadId,
  }));
}
