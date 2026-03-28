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
// Thin HTTP adapter: parse multipart form, delegate all business logic to
// kb-upload-service. Lazy-loads busboy only for this route.

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

    // Lazy-load busboy — HTTP-specific, only needed here
    const { MAX_UPLOAD_BYTES } = await import("../../server/lib/knowledge/kb-upload-service");
    const Busboy = (await import("busboy")).default;
    const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: MAX_UPLOAD_BYTES } });

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
        message: `Filen overstiger den maksimale størrelse på ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
      });
      return;
    }

    // Delegate all business logic to the upload service
    const { uploadAssetToKb, UploadServiceError, UPLOAD_ERRORS } =
      await import("../../server/lib/knowledge/kb-upload-service");

    const result = await uploadAssetToKb({
      tenantId: orgId,
      knowledgeBaseId: kbId,
      uploadedBy: userId,
      filename,
      mimeType,
      buffer,
    });

    json(res, result.idempotent ? 200 : 201, result);
  } catch (err) {
    // Map typed service errors to HTTP status codes
    const { UploadServiceError, UPLOAD_ERRORS } =
      await import("../../server/lib/knowledge/kb-upload-service");

    if (err instanceof UploadServiceError) {
      if (err.errorCode === UPLOAD_ERRORS.KB_NOT_FOUND) {
        json(res, 404, { error_code: "NOT_FOUND", message: err.message });
      } else if (err.errorCode === UPLOAD_ERRORS.UNSUPPORTED_MIME) {
        json(res, 415, { error_code: "UNSUPPORTED_FILE_TYPE", message: err.message });
      } else if (err.errorCode === UPLOAD_ERRORS.FILE_TOO_LARGE) {
        json(res, 413, { error_code: "FILE_TOO_LARGE", message: err.message });
      } else {
        handleError(res, err);
      }
      return;
    }
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
  // Strip /api/kb prefix and query string early (needed for healthz check)
  const rawUrl = req.url ?? "/";
  const path = rawUrl.replace(/^\/api\/kb/, "").replace(/\?.*$/, "").replace(/\/$/, "") || "/";
  const method = req.method?.toUpperCase() ?? "GET";

  // ── /api/kb/healthz — public diagnostic endpoint (no auth) ────────────────
  if (path === "/healthz" && method === "GET") {
    try {
      const db = await getDb();
      const { knowledgeBases } = await getSchema();
      const { count } = await getOrm();
      const [{ cnt }] = await db.select({ cnt: count() }).from(knowledgeBases);
      json(res, 200, { ok: true, kb_count: Number(cnt), ts: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { ok: false, error: message, ts: new Date().toISOString() });
    }
    return;
  }

  try {
  const authResult = await authenticate(req);
  if (authResult.status !== "ok" || !authResult.user) {
    const status = authResult.status === "lockdown" ? 403 : 401;
    json(res, status, { error_code: "UNAUTHENTICATED", message: "Log ind for at fortsætte" });
    return;
  }

  const { user } = authResult;
  const orgId = user.organizationId;
  const userId = user.id;

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vercel/kb] unhandled handler error:", message);
    if (!res.headersSent) {
      json(res, 500, { error_code: "INTERNAL_ERROR", message });
    }
  }
}
