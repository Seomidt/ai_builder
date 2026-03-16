/**
 * Cloudflare R2 Storage Routes — Hardened (Phase X)
 *
 * All routes enforce:
 *   - Tenant-scoped key validation via key-builder.ts
 *   - Authorization checks via r2-auth.ts
 *   - Delete safety via r2-delete-policy.ts
 *   - Audit logging via r2-audit.ts (no secrets, no signed URLs logged)
 *
 * Routes:
 *   GET    /api/r2/health
 *   POST   /api/r2/upload                  — backend buffer upload (base64)
 *   POST   /api/r2/upload-url              — presigned PUT URL for browser upload
 *   GET    /api/r2/download                — download object (?key=)
 *   GET    /api/r2/url                     — presigned GET URL (?key=)
 *   GET    /api/r2/list                    — list objects (?prefix=&maxKeys=)
 *   GET    /api/r2/exists                  — existence check (?key=)
 *   DELETE /api/r2/object                  — delete object (?key=)
 *   GET    /api/r2/usage                   — bucket usage (platform admin)
 *   GET    /api/r2/prefix-usage            — prefix usage (?prefix=) (platform admin)
 *   GET    /api/r2/tenant-usage            — current tenant usage
 *   POST   /api/r2/multipart/start         — start multipart
 *   POST   /api/r2/multipart/part-url      — presigned part URL
 *   POST   /api/r2/multipart/complete      — complete multipart
 *   POST   /api/r2/multipart/abort         — abort multipart
 */

import { Router, type Request, type Response } from "express";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET }                 from "../lib/r2/r2-client";
import { uploadObject, downloadObject, deleteObject, listObjects, objectExists, getPresignedUrl, getUploadUrl } from "../lib/r2/r2-service";
import { buildTenantObjectKey, buildPlatformObjectKey, assertTenantScopedKey, normalizeFilename, safeKeyForLog } from "../lib/r2/key-builder";
import { assertCanReadObject, assertCanWriteObject, assertCanDeleteObject, canViewPlatformUsage, getActorTenantId, R2AccessDeniedError } from "../lib/r2/r2-auth";
import { auditUploadRequested, auditUploadCompleted, auditSignedUploadUrl, auditSignedDownloadUrl, auditDownloadStarted, auditObjectDeleted, auditAccessDenied } from "../lib/r2/r2-audit";
import { assertDeleteAllowed, explainDeleteDecision } from "../lib/r2/r2-delete-policy";
import { getBucketUsageSummary, getTenantPrefixUsage, getPrefixUsage } from "../lib/r2/r2-usage";
import { createMultipartUpload, createMultipartPartUrl, completeMultipartUpload, abortMultipartUpload } from "../lib/r2/multipart-upload";

const router = Router();

/** Extract a lightweight actor from the request */
function getActor(req: Request) {
  return req.user ?? { organizationId: "unknown", role: "viewer", id: "anon" };
}

/** Centralized error handler for R2 routes */
function handleR2Error(err: unknown, res: Response, actor: ReturnType<typeof getActor>, keyPrefix?: string) {
  if (err instanceof R2AccessDeniedError) {
    auditAccessDenied({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix, reason: err.message });
    return res.status(403).json({ error: err.message });
  }
  const msg = err instanceof Error ? err.message : "Unknown error";
  return res.status(500).json({ error: msg });
}

// ─── Health check ─────────────────────────────────────────────────────────────

router.get("/health", async (_req, res) => {
  if (!R2_BUCKET) return res.status(503).json({ ok: false, error: "R2 bucket not configured" });
  try {
    await r2Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, MaxKeys: 1 }));
    res.json({ ok: true, bucket: R2_BUCKET });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ─── Presigned upload URL ─────────────────────────────────────────────────────

router.post("/upload-url", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { category = "uploads", filename, contentType, expiresIn = 900 } = req.body as {
    category?: string; filename: string; contentType?: string; expiresIn?: number;
  };
  if (!filename) return res.status(400).json({ error: "filename is required" });

  try {
    const tenantId = getActorTenantId(actor);
    const key = buildTenantObjectKey(tenantId, category as any, filename);
    assertCanWriteObject(actor, key);

    const url = await getUploadUrl(key, contentType, expiresIn);
    auditSignedUploadUrl({ actorId: actor.id, tenantId, keyPrefix: safeKeyForLog(key) });
    res.json({ url, key, expiresIn });
  } catch (err) { handleR2Error(err, res, actor); }
});

