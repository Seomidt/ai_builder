/**
 * Cloudflare R2 Storage Routes
 *
 * POST   /api/r2/upload-url        — get a presigned PUT URL for direct browser upload
 * POST   /api/r2/upload            — upload a buffer from the backend (JSON body: key, data base64)
 * GET    /api/r2/download/:key*    — download an object as binary
 * GET    /api/r2/url/:key*         — get a presigned GET URL (default 1h)
 * GET    /api/r2/list              — list objects (query: prefix, maxKeys)
 * DELETE /api/r2/object/:key*      — delete an object
 * GET    /api/r2/exists/:key*      — check object existence
 * GET    /api/r2/health            — connectivity check
 */

import { Router, type Request, type Response } from "express";
import {
  uploadObject, downloadObject, deleteObject,
  listObjects, objectExists, getPresignedUrl, getUploadUrl,
  R2_BUCKET,
} from "../lib/r2";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2/r2-client";

const router = Router();

// ─── Health check ─────────────────────────────────────────────────────────────

router.get("/health", async (_req: Request, res: Response) => {
  if (!R2_BUCKET) {
    return res.status(503).json({ ok: false, error: "R2 bucket not configured" });
  }
  try {
    await r2Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, MaxKeys: 1 }));
    res.json({ ok: true, bucket: R2_BUCKET });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ─── Presigned upload URL ─────────────────────────────────────────────────────

router.post("/upload-url", async (req: Request, res: Response) => {
  const { key, contentType, expiresIn } = req.body as {
    key: string; contentType?: string; expiresIn?: number;
  };
  if (!key) return res.status(400).json({ error: "key is required" });
  try {
    const url = await getUploadUrl(key, contentType, expiresIn ?? 900);
    res.json({ url, key, expiresIn: expiresIn ?? 900 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backend upload (base64) ──────────────────────────────────────────────────

router.post("/upload", async (req: Request, res: Response) => {
  const { key, data, contentType, metadata, cacheControl } = req.body as {
    key: string; data: string; contentType?: string;
    metadata?: Record<string, string>; cacheControl?: string;
  };
  if (!key || !data) return res.status(400).json({ error: "key and data are required" });
  try {
    const buffer = Buffer.from(data, "base64");
    const result = await uploadObject(key, buffer, { contentType, metadata, cacheControl });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Download ─────────────────────────────────────────────────────────────────

router.get("/download", async (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });
  try {
    const buffer = await downloadObject(key);
    res.setHeader("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(buffer);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// ─── Presigned GET URL ────────────────────────────────────────────────────────

router.get("/url", async (req: Request, res: Response) => {
  const key       = req.query.key as string;
  const expiresIn = parseInt(req.query.expiresIn as string) || 3600;
  if (!key) return res.status(400).json({ error: "key query param is required" });
  try {
    const url = await getPresignedUrl(key, expiresIn);
    res.json({ url, key, expiresIn });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── List objects ─────────────────────────────────────────────────────────────

router.get("/list", async (req: Request, res: Response) => {
  const prefix  = (req.query.prefix  as string) ?? "";
  const maxKeys = parseInt(req.query.maxKeys as string) || 100;
  try {
    const objects = await listObjects(prefix, maxKeys);
    res.json({ objects, count: objects.length, prefix });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Check existence ──────────────────────────────────────────────────────────

router.get("/exists", async (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });
  try {
    const exists = await objectExists(key);
    res.json({ exists, key });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete("/object", async (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });
  try {
    await deleteObject(key);
    res.json({ ok: true, key });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export function registerR2Routes(app: import("express").Express) {
  app.use("/api/r2", router);
}
