/**
 * KB Worker — Storage 1.3
 *
 * Background polling worker for knowledgeProcessingJobs.
 *
 * NOT auto-started from the web process.
 * Start via: tsx server/worker.ts  (or KB_WORKER=true tsx server/index.ts)
 *
 * Safety invariants:
 *  - Picks jobs with FOR UPDATE SKIP LOCKED (no double-processing)
 *  - Env-configurable concurrency and poll interval (Part G)
 *  - Max 3 retry attempts per job
 *  - Never marks "indexed" unless real searchable units exist
 *  - OCR: uses OpenAI Vision adapter (Part D)
 *  - Transcript: explicit failure — no provider yet
 */

import { db } from "../../db.ts";
import {
  knowledgeProcessingJobs, knowledgeDocuments,
  knowledgeDocumentVersions, knowledgeChunks,
  knowledgeEmbeddings, knowledgeIndexState,
} from "@shared/schema";
import { eq, and, count, sql } from "drizzle-orm";
import { generateChunkEmbeddings, embeddingCount } from "./kb-embeddings.ts";
import { fetchImageFromR2AndOcr, OcrProviderError } from "./kb-ocr-adapter.ts";

const MAX_ATTEMPTS = 3;

let _workerRunning = false;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _maxConcurrent = 3;

// ── startKbWorker ──────────────────────────────────────────────────────────────
// Accepts optional config so server/worker.ts can pass env-driven values.

export function startKbWorker(opts?: { pollIntervalMs?: number; maxConcurrent?: number }): void {
  if (_intervalId) return;
  const pollMs = opts?.pollIntervalMs ?? parseInt(process.env.KB_WORKER_POLL_INTERVAL_MS ?? "5000", 10);
  _maxConcurrent = opts?.maxConcurrent ?? parseInt(process.env.KB_WORKER_MAX_CONCURRENT ?? "3", 10);

  console.log(`[kb-worker] starting — poll=${pollMs}ms  maxConcurrent=${_maxConcurrent}`);
  _intervalId = setInterval(() => {
    if (_workerRunning) return;
    _workerRunning = true;
    runWorkerCycle()
      .catch((err) => console.error("[kb-worker] cycle error:", err))
      .finally(() => { _workerRunning = false; });
  }, pollMs);
}

export function stopKbWorker(): void {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  console.log("[kb-worker] stopped");
}

// ── runWorkerCycle ─────────────────────────────────────────────────────────────

async function runWorkerCycle(): Promise<void> {
  // Claim queued jobs atomically — SKIP LOCKED prevents double-processing
  // Uses raw SQL because Drizzle doesn't expose SKIP LOCKED yet
  const pg = await import("pg");
  const client = new pg.default.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let jobs: Array<Record<string, unknown>> = [];
  try {
    const result = await client.query(`
      SELECT * FROM knowledge_processing_jobs
      WHERE status = 'queued'
        AND attempt_count < max_attempts
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    `, [_maxConcurrent]);
    jobs = result.rows;

    if (jobs.length === 0) return;

    // Mark all as running before releasing lock (Part F: observability)
    for (const job of jobs) {
      await client.query(
        `UPDATE knowledge_processing_jobs SET status = 'running', started_at = NOW(), attempt_count = attempt_count + 1 WHERE id = $1`,
        [job["id"]],
      );
    }
  } finally {
    await client.end();
  }

  // Process jobs concurrently (up to _maxConcurrent)
  await Promise.all(jobs.map((job) => processJob(job).catch((err) => {
    console.error(`[kb-worker] job ${job["id"] as string} unhandled crash:`, err);
  })));
}

// ── processJob ────────────────────────────────────────────────────────────────