// ─── Backend upload (base64) ──────────────────────────────────────────────────

router.post("/upload", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { key: rawKey, data, category = "uploads", filename, contentType, metadata, cacheControl } = req.body as {
    key?: string; data: string; category?: string; filename?: string;
    contentType?: string; metadata?: Record<string, string>; cacheControl?: string;
  };
  if (!data) return res.status(400).json({ error: "data (base64) is required" });

  try {
    const tenantId = getActorTenantId(actor);
    // Build a tenant-scoped key — ignore any raw key provided by client
    const name = filename ?? (rawKey ? rawKey.split("/").pop() : undefined) ?? "upload";
    const key  = buildTenantObjectKey(tenantId, category as any, name);
    assertCanWriteObject(actor, key);

    auditUploadRequested({ actorId: actor.id, tenantId, keyPrefix: safeKeyForLog(key) });

    const buffer = Buffer.from(data, "base64");
    const result = await uploadObject(key, buffer, { contentType, metadata, cacheControl });

    auditUploadCompleted({ actorId: actor.id, tenantId, keyPrefix: safeKeyForLog(key), sizeBytes: buffer.length });
    res.json({ ok: true, ...result });
  } catch (err) { handleR2Error(err, res, actor); }
});

// ─── Download ─────────────────────────────────────────────────────────────────

