/**
 * R2 Client — Shared S3-compatible client for Cloudflare R2.
 *
 * Uses CF_R2_* environment variables (set via Replit secrets):
 *   CF_R2_ACCOUNT_ID       — Cloudflare account ID
 *   CF_R2_ACCESS_KEY_ID    — R2 API token Access Key ID
 *   CF_R2_SECRET_ACCESS_KEY — R2 API token Secret Access Key
 *   CF_R2_BUCKET_NAME      — bucket name (default: "blissops")
 *
 * R2 is fully S3-compatible — @aws-sdk/client-s3 works without changes.
 */

import { S3Client } from "@aws-sdk/client-s3";

const accountId       = process.env.CF_R2_ACCOUNT_ID        ?? process.env.R2_ACCOUNT_ID        ?? "";
const accessKeyId     = process.env.CF_R2_ACCESS_KEY_ID     ?? process.env.R2_ACCESS_KEY_ID     ?? "";
const secretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY ?? "";

export const R2_BUCKET =
  process.env.CF_R2_BUCKET_NAME ?? process.env.R2_BUCKET_NAME ?? "blissops";

export const R2_CONFIGURED = !!(accountId && accessKeyId && secretAccessKey);

export const r2Client = new S3Client({
  region: "auto",
  endpoint: accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : "https://example.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId:     accessKeyId  || "placeholder",
    secretAccessKey: secretAccessKey || "placeholder",
  },
  // R2 requires path-style addressing
  forcePathStyle: false,
});

export function assertR2Configured(): void {
  if (!R2_CONFIGURED) {
    throw new Error(
      "Cloudflare R2 is not configured. Set CF_R2_ACCOUNT_ID, CF_R2_ACCESS_KEY_ID, and CF_R2_SECRET_ACCESS_KEY.",
    );
  }
}
