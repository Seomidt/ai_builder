/**
 * api/_src/kb.ts — Thin Vercel Serverless Handler for /api/kb/*
 *
 * Storage 1.7B: Refactored to be a thin adapter.
 * Does NOT import server/app.ts or server/routes.ts.
 * Heavy dependencies (busboy, OpenAI, kb-similar, kb-retrieval) are lazy-loaded
 * only for the specific request paths that need them.
 *
 * Routes handled:
 *   GET    /api/kb
 *   POST   /api/kb
 *   POST   /api/kb/search   (before /:id to avoid param clash)
 *   POST   /api/kb/similar
 *   GET    /api/kb/:id
 *   PATCH  /api/kb/:id/archive
 *   GET    /api/kb/:id/assets
 *   POST   /api/kb/:id/upload
 *   GET    /api/kb/:id/experts
 *   POST   /api/kb/:id/experts
 *   DELETE /api/kb/:id/experts/:expertId
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error_code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error_code: "NOT_FOUND", message: "Route ikke fundet" });
}

// ── Body reader ───────────────────────────────────────────────────────────────

function readBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBuffer(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Lazy module loaders (cached by Node module system after first import) ─────

async function getDb() {
  const { db } = await import("../../server/db");
  return db;
}

async function getSchema() {
  return import("../../shared/schema");
}

async function getOrm() {
  return import("drizzle-orm");
}

// ── Error handler ─────────────────────────────────────────────────────────────

function handleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[vercel/kb]", message);

  if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "ZodError") {
    json(res, 400, { error_code: "VALIDATION_ERROR", message });
    return;
  }
  json(res, 500, { error_code: "INTERNAL_ERROR", message });
}

// ── Route: GET /api/kb ────────────────────────────────────────────────────────

async function listKnowledgeBases(orgId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { knowledgeBases, knowledgeDocuments } = await getSchema();
    const { eq, and, count, desc } = await getOrm();

    const bases = await db
      .select()
      .from(knowledgeBases)
      .where(and(
        eq(knowledgeBases.tenantId, orgId),
        eq(knowledgeBases.lifecycleState, "active"),
      ))
      .orderBy(desc(knowledgeBases.createdAt));

    const counts = await db
      .select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId, cnt: count() })
      .from(knowledgeDocuments)
      .where(and(
        eq(knowledgeDocuments.tenantId, orgId),
        eq(knowledgeDocuments.lifecycleState, "active"),
      ))
      .groupBy(knowledgeDocuments.knowledgeBaseId);

    const countMap = Object.fromEntries(counts.map((c) => [c.knowledgeBaseId, Number(c.cnt)]));

    json(res, 200, bases.map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      description: b.description,
      status: b.lifecycleState,
      assetCount: countMap[b.id] ?? 0,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })));
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: POST /api/kb ───────────────────────────────────────────────────────

async function createKnowledgeBase(orgId: string, userId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const { z } = await import("zod");

    const schema = z.object({
      name: z.string().min(1).max(200),
      slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
      description: z.string().max(1000).optional(),
    });

    const parsed = schema.parse(body);
    const db = await getDb();
    const { knowledgeBases } = await getSchema();
    const { eq, and } = await getOrm();

    const [existing] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.tenantId, orgId), eq(knowledgeBases.slug, parsed.slug)));

    if (existing) {
      json(res, 409, { error_code: "SLUG_CONFLICT", message: "Slug er allerede i brug" });
      return;
    }

    const [kb] = await db.insert(knowledgeBases).values({
      tenantId: orgId,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
      lifecycleState: "active",
      visibility: "private",
      createdBy: userId,
      updatedBy: userId,
    }).returning();

    json(res, 201, {
      id: kb.id,
      name: kb.name,
      slug: kb.slug,
      description: kb.description,
      status: kb.lifecycleState,
      assetCount: 0,
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
    });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: GET /api/kb/:id ────────────────────────────────────────────────────

async function getKnowledgeBase(orgId: string, kbId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { knowledgeBases, knowledgeDocuments } = await getSchema();
    const { eq, and, count } = await getOrm();

    const [kb] = await db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));

    if (!kb) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });
      return;
    }

    const [{ cnt }] = await db
      .select({ cnt: count() })
      .from(knowledgeDocuments)
      .where(and(
        eq(knowledgeDocuments.knowledgeBaseId, kb.id),
        eq(knowledgeDocuments.tenantId, orgId),
        eq(knowledgeDocuments.lifecycleState, "active"),
      ));

    json(res, 200, {
      id: kb.id,
      name: kb.name,
      slug: kb.slug,
      description: kb.description,
      status: kb.lifecycleState,
      assetCount: Number(cnt),
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
    });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: PATCH /api/kb/:id/archive ─────────────────────────────────────────

async function archiveKnowledgeBase(orgId: string, kbId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { knowledgeBases } = await getSchema();
    const { eq, and } = await getOrm();

    const [updated] = await db
      .update(knowledgeBases)
      .set({ lifecycleState: "archived", updatedAt: new Date() })
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)))
      .returning();

    if (!updated) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });
      return;
    }

    json(res, 200, { id: updated.id, status: updated.lifecycleState });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: GET /api/kb/:id/assets ─────────────────────────────────────────────

async function listAssets(orgId: string, kbId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const {
      knowledgeDocuments, knowledgeDocumentVersions, knowledgeProcessingJobs,
      knowledgeChunks, knowledgeEmbeddings,
    } = await getSchema();
    const { eq, and, desc, inArray, count } = await getOrm();

    const assets = await db
      .select()
      .from(knowledgeDocuments)
      .where(and(
        eq(knowledgeDocuments.knowledgeBaseId, kbId),
        eq(knowledgeDocuments.tenantId, orgId),
        eq(knowledgeDocuments.lifecycleState, "active"),
      ))
      .orderBy(desc(knowledgeDocuments.createdAt));

    if (assets.length === 0) {
      json(res, 200, []);
      return;
    }

    const docIds = assets.map((a) => a.id);
    const versionIds = assets.map((a) => a.currentVersionId).filter(Boolean) as string[];

    const [versions, jobs, chunkCounts, embeddingCounts] = await Promise.all([
      versionIds.length > 0
        ? db.select().from(knowledgeDocumentVersions).where(inArray(knowledgeDocumentVersions.id, versionIds))
        : Promise.resolve([]),
      db.select().from(knowledgeProcessingJobs)
        .where(and(eq(knowledgeProcessingJobs.tenantId, orgId), inArray(knowledgeProcessingJobs.knowledgeDocumentId, docIds)))
        .orderBy(desc(knowledgeProcessingJobs.createdAt)),
      db.select({ docId: knowledgeChunks.knowledgeDocumentId, cnt: count() })
        .from(knowledgeChunks)
        .where(and(
          eq(knowledgeChunks.tenantId, orgId),
          inArray(knowledgeChunks.knowledgeDocumentId, docIds),
          eq(knowledgeChunks.chunkActive, true),
        ))
        .groupBy(knowledgeChunks.knowledgeDocumentId),
      db.select({ docId: knowledgeEmbeddings.knowledgeDocumentId, cnt: count() })
        .from(knowledgeEmbeddings)
        .where(and(
          eq(knowledgeEmbeddings.tenantId, orgId),
          inArray(knowledgeEmbeddings.knowledgeDocumentId, docIds),
          eq(knowledgeEmbeddings.embeddingStatus, "completed"),
        ))
        .groupBy(knowledgeEmbeddings.knowledgeDocumentId),
    ]);

    const versionMap = Object.fromEntries(versions.map((v) => [v.id, v]));
    const chunkCountMap = Object.fromEntries(chunkCounts.map((c) => [c.docId, Number(c.cnt)]));
    const embeddingCountMap = Object.fromEntries(embeddingCounts.map((c) => [c.docId, Number(c.cnt)]));

    type JobSummary = { jobType: string; status: string; failureReason: string | null; createdAt: Date };
    const jobsByDoc: Record<string, JobSummary[]> = {};
    for (const j of jobs) {
      if (!jobsByDoc[j.knowledgeDocumentId]) jobsByDoc[j.knowledgeDocumentId] = [];
      jobsByDoc[j.knowledgeDocumentId].push({
        jobType: j.jobType,
        status: j.status,
        failureReason: j.failureReason ?? null,
        createdAt: j.createdAt,
      });
    }

    json(res, 200, assets.map((a) => {
      const ver = a.currentVersionId ? versionMap[a.currentVersionId] : undefined;
      const docJobs = jobsByDoc[a.id] ?? [];
      const latestJob = docJobs[0] ?? null;
      const hasFailed = docJobs.some((j) => j.status === "failed");
      const allDone = docJobs.length > 0 && docJobs.every((j) => j.status === "completed");

      let processingStage: string = a.documentStatus;
      if (allDone) processingStage = "indexed";
      else if (hasFailed) processingStage = "failed";
      else if (latestJob?.status === "running") processingStage = "processing";
      else if (docJobs.some((j) => j.status === "queued")) processingStage = "queued";

      return {
        id: a.id,
        title: a.title,
        documentType: a.documentType,
        status: processingStage,
        mimeType: ver?.mimeType ?? null,
        fileSizeBytes: ver?.fileSizeBytes ?? null,
        versionNumber: a.latestVersionNumber,
        chunkCount: chunkCountMap[a.id] ?? 0,
        embeddingCount: embeddingCountMap[a.id] ?? 0,
        pipeline: docJobs.map((j) => ({ jobType: j.jobType, status: j.status, failureReason: j.failureReason })),
        latestJobType: latestJob?.jobType ?? null,
        latestJobStatus: latestJob?.status ?? null,
        parseStatus: ver?.parseStatus ?? null,
        ocrStatus: ver?.ocrStatus ?? null,
        transcriptStatus: ver?.transcriptStatus ?? null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    }));
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: POST /api/kb/:id/upload ────────────────────────────────────────────
// Lazy-loads busboy + R2 only when this path is hit.

async function uploadAsset(
  orgId: string,
  userId: string,
  kbId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      json(res, 400, { error_code: "INVALID_CONTENT_TYPE", message: "Forventet multipart/form-data" });
      return;
    }

    const ALLOWED_MIME: Record<string, string> = {
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
      "image/jpeg": "image",
      "image/png": "image",
      "image/gif": "image",
      "image/webp": "image",
      "image/tiff": "image",
      "image/bmp": "image",
      "video/mp4": "video",
      "video/quicktime": "video",
      "video/x-msvideo": "video",
      "video/webm": "video",
      "video/mpeg": "video",
    };

    const MAX_FILE_SIZE = 100 * 1024 * 1024;

    const db = await getDb();
    const {
      knowledgeBases, knowledgeDocuments, knowledgeDocumentVersions,
      knowledgeProcessingJobs, knowledgeStorageObjects, knowledgeChunks,
    } = await getSchema();
    const { eq, and } = await getOrm();

    const [kb] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));

    if (!kb) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });
      return;
    }

    // Lazy-load busboy — only needed for multipart upload requests
    const Busboy = (await import("busboy")).default;
    const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: MAX_FILE_SIZE } });

    let fileResult: { filename: string; mimeType: string; buffer: Buffer; truncated: boolean } | null = null;

    await new Promise<void>((resolve, reject) => {
      bb.on("file", (_field: string, stream: NodeJS.ReadableStream & { truncated?: boolean }, info: { filename: string; mimeType: string }) => {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          fileResult = {
            filename: info.filename,
            mimeType: info.mimeType,
            buffer: Buffer.concat(chunks),
            truncated: !!(stream as { truncated?: boolean }).truncated,
          };
        });
        stream.on("error", reject);
      });
      bb.on("finish", resolve);
      bb.on("error", reject);
      req.pipe(bb);
    });

    if (!fileResult) {
      json(res, 400, { error_code: "NO_FILE", message: "Ingen fil modtaget" });
      return;
    }

    const { filename, mimeType, buffer, truncated } = fileResult;

    if (truncated) {
      json(res, 413, {
        error_code: "FILE_TOO_LARGE",
        message: `Filen overstiger den maksimale størrelse på ${MAX_FILE_SIZE / 1024 / 1024} MB`,
      });
      return;
    }

    const documentType: string = ALLOWED_MIME[mimeType] ?? "";
    if (!documentType) {
      json(res, 415, {
        error_code: "UNSUPPORTED_FILE_TYPE",
        message: `Filtypen "${mimeType}" understøttes ikke. Upload PDF, Word, Excel, billede eller video.`,
      });
      return;
    }

    const sizeBytes = buffer.length;
    const { createHash } = await import("crypto");
    const idempotencyKey = createHash("sha256")
      .update(`${orgId}:${kbId}:${filename}:${sizeBytes}:${mimeType}`)
      .digest("hex");

    const existingJob = await db
      .select({ id: knowledgeProcessingJobs.id, knowledgeDocumentId: knowledgeProcessingJobs.knowledgeDocumentId })
      .from(knowledgeProcessingJobs)
      .where(eq(knowledgeProcessingJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existingJob[0]) {
      const [existingDoc] = await db.select().from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, existingJob[0].knowledgeDocumentId));
      if (existingDoc) {
        json(res, 200, {
          id: existingDoc.id,
          title: existingDoc.title,
          documentType: existingDoc.documentType,
          status: existingDoc.documentStatus,
          mimeType,
          fileSizeBytes: sizeBytes,
          versionNumber: 1,
          createdAt: existingDoc.createdAt,
          idempotent: true,
        });
        return;
      }
    }

    const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, "-").slice(0, 200);
    const storageKey = `tenants/${orgId}/uploads/${kbId}/${Date.now()}-${safeFilename}`;
    let r2Uploaded = false;
    let R2_BUCKET = "";

    // Lazy-load R2 client — only needed for upload requests
    const { R2_CONFIGURED, R2_BUCKET: bucket, r2Client } = await import("../../server/lib/r2/r2-client");
    R2_BUCKET = bucket;
    if (R2_CONFIGURED) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: storageKey,
        Body: buffer,
        ContentType: mimeType,
        Metadata: { tenantId: orgId, kbId, originalFilename: filename },
      }));
      r2Uploaded = true;
      console.log(`[kb-upload] R2 upload OK: ${storageKey} (${sizeBytes} bytes)`);
    } else {
      console.warn("[kb-upload] R2 ikke konfigureret — gemmer kun metadata");
    }

    let extractedText: string | null = null;
    if (documentType === "document" && mimeType === "application/pdf") {
      try {
        const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text?.trim() || null;
      } catch (pdfErr) {
        console.warn("[kb-upload] pdf-parse fejlede:", (pdfErr as Error).message);
      }
    } else if (documentType === "document" && ["text/plain", "text/csv", "text/html", "text/markdown"].includes(mimeType)) {
      extractedText = buffer.toString("utf-8").trim();
    }

    const [doc] = await db.insert(knowledgeDocuments).values({
      tenantId: orgId,
      knowledgeBaseId: kbId,
      title: filename,
      documentType,
      sourceType: "upload",
      lifecycleState: "active",
      documentStatus: "processing",
      latestVersionNumber: 1,
      createdBy: userId,
      updatedBy: userId,
      metadata: { storageKey, originalFilename: filename } as never,
    }).returning();

    const [ver] = await db.insert(knowledgeDocumentVersions).values({
      tenantId: orgId,
      knowledgeDocumentId: doc.id,
      versionNumber: 1,
      mimeType,
      fileSizeBytes: sizeBytes,
      isCurrent: true,
      versionStatus: "uploaded",
      sourceLabel: filename,
      uploadedAt: new Date(),
      createdBy: userId,
      parseStatus: documentType === "document" ? "pending" : null,
      ocrStatus: documentType === "image" ? "pending" : null,
      transcriptStatus: documentType === "video" ? "pending" : null,
      metadata: {
        storageKey,
        r2Uploaded,
        extractedText: extractedText ? extractedText.slice(0, 500) : null,
      } as never,
    }).returning();

    await db.update(knowledgeDocuments)
      .set({ currentVersionId: ver.id, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, doc.id));

    await db.insert(knowledgeStorageObjects).values({
      tenantId: orgId,
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

    const primaryJobType =
      documentType === "video" ? "transcript_parse" :
      documentType === "image" ? "ocr_parse" :
      "parse";

    const pipelineJobs = [
      { jobType: primaryJobType, priority: 100, payload: { documentType, mimeType, storageKey, stage: "extract" } },
      { jobType: "chunk", priority: 90, payload: { documentType, mimeType, storageKey, stage: "chunk", dependsOn: primaryJobType } },
      { jobType: "embedding_generate", priority: 80, payload: { documentType, mimeType, storageKey, stage: "embed", dependsOn: "chunk" } },
      { jobType: "index", priority: 70, payload: { documentType, mimeType, storageKey, stage: "index", dependsOn: "embedding_generate" } },
    ];

    const startIdx = documentType === "document" && extractedText ? 1 : 0;
    const jobsToEnqueue = pipelineJobs.slice(startIdx);

    for (const j of jobsToEnqueue) {
      await db.insert(knowledgeProcessingJobs).values({
        tenantId: orgId,
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

    if (extractedText && extractedText.length > 0 && extractedText.length < 50_000) {
      try {
        const CHUNK_SIZE = 1000;
        const OVERLAP = 100;
        const words = extractedText.split(/\s+/).filter(Boolean);
        const chunkTexts: string[] = [];
        for (let i = 0; i < words.length; i += CHUNK_SIZE - OVERLAP) {
          chunkTexts.push(words.slice(i, i + CHUNK_SIZE).join(" "));
          if (i + CHUNK_SIZE >= words.length) break;
        }
        for (let idx = 0; idx < chunkTexts.length; idx++) {
          const text = chunkTexts[idx];
          const chunkHash = createHash("sha256").update(text).digest("hex").slice(0, 32);
          await db.insert(knowledgeChunks).values({
            tenantId: orgId,
            knowledgeBaseId: kbId,
            knowledgeDocumentId: doc.id,
            knowledgeDocumentVersionId: ver.id,
            chunkIndex: idx,
            chunkKey: `${doc.id}:${idx}`,
            chunkText: text,
            chunkHash,
            chunkActive: true,
            tokenEstimate: Math.ceil(text.length / 4),
            chunkStrategy: "word-window",
            chunkVersion: "1.0",
            overlapCharacters: OVERLAP,
          }).onConflictDoNothing();
        }
        await db.update(knowledgeDocuments)
          .set({ documentStatus: "processing", updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, doc.id));
        console.log(`[kb-upload] ${chunkTexts.length} chunks oprettet for doc ${doc.id}`);
      } catch (chunkErr) {
        console.warn("[kb-upload] Chunking fejlede (ikke kritisk):", (chunkErr as Error).message);
      }
    }

    console.log(`[kb-upload] ${orgId}/${kbId}: "${filename}" (${documentType}, ${sizeBytes} bytes) → pipeline: ${jobsToEnqueue.map((j) => j.jobType).join(" → ")}`);

    json(res, 201, {
      id: doc.id,
      title: doc.title,
      documentType: doc.documentType,
      status: doc.documentStatus,
      mimeType,
      fileSizeBytes: sizeBytes,
      versionNumber: 1,
      storageKey,
      pipeline: jobsToEnqueue.map((j) => j.jobType),
      chunksCreated: !!extractedText,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: GET /api/kb/:id/experts ────────────────────────────────────────────

async function listExperts(orgId: string, kbId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { expertKnowledgeBases } = await getSchema();
    const { eq, and } = await getOrm();

    const links = await db
      .select()
      .from(expertKnowledgeBases)
      .where(and(eq(expertKnowledgeBases.knowledgeBaseId, kbId), eq(expertKnowledgeBases.tenantId, orgId)));

    json(res, 200, links.map((l) => ({
      id: l.id,
      expertId: l.expertId,
      knowledgeBaseId: l.knowledgeBaseId,
      createdAt: l.createdAt,
    })));
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: POST /api/kb/:id/experts ───────────────────────────────────────────

async function linkExpert(
  orgId: string,
  userId: string,
  kbId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readJson(req);
    const expertId = body.expertId;

    if (!expertId || typeof expertId !== "string") {
      json(res, 400, { error_code: "MISSING_EXPERT_ID", message: "expertId er påkrævet" });
      return;
    }

    const db = await getDb();
    const { expertKnowledgeBases, knowledgeBases } = await getSchema();
    const { eq, and } = await getOrm();

    const [kb] = await db.select({ id: knowledgeBases.id }).from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));

    if (!kb) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });
      return;
    }

    const [link] = await db.insert(expertKnowledgeBases).values({
      tenantId: orgId,
      expertId,
      knowledgeBaseId: kbId,
      createdBy: userId,
    }).onConflictDoNothing().returning();

    if (!link) {
      const [existing] = await db.select().from(expertKnowledgeBases)
        .where(and(
          eq(expertKnowledgeBases.tenantId, orgId),
          eq(expertKnowledgeBases.expertId, expertId),
          eq(expertKnowledgeBases.knowledgeBaseId, kbId),
        ));
      json(res, 200, { ...existing, idempotent: true });
      return;
    }

    json(res, 201, link);
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: DELETE /api/kb/:id/experts/:expertId ───────────────────────────────

async function unlinkExpert(orgId: string, kbId: string, expertId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { expertKnowledgeBases } = await getSchema();
    const { eq, and } = await getOrm();

    await db.delete(expertKnowledgeBases).where(and(
      eq(expertKnowledgeBases.tenantId, orgId),
      eq(expertKnowledgeBases.expertId, expertId),
      eq(expertKnowledgeBases.knowledgeBaseId, kbId),
    ));

    res.writeHead(204);
    res.end();
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: POST /api/kb/search ────────────────────────────────────────────────
// Lazy-loads kb-retrieval only for search requests.

async function searchKb(orgId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const { queryText, topK, kbIds, expertId, sourceIds } = body as {
      queryText?: string;
      topK?: number;
      kbIds?: string[];
      expertId?: string;
      sourceIds?: string[];
    };

    if (!queryText?.trim()) {
      json(res, 400, { error: "queryText is required" });
      return;
    }

    // Lazy-load retrieval module — only needed for search requests
    const { searchKnowledge } = await import("../../server/lib/knowledge/kb-retrieval");
    const results = await searchKnowledge({
      tenantId: orgId,
      queryText: queryText.trim(),
      topK: Math.min(Number(topK ?? 10), 100),
      kbIds: kbIds?.length ? kbIds : undefined,
      expertId: expertId ?? undefined,
      sourceIds: sourceIds?.length ? sourceIds : undefined,
    });

    json(res, 200, { results, total: results.length });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Route: POST /api/kb/similar ───────────────────────────────────────────────
// Lazy-loads kb-similar only for similarity requests.

async function similarKb(orgId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    const { query, assetId, chunkId, topK, kbId, kbIds, expertId, minScore } = body as {
      query?: string;
      assetId?: string;
      chunkId?: string;
      topK?: number;
      kbId?: string;
      kbIds?: string[];
      expertId?: string;
      minScore?: number;
    };

    let mode: "text" | "asset" | "chunk";
    if (assetId?.trim()) {
      mode = "asset";
    } else if (chunkId?.trim()) {
      mode = "chunk";
    } else if (query?.trim()) {
      mode = "text";
    } else {
      json(res, 400, { error: "Provide one of: query (text mode), assetId (asset mode), or chunkId (chunk mode)" });
      return;
    }

    // Lazy-load similarity module — only needed for similar requests
    const { findSimilarCases } = await import("../../server/lib/knowledge/kb-similar");
    const result = await findSimilarCases({
      tenantId: orgId,
      mode,
      queryText: query?.trim(),
      assetId: assetId?.trim(),
      chunkId: chunkId?.trim(),
      kbId: kbId?.trim(),
      kbIds: kbIds?.length ? kbIds : undefined,
      expertId: expertId?.trim(),
      topK: topK ? Math.min(Number(topK), 50) : undefined,
      minScore: minScore !== undefined ? Number(minScore) : undefined,
    });

    json(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}

// ── URL Router ────────────────────────────────────────────────────────────────
// Strips /api/kb prefix and dispatches by method + path pattern.
// Fixed paths (search, similar) are matched before /:id patterns.

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authResult = await authenticate(req);
  if (authResult.status !== "ok" || !authResult.user) {
    const status = authResult.status === "lockdown" ? 403 : 401;
    json(res, status, { error_code: "UNAUTHENTICATED", message: "Log ind for at fortsætte" });
    return;
  }

  const { user } = authResult;
  const orgId = user.organizationId;
  const userId = user.id;

  // Strip /api/kb prefix and query string
  const rawUrl = req.url ?? "/";
  const path = rawUrl.replace(/^\/api\/kb/, "").replace(/\?.*$/, "").replace(/\/$/, "") || "/";
  const method = req.method?.toUpperCase() ?? "GET";

  // ── /api/kb (root) ────────────────────────────────────────────────────────
  if (path === "" || path === "/") {
    if (method === "GET") return listKnowledgeBases(orgId, res);
    if (method === "POST") return createKnowledgeBase(orgId, userId, req, res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/search (before /:id) ──────────────────────────────────────────
  if (path === "/search") {
    if (method === "POST") return searchKb(orgId, req, res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/similar (before /:id) ────────────────────────────────────────
  if (path === "/similar") {
    if (method === "POST") return similarKb(orgId, req, res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id ───────────────────────────────────────────────────────────
  const idMatch = path.match(/^\/([^/]+)$/);
  if (idMatch) {
    const kbId = idMatch[1];
    if (method === "GET") return getKnowledgeBase(orgId, kbId, res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id/archive ───────────────────────────────────────────────────
  const archiveMatch = path.match(/^\/([^/]+)\/archive$/);
  if (archiveMatch) {
    if (method === "PATCH") return archiveKnowledgeBase(orgId, archiveMatch[1], res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id/assets ────────────────────────────────────────────────────
  const assetsMatch = path.match(/^\/([^/]+)\/assets$/);
  if (assetsMatch) {
    if (method === "GET") return listAssets(orgId, assetsMatch[1], res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id/upload ────────────────────────────────────────────────────
  const uploadMatch = path.match(/^\/([^/]+)\/upload$/);
  if (uploadMatch) {
    if (method === "POST") return uploadAsset(orgId, userId, uploadMatch[1], req, res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id/experts/:expertId (before /experts to avoid clash) ────────
  const expertDeleteMatch = path.match(/^\/([^/]+)\/experts\/([^/]+)$/);
  if (expertDeleteMatch) {
    if (method === "DELETE") return unlinkExpert(orgId, expertDeleteMatch[1], expertDeleteMatch[2], res);
    return methodNotAllowed(res);
  }

  // ── /api/kb/:id/experts ───────────────────────────────────────────────────
  const expertsMatch = path.match(/^\/([^/]+)\/experts$/);
  if (expertsMatch) {
    if (method === "GET") return listExperts(orgId, expertsMatch[1], res);
    if (method === "POST") return linkExpert(orgId, userId, expertsMatch[1], req, res);
    return methodNotAllowed(res);
  }

  return notFound(res);
}
