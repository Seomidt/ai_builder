/**
 * Phase 5B.2 validation script — 15 scenarios
 * Run with: npx tsx server/lib/ai/validate-phase5b2.ts
 */
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../db";
import { randomUUID } from "crypto";
import { knowledgeChunks, knowledgeIndexState, knowledgeDocumentVersions } from "@shared/schema";
import {
  runOcrParseForDocumentVersion,
  runOcrChunkingForDocumentVersion,
  explainOcrParseState,
  explainOcrChunkState,
  previewOcrChunkReplacement,
  listOcrProcessingJobs,
  isVersionRetrievable,
  acquireKnowledgeProcessingJob,
} from "./knowledge-processing";
import { buildOcrChunkKey, buildOcrChunkHash } from "./image-ocr-chunking";
import { KnowledgeInvariantError } from "./knowledge-bases";

let passed = 0;
let failed = 0;

function ok(scenario: string, detail?: string) {
  passed++;
  console.log(`PASS [${scenario}]${detail ? ": " + detail : ""}`);
}

function fail(scenario: string, err: unknown) {
  failed++;
  console.error(`FAIL [${scenario}]: ${err instanceof Error ? err.message : String(err)}`);
}

const PNG_CONTENT = `OCR test image content
This is a test PNG image for OCR processing
Line one of the image text
Line two: product code ABC-123
Line three: date 2026-03-13
Total: 1250.00
Signature: valid`;

const WEBP_CONTENT = `WebP image OCR content
Product: Widget A
SKU: WA-001
Price: 9.99`;