router.get("/download", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const key   = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });

  try {
    assertCanReadObject(actor, key);
    auditDownloadStarted({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key) });

    const buffer = await downloadObject(key);
    res.setHeader("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(buffer);
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── Presigned GET URL ────────────────────────────────────────────────────────

router.get("/url", async (req: Request, res: Response) => {
  const actor     = getActor(req);
  const key       = req.query.key as string;
  const expiresIn = parseInt(req.query.expiresIn as string) || 3600;
  if (!key) return res.status(400).json({ error: "key query param is required" });

  try {
    assertCanReadObject(actor, key);
    const url = await getPresignedUrl(key, expiresIn);
    auditSignedDownloadUrl({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key) });
    res.json({ url, key, expiresIn });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── List objects ─────────────────────────────────────────────────────────────

router.get("/list", async (req: Request, res: Response) => {
  const actor   = getActor(req);
  const tenantId = getActorTenantId(actor);

  // Default to tenant's own prefix; platform admins can pass arbitrary prefix
  let prefix  = (req.query.prefix as string) ?? "";
  const maxKeys = Math.min(parseInt(req.query.maxKeys as string) || 200, 1000);

  // Non-admins: force prefix into their tenant namespace
  const isAdmin = actor.role === "platform_admin" || actor.role === "owner";
  if (!isAdmin && prefix === "") {
    prefix = `tenants/${tenantId}/`;
  } else if (!isAdmin && !prefix.startsWith(`tenants/${tenantId}/`)) {
    prefix = `tenants/${tenantId}/`;
  }

  try {
    const objects = await listObjects(prefix, maxKeys);
    res.json({ objects, count: objects.length, prefix });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Check existence ──────────────────────────────────────────────────────────

router.get("/exists", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const key   = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });

  try {
    assertCanReadObject(actor, key);
    const exists = await objectExists(key);
    res.json({ exists, key });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete("/object", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const key   = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });

  try {
    assertCanDeleteObject(actor, key);
    assertDeleteAllowed(actor, key);

    await deleteObject(key);
    auditObjectDeleted({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key) });
    res.json({ ok: true, key });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── Delete decision / risk explanation ──────────────────────────────────────

router.get("/delete-policy", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const key   = req.query.key as string;
  if (!key) return res.status(400).json({ error: "key query param is required" });
  const decision = explainDeleteDecision(actor, key);
  res.json(decision);
});

// ─── Usage (platform admin) ───────────────────────────────────────────────────

router.get("/usage", async (req: Request, res: Response) => {
  const actor = getActor(req);
  if (!canViewPlatformUsage(actor)) {
    return res.status(403).json({ error: "Platform admin required" });
  }
  try {
    const summary = await getBucketUsageSummary();
    res.json(summary);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/prefix-usage", async (req: Request, res: Response) => {
  const actor  = getActor(req);
  const prefix = req.query.prefix as string ?? "";
  if (!canViewPlatformUsage(actor)) {
    return res.status(403).json({ error: "Platform admin required" });
  }
  try {
    const usage = await getPrefixUsage(prefix);
    res.json(usage);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Tenant usage (own tenant) ────────────────────────────────────────────────

router.get("/tenant-usage", async (req: Request, res: Response) => {
  const actor    = getActor(req);
  const tenantId = getActorTenantId(actor);
  try {
    const usage = await getTenantPrefixUsage(tenantId);
    res.json(usage);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Multipart: start ─────────────────────────────────────────────────────────

router.post("/multipart/start", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { category = "uploads", filename, contentType, metadata } = req.body as {
    category?: string; filename: string; contentType?: string;
    metadata?: Record<string, string>;
  };
  if (!filename) return res.status(400).json({ error: "filename is required" });

  try {
    const tenantId = getActorTenantId(actor);
    const key      = buildTenantObjectKey(tenantId, category as any, filename);
    assertCanWriteObject(actor, key);

    const session = await createMultipartUpload(key, contentType, metadata);
    const { auditMultipartStarted } = await import("../lib/r2/r2-audit");
    auditMultipartStarted({ actorId: actor.id, tenantId, keyPrefix: safeKeyForLog(key) });

    res.json(session);
  } catch (err) { handleR2Error(err, res, actor); }
});

// ─── Multipart: presigned part URL ───────────────────────────────────────────

router.post("/multipart/part-url", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { key, uploadId, partNumber, expiresIn = 3600 } = req.body as {
    key: string; uploadId: string; partNumber: number; expiresIn?: number;
  };
  if (!key || !uploadId || !partNumber) {
    return res.status(400).json({ error: "key, uploadId, and partNumber are required" });
  }

  try {
    assertCanWriteObject(actor, key);
    const result = await createMultipartPartUrl(key, uploadId, partNumber, expiresIn);
    const { logR2Event } = await import("../lib/r2/r2-audit");
    logR2Event({ event: "r2_multipart_part_url_created", actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key), result: "success" });

    // Return without the signed URL in the key field — log only prefix
    res.json({ uploadId, key, partNumber, expiresAt: result.expiresAt, url: result.url });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── Multipart: complete ──────────────────────────────────────────────────────

router.post("/multipart/complete", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { key, uploadId, parts } = req.body as {
    key: string; uploadId: string; parts: { PartNumber: number; ETag: string }[];
  };
  if (!key || !uploadId || !Array.isArray(parts)) {
    return res.status(400).json({ error: "key, uploadId, and parts[] are required" });
  }

  try {
    assertCanWriteObject(actor, key);
    const result = await completeMultipartUpload(key, uploadId, parts);
    const { auditMultipartCompleted } = await import("../lib/r2/r2-audit");
    auditMultipartCompleted({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key) });

    res.json({ ok: true, ...result });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

// ─── Multipart: abort ────────────────────────────────────────────────────────

router.post("/multipart/abort", async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { key, uploadId } = req.body as { key: string; uploadId: string };
  if (!key || !uploadId) return res.status(400).json({ error: "key and uploadId are required" });

  try {
    assertCanWriteObject(actor, key);
    await abortMultipartUpload(key, uploadId);
    const { auditMultipartAborted } = await import("../lib/r2/r2-audit");
    auditMultipartAborted({ actorId: actor.id, tenantId: actor.organizationId, keyPrefix: safeKeyForLog(key) });

    res.json({ ok: true, key, uploadId });
  } catch (err) { handleR2Error(err, res, actor, key); }
});

export function registerR2Routes(app: import("express").Express) {
  app.use("/api/r2", router);
}