async function processJob(job: Record<string, unknown>): Promise<void> {
  const jobId     = job["id"] as string;
  const jobType   = job["job_type"] as string;
  const tenantId  = job["tenant_id"] as string;
  const docId     = job["knowledge_document_id"] as string;
  const versionId = job["knowledge_document_version_id"] as string | null;
  const payload   = (job["payload"] as Record<string, unknown>) ?? {};

  console.log(`[kb-worker] processing job ${jobId} type=${jobType} doc=${docId}`);

  try {
    switch (jobType) {
      case "parse":
        await handleParse({ tenantId, docId, versionId, payload });
        break;
      case "ocr_parse":
        await handleOcrParse({ tenantId, docId, versionId, payload });
        break;
      case "transcript_parse":
        await handleTranscriptParse({ tenantId, docId, versionId });
        break;
      case "chunk":
        await handleChunk({ tenantId, docId, versionId, payload });
        break;
      case "embedding_generate":
        await handleEmbedding({ tenantId, docId, versionId });
        break;
      case "index":
        await handleIndex({ tenantId, docId, versionId });
        break;
      default:
        throw new Error(`Unknown job type: ${jobType}`);
    }

    // Mark completed
    await db.update(knowledgeProcessingJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(knowledgeProcessingJobs.id, jobId));

    console.log(`[kb-worker] job ${jobId} completed`);
  } catch (err) {
    const reason = (err as Error).message ?? String(err);
    const attemptCount = Number(job["attempt_count"] ?? 1);

    if (attemptCount >= MAX_ATTEMPTS) {
      // Final failure
      await db.update(knowledgeProcessingJobs)
        .set({ status: "failed", failureReason: reason, completedAt: new Date() })
        .where(eq(knowledgeProcessingJobs.id, jobId));

      // Mark document failed if critical job
      if (["parse", "ocr_parse", "transcript_parse", "embedding_generate"].includes(jobType)) {
        await db.update(knowledgeDocuments)
          .set({ documentStatus: "failed", updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, docId));
      }

      console.error(`[kb-worker] job ${jobId} FAILED after ${attemptCount} attempts: ${reason}`);
    } else {
      // Requeue for retry
      await db.update(knowledgeProcessingJobs)
        .set({ status: "queued", failureReason: `Attempt ${attemptCount}: ${reason}` })
        .where(eq(knowledgeProcessingJobs.id, jobId));
      console.warn(`[kb-worker] job ${jobId} requeued (attempt ${attemptCount}/${MAX_ATTEMPTS}): ${reason}`);
    }
  }
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleParse(params: {
  tenantId: string; docId: string; versionId: string | null; payload: Record<string, unknown>;
}): Promise<void> {
  const { tenantId, docId, versionId, payload } = params;

  // Get file from R2 if storageKey is present
  const storageKey = payload["storageKey"] as string | undefined;
  const mimeType   = payload["mimeType"]   as string | undefined;
  let extractedText: string | null = payload["extractedText"] as string | null ?? null;

  if (!extractedText && storageKey) {
    extractedText = await fetchTextFromR2(storageKey, mimeType ?? "application/octet-stream");
  }

  if (!extractedText) {
    throw new Error("No extractable text content found for document");
  }

  // Update version with parse status
  if (versionId) {
    await db.update(knowledgeDocumentVersions)
      .set({
        parseStatus: "completed",
        parseCompletedAt: new Date(),
        characterCount: extractedText.length,
        normalizedCharacterCount: extractedText.trim().length,
        parserName: mimeType === "application/pdf" ? "pdf-parse" : "text",
        parserVersion: "1.0",
        // Store first 500 chars as preview in metadata
        metadata: { extractedTextPreview: extractedText.slice(0, 500), fullLength: extractedText.length } as any,
      })
      .where(eq(knowledgeDocumentVersions.id, versionId));
  }

  // Pass extracted text downstream via job payload update (for chunk job)
  // Chunk job picks it up from extractedText in its own payload
  await db.update(knowledgeProcessingJobs)
    .set({ payload: { ...payload, extractedText: extractedText.slice(0, 100_000) } as any })
    .where(and(
      eq(knowledgeProcessingJobs.knowledgeDocumentId, docId),
      eq(knowledgeProcessingJobs.jobType, "chunk"),
      eq(knowledgeProcessingJobs.status, "queued"),
    ));
}

async function handleOcrParse(params: {
  tenantId: string; docId: string; versionId: string | null; payload: Record<string, unknown>;
}): Promise<void> {
  const { tenantId, docId, versionId, payload } = params;
  const storageKey = payload["storageKey"] as string | undefined;
  const mimeType   = payload["mimeType"]   as string | undefined;

  if (!storageKey || !mimeType) {
    throw new Error("OCR job missing storageKey or mimeType in payload");
  }

  // Part D — Real OCR via OpenAI Vision (kb-ocr-adapter.ts)
  let extractedText: string;
  try {
    extractedText = await fetchImageFromR2AndOcr(storageKey, mimeType);
  } catch (err) {
    const reason = (err as Error).message;
    if (versionId) {
      await db.update(knowledgeDocumentVersions)
        .set({ ocrStatus: "failed", ocrFailureReason: reason })
        .where(eq(knowledgeDocumentVersions.id, versionId));
    }
    throw err;
  }

  if (!extractedText || extractedText.trim().length === 0) {
    // Image had no readable text — mark OCR completed with 0 chars (valid outcome)
    if (versionId) {
      await db.update(knowledgeDocumentVersions)
        .set({ ocrStatus: "completed", ocrCompletedAt: new Date(), ocrEngineName: "openai-gpt4o-mini", characterCount: 0 })
        .where(eq(knowledgeDocumentVersions.id, versionId));
    }
    throw new Error("OCR completed but no text was extracted from image — cannot chunk/embed");
  }

  // Update version with OCR result
  if (versionId) {
    await db.update(knowledgeDocumentVersions)
      .set({
        ocrStatus:      "completed",
        ocrCompletedAt: new Date(),
        ocrEngineName:  "openai-gpt4o-mini",
        characterCount:  extractedText.length,
        metadata: { extractedTextPreview: extractedText.slice(0, 500), fullLength: extractedText.length } as any,
      })
      .where(eq(knowledgeDocumentVersions.id, versionId));
  }

  // Pass extracted text to pending chunk job (same as parse handler)
  await db.update(knowledgeProcessingJobs)
    .set({ payload: { ...payload, extractedText: extractedText.slice(0, 100_000) } as any })
    .where(and(
      eq(knowledgeProcessingJobs.knowledgeDocumentId, docId),
      eq(knowledgeProcessingJobs.jobType, "chunk"),
      eq(knowledgeProcessingJobs.status, "queued"),
    ));

  console.log(`[kb-worker] OCR completed doc=${docId} chars=${extractedText.length}`);
}

async function handleTranscriptParse(params: { tenantId: string; docId: string; versionId: string | null }): Promise<void> {
  // Part H — No fake success. Transcript provider not yet integrated.
  if (params.versionId) {
    await db.update(knowledgeDocumentVersions)
      .set({ transcriptStatus: "failed", transcriptFailureReason: "Transcript provider not configured — integrate Whisper or cloud STT to enable" })
      .where(eq(knowledgeDocumentVersions.id, params.versionId));
  }
  throw new Error("Transcript provider not available — asset remains pending until STT integration is configured");
}

async function handleChunk(params: {
  tenantId: string; docId: string; versionId: string | null; payload: Record<string, unknown>;
}): Promise<void> {
  const { tenantId, docId, versionId, payload } = params;

  const extractedText = payload["extractedText"] as string | undefined;
  if (!extractedText || extractedText.trim().length === 0) {
    throw new Error("No extracted text available for chunking");
  }

  // Get knowledge base ID from document
  const [doc] = await db.select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId })
    .from(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId));
  if (!doc) throw new Error(`Document ${docId} not found`);

  const kbId = doc.knowledgeBaseId;

  // Word-window chunking: 1000 words / 100 word overlap
  const CHUNK_SIZE = 1000;
  const OVERLAP    = 100;
  const words      = extractedText.trim().split(/\s+/).filter(Boolean);
  const chunkTexts: string[] = [];
  for (let i = 0; i < words.length; i += (CHUNK_SIZE - OVERLAP)) {
    chunkTexts.push(words.slice(i, i + CHUNK_SIZE).join(" "));
    if (i + CHUNK_SIZE >= words.length) break;
  }
  if (chunkTexts.length === 0) chunkTexts.push(extractedText.trim());

  const { createHash } = await import("crypto");

  // Deactivate old chunks for idempotency
  if (versionId) {
    await db.update(knowledgeChunks)
      .set({ chunkActive: false, replacedAt: new Date() })
      .where(and(
        eq(knowledgeChunks.tenantId, tenantId),
        eq(knowledgeChunks.knowledgeDocumentVersionId, versionId),
        eq(knowledgeChunks.chunkActive, true),
      ));
  }

  for (let idx = 0; idx < chunkTexts.length; idx++) {
    const text     = chunkTexts[idx]!;
    const chunkKey  = `${docId}:${idx}`;
    const chunkHash = createHash("sha256").update(text).digest("hex").slice(0, 32);

    await db.insert(knowledgeChunks).values({
      tenantId,
      knowledgeBaseId:            kbId,
      knowledgeDocumentId:        docId,
      knowledgeDocumentVersionId: versionId ?? "",
      chunkIndex:                 idx,
      chunkKey,
      chunkText:                  text,
      chunkHash,
      chunkActive:                true,
      tokenEstimate:              Math.ceil(text.length / 4),
      chunkStrategy:              "word-window",
      chunkVersion:               "1.0",
      overlapCharacters:          OVERLAP,
    }).onConflictDoNothing();
  }

  console.log(`[kb-worker] chunked doc=${docId}: ${chunkTexts.length} chunks`);
}