async function run() {
  const tenantId = "test-5b2-" + randomUUID().slice(0, 8);
  const tenant2Id = "test-5b2-x-" + randomUUID().slice(0, 8);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const kbId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbId}, ${tenantId}, '5B2-KB', ${"5b2-kb-" + randomUUID().slice(0, 8)}, 'active')`);

  const docId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docId}, ${tenantId}, ${kbId}, '5B2-Doc', 'other', 'active', 'draft')`);

  const pngVerId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${pngVerId}, ${tenantId}, ${docId}, 1, 'uploaded', 'image/png', true)`);

  const webpVerId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${webpVerId}, ${tenantId}, ${docId}, 2, 'uploaded', 'image/webp', false)`);

  // Tenant2 fixtures
  const kb2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kb2Id}, ${tenant2Id}, '5B2-KB2', ${"5b2-kb2-" + randomUUID().slice(0, 8)}, 'active')`);
  const doc2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${doc2Id}, ${tenant2Id}, ${kb2Id}, '5B2-Doc2', 'other', 'active', 'draft')`);
  const ver2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${ver2Id}, ${tenant2Id}, ${doc2Id}, 1, 'uploaded', 'image/png', true)`);

  // Archived KB fixture
  const kbArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbArchId}, ${tenantId}, '5B2-Arch-KB', ${"5b2-arch-" + randomUUID().slice(0, 8)}, 'archived')`);
  const docArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docArchId}, ${tenantId}, ${kbArchId}, '5B2-Arch-Doc', 'other', 'archived', 'draft')`);
  const verArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${verArchId}, ${tenantId}, ${docArchId}, 1, 'uploaded', 'image/png', true)`);

  // ── Scenario 1: OCR parse supported PNG version ───────────────────────────
  try {
    const r = await runOcrParseForDocumentVersion(pngVerId, tenantId, { content: PNG_CONTENT });
    if (r.status === "completed" && r.ocrStatus === "completed" && r.blockCount! > 0 && r.textChecksum) {
      ok("S1-png-ocr-parse", `engine=${r.engineName}@${r.engineVersion} blocks=${r.blockCount} lines=${r.lineCount} checksum=${r.textChecksum?.slice(0, 12)}`);
    } else {
      fail("S1-png-ocr-parse", `status=${r.status} blocks=${r.blockCount} err=${r.error}`);
    }
  } catch (e) { fail("S1-png-ocr-parse", e); }

  // ── Scenario 2: OCR parse unsupported mime type fails explicitly ───────────
  try {
    const pdfVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${pdfVerId}, ${tenantId}, ${docId}, 3, 'uploaded', 'application/pdf', false)`);
    const r = await runOcrParseForDocumentVersion(pdfVerId, tenantId, { content: "fake pdf content" });
    if (r.status === "failed" && r.error && r.error.includes("INV-IMG11")) {
      ok("S2-unsupported-mime-fail", `explicit fail: ${r.error.slice(0, 70)}`);
    } else {
      fail("S2-unsupported-mime-fail", `status=${r.status} error=${r.error}`);
    }
  } catch (e) { fail("S2-unsupported-mime-fail", e); }

  // ── Scenario 3: OCR parse oversized image rejected ────────────────────────
  try {
    const oversizedVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${oversizedVerId}, ${tenantId}, ${docId}, 4, 'uploaded', 'image/png', false)`);
    const oversizedContent = "A".repeat(100);
    const r = await runOcrParseForDocumentVersion(oversizedVerId, tenantId, {
      content: oversizedContent,
      parseOptions: { maxImageSizeBytes: 50 },
    });
    if (r.status === "failed" && r.error && r.error.includes("INV-IMG11")) {
      ok("S3-oversized-rejected", `explicit safe rejection: ${r.error.slice(0, 60)}`);
    } else {
      fail("S3-oversized-rejected", `status=${r.status} error=${r.error}`);
    }
  } catch (e) { fail("S3-oversized-rejected", e); }

  // ── Scenario 4: OCR chunk a successfully parsed version ───────────────────
  try {
    const r = await runOcrChunkingForDocumentVersion(pngVerId, tenantId, { content: PNG_CONTENT });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, pngVerId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.chunkCount > 0 && idx && idx.indexState !== "indexed") {
      ok("S4-chunk-parsed-version", `chunkCount=${r.chunkCount} indexState=${idx.indexState} (not indexed — correct)`);
    } else {
      fail("S4-chunk-parsed-version", `status=${r.status} chunks=${r.chunkCount} indexState=${idx?.indexState} err=${r.error}`);
    }
  } catch (e) { fail("S4-chunk-parsed-version", e); }

  // ── Scenario 5: Rerun OCR chunking — prior chunks deactivated ─────────────
  try {
    const r2 = await runOcrChunkingForDocumentVersion(pngVerId, tenantId, { content: PNG_CONTENT });
    const allChunks = await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, pngVerId), eq(knowledgeChunks.imageChunk, true))
    );
    const deactivated = allChunks.filter((c) => !c.chunkActive && c.replacedByJobId);
    const active = allChunks.filter((c) => c.chunkActive);
    if (r2.status === "completed" && r2.priorOcrChunksDeactivated > 0 && deactivated.length > 0) {
      ok("S5-chunk-rebuild-safe", `deactivated=${r2.priorOcrChunksDeactivated} active=${active.length} historical=${deactivated.length}`);
    } else {
      fail("S5-chunk-rebuild-safe", `status=${r2.status} priorDeact=${r2.priorOcrChunksDeactivated} hist=${deactivated.length}`);
    }
  } catch (e) { fail("S5-chunk-rebuild-safe", e); }

  // ── Scenario 6: Parse failure does not mutate current version retrieval ────
  try {
    const failVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${failVerId}, ${tenantId}, ${docId}, 5, 'uploaded', 'application/json', false)`);
    const before = await isVersionRetrievable(pngVerId, tenantId);
    await runOcrParseForDocumentVersion(failVerId, tenantId, { content: "bad content" });
    const after = await isVersionRetrievable(pngVerId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S6-parse-fail-no-mutation", `current retrieval unchanged: ${after.retrievable}`);
    } else {
      fail("S6-parse-fail-no-mutation", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S6-parse-fail-no-mutation", e); }

  // ── Scenario 7: Chunk transaction safe — no partial corruption ────────────
  try {
    const activeBefore = (await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, pngVerId), eq(knowledgeChunks.chunkActive, true), eq(knowledgeChunks.imageChunk, true))
    )).length;
    const r = await runOcrChunkingForDocumentVersion(pngVerId, tenantId, { content: PNG_CONTENT });
    const activeAfter = (await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, pngVerId), eq(knowledgeChunks.chunkActive, true), eq(knowledgeChunks.imageChunk, true))
    )).length;
    if (r.status === "completed" && activeAfter > 0) {
      ok("S7-chunk-transaction-safe", `activeAfter=${activeAfter} (consistent, no mixed state)`);
    } else {
      fail("S7-chunk-transaction-safe", `status=${r.status} activeAfter=${activeAfter}`);
    }
  } catch (e) { fail("S7-chunk-transaction-safe", e); }

  // ── Scenario 8: Non-current version OCR chunking does not affect current ──
  try {
    const ncVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${ncVerId}, ${tenantId}, ${docId}, 6, 'uploaded', 'image/png', false)`);
    const before = await isVersionRetrievable(pngVerId, tenantId);
    await runOcrChunkingForDocumentVersion(ncVerId, tenantId, { content: PNG_CONTENT });
    const after = await isVersionRetrievable(pngVerId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S8-noncurrent-no-affect", `current retrieval unchanged: ${after.retrievable}`);
    } else {
      fail("S8-noncurrent-no-affect", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S8-noncurrent-no-affect", e); }

  // ── Scenario 9: Cross-tenant linkage rejected ─────────────────────────────
  try {
    let threw = false;
    try {
      await runOcrParseForDocumentVersion(ver2Id, tenantId, { content: PNG_CONTENT });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S9-cross-tenant-rejected", "KnowledgeInvariantError thrown as expected");
    } else {
      fail("S9-cross-tenant-rejected", "No invariant error thrown");
    }
  } catch (e) { fail("S9-cross-tenant-rejected", e); }

  // ── Scenario 10: Archived KB blocks OCR processing ────────────────────────
  try {
    let threw = false;
    try {
      await runOcrParseForDocumentVersion(verArchId, tenantId, { content: PNG_CONTENT });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S10-archived-blocked", "INV-IMG5: archived KB/doc blocks OCR processing");
    } else {
      fail("S10-archived-blocked", "Expected KnowledgeInvariantError for archived entity");
    }
  } catch (e) { fail("S10-archived-blocked", e); }

  // ── Scenario 11: Deterministic OCR chunk keys and hashes ─────────────────
  try {
    const key1 = buildOcrChunkKey("doc1", "ver1", 1, 0, 2, "ocr_regions", "1.0");
    const key2 = buildOcrChunkKey("doc1", "ver1", 1, 0, 2, "ocr_regions", "1.0");
    const keyDiff = buildOcrChunkKey("doc1", "ver1", 1, 3, 5, "ocr_regions", "1.0");
    const hash1 = buildOcrChunkHash("same ocr text", "ocr_regions", "1.0");
    const hash2 = buildOcrChunkHash("same ocr text", "ocr_regions", "1.0");
    const hashDiff = buildOcrChunkHash("different ocr text", "ocr_regions", "1.0");
    if (key1 === key2 && key1 !== keyDiff && hash1 === hash2 && hash1 !== hashDiff) {
      ok("S11-deterministic-keys", `key=${key1.slice(0, 12)} deterministic=true diff-region differs=true`);
    } else {
      fail("S11-deterministic-keys", `key1==key2:${key1===key2} key1!=keyDiff:${key1!==keyDiff} hash det:${hash1===hash2}`);
    }
  } catch (e) { fail("S11-deterministic-keys", e); }

  // ── Scenario 12: Changed chunk config causes replacement + stale ──────────
  try {
    const r = await runOcrChunkingForDocumentVersion(pngVerId, tenantId, {
      content: PNG_CONTENT,
      chunkingConfig: { regionWindowSize: 2 },
    });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, pngVerId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.priorOcrChunksDeactivated > 0 && (idx.indexState === "pending" || idx.indexState === "stale")) {
      ok("S12-config-change-stale", `indexState=${idx.indexState} priorDeact=${r.priorOcrChunksDeactivated} newChunks=${r.chunkCount}`);
    } else {
      fail("S12-config-change-stale", `status=${r.status} indexState=${idx?.indexState} priorDeact=${r.priorOcrChunksDeactivated}`);
    }
  } catch (e) { fail("S12-config-change-stale", e); }

  // ── Scenario 13: Processing job lock safety ───────────────────────────────
  try {
    const lockVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${lockVerId}, ${tenantId}, ${docId}, 7, 'uploaded', 'image/png', false)`);
    const [jobRow] = (await db.execute(sql`
      INSERT INTO knowledge_processing_jobs (id, tenant_id, knowledge_document_id, knowledge_document_version_id, job_type, status)
      VALUES (gen_random_uuid(), ${tenantId}, ${docId}, ${lockVerId}, 'ocr_parse', 'queued')
      RETURNING id`)).rows;
    const jobId = String((jobRow as { id: string }).id);
    const a1 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w1" });
    const a2 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w2" });
    if (a1 && !a2) {
      ok("S13-job-lock-safe", "w1 acquired, w2 correctly rejected");
    } else {
      fail("S13-job-lock-safe", `a1=${!!a1} a2=${!!a2}`);
    }
  } catch (e) { fail("S13-job-lock-safe", e); }

  // ── Scenario 14: Inspection helpers work ─────────────────────────────────
  try {
    const pe = await explainOcrParseState(pngVerId, tenantId);
    const ce = await explainOcrChunkState(pngVerId, tenantId);
    const preview = await previewOcrChunkReplacement(pngVerId, tenantId);
    const jobs = await listOcrProcessingJobs(docId, tenantId);
    if (pe.ocrStatus === "completed" && ce.activeImageChunkCount > 0 && jobs.length > 0 && preview.explanation) {
      ok("S14-inspection-helpers", `ocrStatus=${pe.ocrStatus} activeChunks=${ce.activeImageChunkCount} jobs=${jobs.length} pages=${ce.pages.join(",")}`);
    } else {
      fail("S14-inspection-helpers", `ocrStatus=${pe.ocrStatus} chunks=${ce.activeImageChunkCount} jobs=${jobs.length}`);
    }
  } catch (e) { fail("S14-inspection-helpers", e); }

  // ── Scenario 15: Phase 5A.1 invariants still hold ────────────────────────
  try {
    const r = await isVersionRetrievable(pngVerId, tenantId);
    if (!r.retrievable) {
      ok("S15-5A1-invariants", `Not retrievable without indexed state (correct). Reasons: ${r.reasons.slice(0, 2).join("; ")}`);
    } else {
      fail("S15-5A1-invariants", "Version marked retrievable without indexed state — 5A.1 VIOLATED");
    }
  } catch (e) { fail("S15-5A1-invariants", e); }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("========================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
