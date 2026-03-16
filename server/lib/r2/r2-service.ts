/**
 * Cloudflare R2 Storage Service
 * Wraps common S3 operations for the platform.
 *
 * Operations:
 *   uploadObject      — put a buffer / string / stream into R2
 *   downloadObject    — retrieve an object as a Buffer
 *   deleteObject      — remove an object
 *   listObjects       — list objects under a prefix
 *   objectExists      — head-check for existence
 *   getPresignedUrl   — generate a signed GET URL (default: 1 hour)
 *   getUploadUrl      — generate a signed PUT URL for direct browser upload
 */

import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload }       from "@aws-sdk/lib-storage";
import { Readable }     from "stream";
import { r2Client, R2_BUCKET } from "./r2-client";

export interface R2UploadOptions {
  contentType?: string;
  metadata?:    Record<string, string>;
  cacheControl?: string;
}

export interface R2Object {
  key:          string;
  size:         number;
  lastModified: Date;
  etag?:        string;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadObject(
  key:     string,
  body:    Buffer | string | Readable,
  options: R2UploadOptions = {},
): Promise<{ key: string; etag: string | undefined }> {
  const input: PutObjectCommandInput = {
    Bucket:       R2_BUCKET,
    Key:          key,
    Body:         body as any,
    ContentType:  options.contentType ?? "application/octet-stream",
    Metadata:     options.metadata,
    CacheControl: options.cacheControl,
  };

  if (body instanceof Readable) {
    const upload = new Upload({ client: r2Client, params: input });
    const result = await upload.done();
    return { key, etag: result.ETag };
  }

  const result = await r2Client.send(new PutObjectCommand(input));
  return { key, etag: result.ETag };
}

// ─── Download ─────────────────────────────────────────────────────────────────

export async function downloadObject(key: string): Promise<Buffer> {
  const result = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const stream = result.Body as Readable;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteObject(key: string): Promise<void> {
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listObjects(prefix: string = "", maxKeys: number = 100): Promise<R2Object[]> {
  const result = await r2Client.send(new ListObjectsV2Command({
    Bucket:  R2_BUCKET,
    Prefix:  prefix,
    MaxKeys: maxKeys,
  }));

  return (result.Contents ?? []).map(o => ({
    key:          o.Key          ?? "",
    size:         o.Size         ?? 0,
    lastModified: o.LastModified ?? new Date(0),
    etag:         o.ETag,
  }));
}

// ─── Exists ───────────────────────────────────────────────────────────────────

export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// ─── Presigned GET URL ────────────────────────────────────────────────────────

export async function getPresignedUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
  return getSignedUrl(
    r2Client,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

// ─── Presigned PUT URL (direct browser upload) ────────────────────────────────

export async function getUploadUrl(
  key:             string,
  contentType:     string  = "application/octet-stream",
  expiresInSeconds: number = 900,
): Promise<string> {
  return getSignedUrl(
    r2Client,
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}