async function handleEmbedding(params: {
  tenantId: string; docId: string; versionId: string | null;
}): Promise<void> {
  const { tenantId, docId, versionId } = params;
  if (!versionId) throw new Error("Missing versionId for embedding job");

  const [doc] = await db.select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId })
    .from(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId));
  if (!doc) throw new Error(`Document ${docId} not found`);

  const result = await generateChunkEmbeddings({
    tenantId,
    knowledgeBaseId:            doc.knowledgeBaseId,
    knowledgeDocumentId:        docId,
    knowledgeDocumentVersionId: versionId,
    maxChunks:                  500,
  });

  if (result.generated === 0 && result.skipped === 0) {
    throw new Error(`Embedding generation produced 0 results (failed=${result.failed}) — check OPENAI_API_KEY`);
  }

  // Part E: update version embedding status
  await db.update(knowledgeDocumentVersions)
    .set({ metadata: { embeddingResult: result } as any })
    .where(eq(knowledgeDocumentVersions.id, versionId));
}

async function handleIndex(params: {
  tenantId: string; docId: string; versionId: string | null;
}): Promise<void> {
  const { tenantId, docId, versionId } = params;

  // Part E — Only mark indexed if real searchable units exist
  const [chunkRow] = await db
    .select({ cnt: count() })
    .from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.tenantId, tenantId),
      eq(knowledgeChunks.knowledgeDocumentId, docId),
      eq(knowledgeChunks.chunkActive, true),
    ));

  const chunkCount = Number(chunkRow?.cnt ?? 0);
  if (chunkCount === 0) {
    throw new Error("No active chunks exist — cannot mark document as indexed");
  }

  // Check embeddings if versionId available
  let embCount = 0;
  if (versionId) {
    embCount = await embeddingCount(tenantId, versionId);
  }

  // Register in knowledgeIndexState
  const [doc] = await db.select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId })
    .from(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId));

  if (doc) {
    await db.insert(knowledgeIndexState).values({
      tenantId,
      knowledgeBaseId:            doc.knowledgeBaseId,
      knowledgeDocumentId:        docId,
      knowledgeDocumentVersionId: versionId ?? undefined,
      vectorIndexed:              embCount > 0,
      lexicalIndexed:             chunkCount > 0,
      chunkCount,
      embeddingCount:             embCount,
      indexedAt:                  new Date(),
      vectorIndexedAt:            embCount > 0 ? new Date() : null,
      lexicalIndexedAt:           chunkCount > 0 ? new Date() : null,
    } as any).onConflictDoNothing();
  }

  // Part E — Update document status to "indexed"
  await db.update(knowledgeDocuments)
    .set({ documentStatus: "ready", updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, docId));

  if (versionId) {
    await db.update(knowledgeDocumentVersions)
      .set({ versionStatus: "indexed", processingCompletedAt: new Date() })
      .where(eq(knowledgeDocumentVersions.id, versionId));
  }

  console.log(`[kb-worker] indexed doc=${docId} chunks=${chunkCount} embeddings=${embCount}`);
}

// ── fetchTextFromR2 ────────────────────────────────────────────────────────────
// Fetches file from R2 and extracts text content based on MIME type.

async function fetchTextFromR2(storageKey: string, mimeType: string): Promise<string | null> {
  try {
    const { R2_CONFIGURED, R2_BUCKET, r2Client } = await import("../r2/r2-client");
    if (!R2_CONFIGURED) return null;

    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: storageKey }));

    const chunks: Buffer[] = [];
    const stream = resp.Body as NodeJS.ReadableStream;
    await new Promise<void>((res, rej) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", res);
      stream.on("error", rej);
    });
    const buffer = Buffer.concat(chunks);

    if (mimeType === "application/pdf") {
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const parsed = await pdfParse(buffer);
      return parsed.text?.trim() || null;
    } else if (mimeType.startsWith("text/")) {
      return buffer.toString("utf-8").trim();
    }
    return null;
  } catch (err) {
    console.warn("[kb-worker] R2 fetch failed:", (err as Error).message);
    return null;
  }
}
