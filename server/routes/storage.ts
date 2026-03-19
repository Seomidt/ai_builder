/**
 * Phase 46 — Tenant Storage Routes
 *
 * Endpoints:
 *   POST   /api/storage/request-upload   — validate + create metadata + return signed PUT URL
 *   POST   /api/storage/complete-upload  — mark file as uploaded after R2 PUT completes
 *   GET    /api/storage/download-url     — return short-lived signed GET URL
 *   DELETE /api/storage/file/:id         — soft-delete file
 *   GET    /api/storage/admin/reconcile  — reconcile DB vs R2 (admin only)
 *
 * Authentication: applied globally via app.use(authMiddleware) in server/index.ts
 * organization_id is derived from the authenticated session — never from client body.
 */

import { Router, type Request, type Response } from "express";
import { requestUpload, completeUpload } from "../lib/storage/upload-flow";
import { issueDownloadAccess, DownloadAccessError } from "../lib/storage/download-access";
import { softDeleteFile, DeleteError }              from "../lib/storage/delete-file";
import { runReconciliation }                        from "../lib/storage/reconcile";
import { emitStorageAuditEvent }                    from "../lib/storage/audit-log";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/storage/request-upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/request-upload", async (req: Request, res: Response) => {
  const user = (req as any).user;

  try {
    const {
      category,
      mimeType,
      sizeBytes,
      originalFilename,
      clientId,
    } = req.body as {
      category:         string;
      mimeType:         string;
      sizeBytes:        number;
      originalFilename: string;
      clientId?:        string;
    };

    if (!category)         return res.status(400).json({ error: "category is required" });
    if (!mimeType)         return res.status(400).json({ error: "mimeType is required" });
    if (!sizeBytes)        return res.status(400).json({ error: "sizeBytes is required" });
    if (!originalFilename) return res.status(400).json({ error: "originalFilename is required" });

    const result = await requestUpload({
      organizationId:   user.organizationId,
      uploaderRole:     user.role ?? "coach",
      userId:           user.id,
      category,
      mimeType,
      sizeBytes:        Number(sizeBytes),
      originalFilename,
      clientId,
      ipAddress:        req.ip,
      requestId:        req.headers["x-request-id"] as string,
    });

    return res.status(201).json({
      fileId:          result.fileId,
      uploadUrl:       result.uploadUrl,
      uploadUrlExpiry: result.uploadUrlExpiry,
      scanRequired:    result.scanRequired,
    });
  } catch (err: any) {
    if (err.name === "StoragePolicyError" || err.name === "IntegrityError" || err.name === "ObjectKeyError") {
      return res.status(422).json({ error: err.message });
    }
    if (err.name === "UploadFlowError") {
      return res.status(400).json({ error: err.message });
    }
    console.error("[Storage] request-upload error:", err);
    await emitStorageAuditEvent({
      event:          "upload_failed",
      organizationId: (req as any).user?.organizationId ?? "unknown",
      details:        { error: err.message },
    });
    return res.status(500).json({ error: "Upload request failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/storage/complete-upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/complete-upload", async (req: Request, res: Response) => {
  const user = (req as any).user;

  try {
    const { fileId, checksumSha256, sizeBytes } = req.body as {
      fileId:          string;
      checksumSha256?: string;
      sizeBytes?:      number;
    };

    if (!fileId) return res.status(400).json({ error: "fileId is required" });

    const result = await completeUpload({
      fileId,
      organizationId: user.organizationId,
      checksumSha256,
      sizeBytes:      sizeBytes !== undefined ? Number(sizeBytes) : undefined,
      userId:         user.id,
      ipAddress:      req.ip,
      requestId:      req.headers["x-request-id"] as string,
    });

    return res.json({
      fileId:     result.fileId,
      scanStatus: result.scanStatus,
      status:     "uploaded",
    });
  } catch (err: any) {
    if (err.name === "UploadFlowError") {
      return res.status(400).json({ error: err.message });
    }
    console.error("[Storage] complete-upload error:", err);
    return res.status(500).json({ error: "Upload completion failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/storage/download-url
// ─────────────────────────────────────────────────────────────────────────────
router.get("/download-url", async (req: Request, res: Response) => {
  const user    = (req as any).user;
  const fileId  = req.query.fileId as string;
  const expiry  = req.query.expiry ? Number(req.query.expiry) : 900;

  if (!fileId) return res.status(400).json({ error: "fileId query param is required" });

  try {
    const result = await issueDownloadAccess({
      fileId,
      requestingOrgId: user.organizationId,
      requestingRole:  user.role ?? "coach",
      userId:          user.id,
      ipAddress:       req.ip,
      requestId:       req.headers["x-request-id"] as string,
      expiresInSec:    expiry,
    });

    return res.json({
      signedUrl:    result.signedUrl,
      expiresInSec: result.expiresInSec,
      filename:     result.filename,
      mimeType:     result.mimeType,
    });
  } catch (err: any) {
    if (err instanceof DownloadAccessError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err.name === "ScanStatusError") {
      return res.status(403).json({ error: err.message });
    }
    console.error("[Storage] download-url error:", err);
    return res.status(500).json({ error: "Download URL generation failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/storage/file/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/file/:id", async (req: Request, res: Response) => {
  const user   = (req as any).user;
  const fileId = req.params.id;

  try {
    await softDeleteFile({
      fileId,
      organizationId:     user.organizationId,
      requestedByUserId:  user.id,
      ipAddress:          req.ip,
      requestId:          req.headers["x-request-id"] as string,
    });

    return res.json({ fileId, status: "deleted" });
  } catch (err: any) {
    if (err instanceof DeleteError) {
      return res.status(404).json({ error: err.message });
    }
    console.error("[Storage] delete error:", err);
    return res.status(500).json({ error: "File deletion failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/storage/admin/reconcile  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/reconcile", async (req: Request, res: Response) => {
  const user = (req as any).user;

  if (user.role !== "admin" && user.role !== "service_role") {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    const orgId = req.query.organizationId as string | undefined;
    const report = await runReconciliation(orgId);
    return res.json(report);
  } catch (err: any) {
    console.error("[Storage] reconcile error:", err);
    return res.status(500).json({ error: "Reconciliation failed" });
  }
});

export default router;
