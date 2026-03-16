/**
 * Phase 29 — Cloudflare R2 Backup
 * Uploads encrypted backups to Cloudflare R2 and manages retention.
 *
 * Bucket: ai-platform-backups
 * Layout:
 *   /db/daily/    YYYY-MM-DD.sql.gz
 *   /db/weekly/   YYYY-WNN.sql.gz
 *   /db/monthly/  YYYY-MM.sql.gz
 *
 * R2 uses the S3-compatible API — no extra SDK needed, uses @aws-sdk/client-s3.
 */

import { readFileSync, existsSync } from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackupType = "daily" | "weekly" | "monthly";

export interface R2Config {
  accountId:       string;
  accessKeyId:     string;
  secretAccessKey: string;
  bucketName:      string;
  endpoint:        string;
}

export interface UploadResult {
  success:    boolean;
  key:        string;
  bucketName: string;
  sizeBytes:  number;
  etag:       string | null;
  uploadedAt: string;
  error?:     string;
}

export interface VerifyResult {
  exists:     boolean;
  key:        string;
  sizeBytes:  number | null;
  etag:       string | null;
  checkedAt:  string;
}

export interface RotationResult {
  deletedKeys:   string[];
  keptKeys:      string[];
  deletedCount:  number;
  checkedAt:     string;
}

// ── Config ─────────────────────────────────────────────────────────────────────

export function getR2Config(): R2Config {
  const accountId       = process.env.R2_ACCOUNT_ID       ?? "";
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID     ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
  const bucketName      = process.env.R2_BUCKET_NAME       ?? "ai-platform-backups";

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "",
  };
}

export function isR2Configured(): boolean {
  const cfg = getR2Config();
  return !!(cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey);
}

export function validateR2Config(): { valid: boolean; missing: string[] } {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const missing  = required.filter(v => !process.env[v]);
  return { valid: missing.length === 0, missing };
}

// ── Key helpers ───────────────────────────────────────────────────────────────

export function buildBackupKey(type: BackupType, filename: string): string {
  const dir = type === "daily" ? "db/daily" : type === "weekly" ? "db/weekly" : "db/monthly";
  return `${dir}/${filename}`;
}

export function getWeekLabel(date = new Date()): string {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const week        = Math.ceil(((date.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function getMonthLabel(date = new Date()): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

// ── R2 client (S3-compatible) ─────────────────────────────────────────────────

async function getS3Client(cfg: R2Config) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId:     cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadBackup(
  localFilePath: string,
  type: BackupType = "daily",
  customKey?: string,
): Promise<UploadResult> {
  const validation = validateR2Config();
  if (!validation.valid) {
    return {
      success:    false,
      key:        customKey ?? localFilePath,
      bucketName: "ai-platform-backups",
      sizeBytes:  0,
      etag:       null,
      uploadedAt: new Date().toISOString(),
      error:      `R2 not configured — missing: ${validation.missing.join(", ")}`,
    };
  }

  if (!existsSync(localFilePath)) {
    return {
      success:    false,
      key:        customKey ?? localFilePath,
      bucketName: "ai-platform-backups",
      sizeBytes:  0,
      etag:       null,
      uploadedAt: new Date().toISOString(),
      error:      `File not found: ${localFilePath}`,
    };
  }

  const cfg        = getR2Config();
  const filename   = path.basename(localFilePath);
  const key        = customKey ?? buildBackupKey(type, filename);
  const fileBuffer = readFileSync(localFilePath);

  try {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await getS3Client(cfg);

    const response = await client.send(new PutObjectCommand({
      Bucket:      cfg.bucketName,
      Key:         key,
      Body:        fileBuffer,
      ContentType: "application/gzip",
      Metadata: {
        "backup-type":   type,
        "uploaded-at":   new Date().toISOString(),
        "source-file":   filename,
      },
    }));

    return {
      success:    true,
      key,
      bucketName: cfg.bucketName,
      sizeBytes:  fileBuffer.length,
      etag:       response.ETag ?? null,
      uploadedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success:    false,
      key,
      bucketName: cfg.bucketName,
      sizeBytes:  0,
      etag:       null,
      uploadedAt: new Date().toISOString(),
      error:      (err as Error).message,
    };
  }
}

// ── Verify upload ─────────────────────────────────────────────────────────────

export async function verifyUpload(key: string): Promise<VerifyResult> {
  if (!isR2Configured()) {
    return { exists: false, key, sizeBytes: null, etag: null, checkedAt: new Date().toISOString() };
  }

  try {
    const cfg = getR2Config();
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const client   = await getS3Client(cfg);
    const response = await client.send(new HeadObjectCommand({ Bucket: cfg.bucketName, Key: key }));

    return {
      exists:    true,
      key,
      sizeBytes: response.ContentLength ?? null,
      etag:      response.ETag ?? null,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { exists: false, key, sizeBytes: null, etag: null, checkedAt: new Date().toISOString() };
  }
}

// ── Rotate backups ────────────────────────────────────────────────────────────

export async function rotateBackups(
  type: BackupType,
  keepCount: number,
): Promise<RotationResult> {
  if (!isR2Configured()) {
    return { deletedKeys: [], keptKeys: [], deletedCount: 0, checkedAt: new Date().toISOString() };
  }

  const prefix = type === "daily" ? "db/daily/" : type === "weekly" ? "db/weekly/" : "db/monthly/";

  try {
    const cfg = getR2Config();
    const { ListObjectsV2Command, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await getS3Client(cfg);

    const listRes = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucketName,
      Prefix: prefix,
    }));

    const objects = (listRes.Contents ?? [])
      .filter(o => o.Key && o.LastModified)
      .sort((a, b) => (b.LastModified!.getTime()) - (a.LastModified!.getTime())); // newest first

    const keptKeys    = objects.slice(0, keepCount).map(o => o.Key!);
    const toDelete    = objects.slice(keepCount);
    const deletedKeys: string[] = [];

    for (const obj of toDelete) {
      if (!obj.Key) continue;
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucketName, Key: obj.Key }));
      deletedKeys.push(obj.Key);
    }

    return { deletedKeys, keptKeys, deletedCount: deletedKeys.length, checkedAt: new Date().toISOString() };
  } catch (err) {
    return { deletedKeys: [], keptKeys: [], deletedCount: 0, checkedAt: new Date().toISOString() };
  }
}

// ── List backups ──────────────────────────────────────────────────────────────

export async function listBackups(type?: BackupType): Promise<{ key: string; sizeBytes: number; lastModified: string }[]> {
  if (!isR2Configured()) return [];

  const prefix = type ? (type === "daily" ? "db/daily/" : type === "weekly" ? "db/weekly/" : "db/monthly/") : "db/";

  try {
    const cfg = getR2Config();
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client  = await getS3Client(cfg);
    const listRes = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucketName, Prefix: prefix }));

    return (listRes.Contents ?? []).map(o => ({
      key:          o.Key ?? "",
      sizeBytes:    o.Size ?? 0,
      lastModified: o.LastModified?.toISOString() ?? "",
    }));
  } catch {
    return [];
  }
}
