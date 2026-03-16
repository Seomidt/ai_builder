/**
 * Cloudflare R2 Client
 * Uses the S3-compatible API exposed by Cloudflare R2.
 * Credentials are read from environment secrets at startup.
 */

import { S3Client } from "@aws-sdk/client-s3";

const ACCOUNT_ID   = process.env.CF_R2_ACCOUNT_ID   ?? "";
const ACCESS_KEY   = process.env.CF_R2_ACCESS_KEY_ID ?? "";
const SECRET_KEY   = process.env.CF_R2_SECRET_ACCESS_KEY ?? "";

if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY) {
  console.warn("[R2] Missing Cloudflare R2 credentials — storage will be unavailable.");
}

export const R2_BUCKET = process.env.CF_R2_BUCKET_NAME ?? "";

export const r2Client = new S3Client({
  region:   "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  },
  forcePathStyle: false,
});
