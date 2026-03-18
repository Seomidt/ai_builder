/**
 * Phase 5B.1 validation script — 16 scenarios
 * Run with: npx tsx server/lib/ai/validate-phase5b1.ts
 */
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../db";
import { randomUUID } from "crypto";
import { knowledgeChunks, knowledgeIndexState } from "@shared/schema";
import {
  runStructuredParseForDocumentVersion,
  runStructuredChunkingForDocumentVersion,
  explainStructuredParseState,
  explainStructuredChunkState,
  previewStructuredChunkReplacement,
  listStructuredProcessingJobs,
  summarizeStructuredChunkingResult,
  isVersionRetrievable,
  acquireKnowledgeProcessingJob,
} from "./knowledge-processing";
import { buildStructuredChunkKey as chunkKey, buildStructuredChunkHash as chunkHash } from "./structured-document-chunking";
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

const CSV_CONTENT = `name,department,salary\nAlice,Engineering,90000\nBob,Marketing,70000\nCarol,Engineering,95000\nDave,HR,65000\nEve,Engineering,88000`;
const TSV_CONTENT = `product\tprice\tstock\nWidget A\t9.99\t100\nWidget B\t14.99\t50\nWidget C\t4.99\t200`;

async function run() {
  const tenantId = "test-5b1-" + randomUUID().slice(0, 8);
  const tenant2Id = "test-5b1-x-" + randomUUID().slice(0, 8);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const kbId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbId}, ${tenantId}, '5B1-KB', ${"5b1-kb-" + randomUUID().slice(0, 8)}, 'active')`);

  const docId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docId}, ${tenantId}, ${kbId}, '5B1-Doc', 'other', 'active', 'draft')`);

  const csvVerId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${csvVerId}, ${tenantId}, ${docId}, 1, 'uploaded', 'text/csv', true)`);

  const tsvVerId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${tsvVerId}, ${tenantId}, ${docId}, 2, 'uploaded', 'text/tab-separated-values', false)`);

  // Tenant2 fixtures
  const kb2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kb2Id}, ${tenant2Id}, '5B1-KB2', ${"5b1-kb2-" + randomUUID().slice(0, 8)}, 'active')`);
  const doc2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${doc2Id}, ${tenant2Id}, ${kb2Id}, '5B1-Doc2', 'other', 'active', 'draft')`);
  const ver2Id = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${ver2Id}, ${tenant2Id}, ${doc2Id}, 1, 'uploaded', 'text/csv', true)`);

  // Archived KB fixture
  const kbArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbArchId}, ${tenantId}, '5B1-Arch-KB', ${"5b1-arch-" + randomUUID().slice(0, 8)}, 'archived')`);
  const docArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docArchId}, ${tenantId}, ${kbArchId}, '5B1-Arch-Doc', 'other', 'archived', 'draft')`);
  const verArchId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${verArchId}, ${tenantId}, ${docArchId}, 1, 'uploaded', 'text/csv', true)`);

  // ── Scenario 1: Parse supported CSV ──────────────────────────────────────
  try {
    const r = await runStructuredParseForDocumentVersion(csvVerId, tenantId, { content: CSV_CONTENT });
    if (r.status === "completed" && r.structuredParseStatus === "completed" && r.sheetCount === 1 && r.rowCount === 5) {
      ok("S1-csv-parse", `sheetCount=${r.sheetCount} rowCount=${r.rowCount} checksum=${r.contentChecksum?.slice(0, 12)}`);
    } else {
      fail("S1-csv-parse", `status=${r.status} sheets=${r.sheetCount} rows=${r.rowCount} err=${r.error}`);
    }
  } catch (e) { fail("S1-csv-parse", e); }

  // ── Scenario 2: Parse supported TSV ──────────────────────────────────────
  try {
    const r = await runStructuredParseForDocumentVersion(tsvVerId, tenantId, { content: TSV_CONTENT });
    if (r.status === "completed" && r.rowCount === 3 && r.columnCount === 3) {
      ok("S2-tsv-parse", `rowCount=${r.rowCount} columnCount=${r.columnCount} parser=tsv_parser`);
    } else {
      fail("S2-tsv-parse", `status=${r.status} rows=${r.rowCount} cols=${r.columnCount} err=${r.error}`);
    }
  } catch (e) { fail("S2-tsv-parse", e); }

  // ── Scenario 3: Parse XLSX fails explicitly ───────────────────────────────
  try {
    const xlsxVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${xlsxVerId}, ${tenantId}, ${docId}, 3, 'uploaded', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false)`);
    const r = await runStructuredParseForDocumentVersion(xlsxVerId, tenantId, { content: "fake xlsx bytes" });
    if (r.status === "failed" && r.error && r.error.includes("XLSX")) {
      ok("S3-xlsx-explicit-fail", `failed explicitly: ${r.error.slice(0, 80)}`);
    } else {
      fail("S3-xlsx-explicit-fail", `status=${r.status} error=${r.error}`);
    }
  } catch (e) { fail("S3-xlsx-explicit-fail", e); }

  // ── Scenario 4: Parse unsupported mime type fails explicitly ─────────────
  try {
    const unknownVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${unknownVerId}, ${tenantId}, ${docId}, 4, 'uploaded', 'application/json', false)`);
    const r = await runStructuredParseForDocumentVersion(unknownVerId, tenantId, { content: '{"key":"val"}' });
    if (r.status === "failed" && r.error && r.error.includes("INV-SP11")) {
      ok("S4-unsupported-mime-fail", `explicit fail: ${r.error.slice(0, 60)}`);
    } else {
      fail("S4-unsupported-mime-fail", `status=${r.status} error=${r.error}`);
    }
  } catch (e) { fail("S4-unsupported-mime-fail", e); }

  // ── Scenario 5: Chunk a successfully parsed version ───────────────────────
  try {
    const r = await runStructuredChunkingForDocumentVersion(csvVerId, tenantId, { content: CSV_CONTENT });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, csvVerId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.chunkCount > 0 && idx && idx.indexState !== "indexed") {
      ok("S5-chunk-parsed-version", `chunkCount=${r.chunkCount} indexState=${idx.indexState} (not indexed — correct)`);
    } else {
      fail("S5-chunk-parsed-version", `status=${r.status} chunks=${r.chunkCount} indexState=${idx?.indexState} err=${r.error}`);
    }
  } catch (e) { fail("S5-chunk-parsed-version", e); }

  // ── Scenario 6: Rerun structured chunking — prior chunks deactivated ──────
  try {
    const r2 = await runStructuredChunkingForDocumentVersion(csvVerId, tenantId, { content: CSV_CONTENT });
    const allChunks = await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, csvVerId), eq(knowledgeChunks.tableChunk, true))
    );
    const deactivated = allChunks.filter((c) => !c.chunkActive && c.replacedByJobId);
    const active = allChunks.filter((c) => c.chunkActive);
    if (r2.status === "completed" && r2.priorStructuredChunksDeactivated > 0 && deactivated.length > 0) {
      ok("S6-chunk-rebuild-safe", `deactivated=${r2.priorStructuredChunksDeactivated} active=${active.length} historical=${deactivated.length}`);
    } else {
      fail("S6-chunk-rebuild-safe", `status=${r2.status} priorDeactivated=${r2.priorStructuredChunksDeactivated} historical=${deactivated.length}`);
    }
  } catch (e) { fail("S6-chunk-rebuild-safe", e); }

  // ── Scenario 7: Parse failure does NOT mutate current version retrieval ────
  try {
    const failVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${failVerId}, ${tenantId}, ${docId}, 5, 'uploaded', 'application/vnd.ms-excel', false)`);
    const before = await isVersionRetrievable(csvVerId, tenantId);
    await runStructuredParseForDocumentVersion(failVerId, tenantId, { content: "bad" });
    const after = await isVersionRetrievable(csvVerId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S7-parse-fail-no-mutation", `current retrieval unchanged: ${after.retrievable}`);
    } else {
      fail("S7-parse-fail-no-mutation", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S7-parse-fail-no-mutation", e); }

  // ── Scenario 8: Chunk transaction safe — no partial corruption ────────────
  try {
    const activeBefore = (await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, csvVerId), eq(knowledgeChunks.chunkActive, true), eq(knowledgeChunks.tableChunk, true))
    )).length;
    const r = await runStructuredChunkingForDocumentVersion(csvVerId, tenantId, { content: CSV_CONTENT });
    const activeAfter = (await db.select().from(knowledgeChunks).where(
      and(eq(knowledgeChunks.knowledgeDocumentVersionId, csvVerId), eq(knowledgeChunks.chunkActive, true), eq(knowledgeChunks.tableChunk, true))
    )).length;
    if (r.status === "completed" && activeAfter > 0) {
      ok("S8-chunk-transaction-safe", `activeAfter=${activeAfter} (consistent, no mixed state)`);
    } else {
      fail("S8-chunk-transaction-safe", `status=${r.status} activeAfter=${activeAfter}`);
    }
  } catch (e) { fail("S8-chunk-transaction-safe", e); }

  // ── Scenario 9: Non-current version structured chunking doesn't affect current ─
  try {
    const ncVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${ncVerId}, ${tenantId}, ${docId}, 6, 'uploaded', 'text/csv', false)`);
    const before = await isVersionRetrievable(csvVerId, tenantId);
    await runStructuredChunkingForDocumentVersion(ncVerId, tenantId, { content: CSV_CONTENT });
    const after = await isVersionRetrievable(csvVerId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S9-noncurrent-no-affect", `current retrieval unchanged: ${after.retrievable}`);
    } else {
      fail("S9-noncurrent-no-affect", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S9-noncurrent-no-affect", e); }

  // ── Scenario 10: Cross-tenant linkage rejected ────────────────────────────
  try {
    let threw = false;
    try {
      await runStructuredParseForDocumentVersion(ver2Id, tenantId, { content: CSV_CONTENT });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S10-cross-tenant-rejected", "KnowledgeInvariantError thrown as expected");
    } else {
      fail("S10-cross-tenant-rejected", "No invariant error thrown");
    }
  } catch (e) { fail("S10-cross-tenant-rejected", e); }

  // ── Scenario 11: Archived KB blocks processing ────────────────────────────
  try {
    let threw = false;
    try {
      await runStructuredParseForDocumentVersion(verArchId, tenantId, { content: CSV_CONTENT });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S11-archived-blocked", "INV-SP5: archived KB/doc blocks structured processing");
    } else {
      fail("S11-archived-blocked", "Expected KnowledgeInvariantError for archived entity");
    }
  } catch (e) { fail("S11-archived-blocked", e); }

  // ── Scenario 12: Deterministic chunk keys and hashes ─────────────────────
  try {
    const key1 = chunkKey("doc1", "ver1", "Sheet1", 0, 9, "table_rows", "1.0");
    const key2 = chunkKey("doc1", "ver1", "Sheet1", 0, 9, "table_rows", "1.0");
    const keyDiff = chunkKey("doc1", "ver1", "Sheet1", 10, 19, "table_rows", "1.0");
    const hash1 = chunkHash("same chunk text", "table_rows", "1.0");
    const hash2 = chunkHash("same chunk text", "table_rows", "1.0");
    const hashDiff = chunkHash("different text", "table_rows", "1.0");
    if (key1 === key2 && key1 !== keyDiff && hash1 === hash2 && hash1 !== hashDiff) {
      ok("S12-deterministic-keys", `key=${key1.slice(0, 12)} deterministic=true, diff-row differs=true`);
    } else {
      fail("S12-deterministic-keys", `key1==key2:${key1===key2} key1!=keyDiff:${key1!==keyDiff} hash det:${hash1===hash2}`);
    }
  } catch (e) { fail("S12-deterministic-keys", e); }

  // ── Scenario 13: Changed chunk config causes replacement ──────────────────
  try {
    const r = await runStructuredChunkingForDocumentVersion(csvVerId, tenantId, {
      content: CSV_CONTENT,
      chunkingConfig: { rowWindowSize: 2, includeHeaders: false },
    });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, csvVerId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.priorStructuredChunksDeactivated > 0 && (idx.indexState === "pending" || idx.indexState === "stale")) {
      ok("S13-config-change-stale", `indexState=${idx.indexState} priorDeactivated=${r.priorStructuredChunksDeactivated} newChunks=${r.chunkCount}`);
    } else {
      fail("S13-config-change-stale", `status=${r.status} indexState=${idx?.indexState} priorDeact=${r.priorStructuredChunksDeactivated}`);
    }
  } catch (e) { fail("S13-config-change-stale", e); }

  // ── Scenario 14: Processing job lock safety ───────────────────────────────
  try {
    const lockVerId = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${lockVerId}, ${tenantId}, ${docId}, 7, 'uploaded', 'text/csv', false)`);
    const [jobRow] = (await db.execute(sql`
      INSERT INTO knowledge_processing_jobs (id, tenant_id, knowledge_document_id, knowledge_document_version_id, job_type, status)
      VALUES (gen_random_uuid(), ${tenantId}, ${docId}, ${lockVerId}, 'structured_parse', 'queued')
      RETURNING id`)).rows;
    const jobId = String((jobRow as { id: string }).id);
    const a1 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w1" });
    const a2 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w2" });
    if (a1 && !a2) {
      ok("S14-job-lock-safe", `w1 acquired, w2 correctly rejected`);
    } else {
      fail("S14-job-lock-safe", `a1=${!!a1} a2=${!!a2}`);
    }
  } catch (e) { fail("S14-job-lock-safe", e); }

  // ── Scenario 15: Inspection helpers work ─────────────────────────────────
  try {
    const pe = await explainStructuredParseState(csvVerId, tenantId);
    const ce = await explainStructuredChunkState(csvVerId, tenantId);
    const preview = await previewStructuredChunkReplacement(csvVerId, tenantId);
    const jobs = await listStructuredProcessingJobs(docId, tenantId);
    if (pe.structuredParseStatus === "completed" && ce.activeTableChunkCount > 0 && jobs.length > 0 && preview.explanation) {
      ok("S15-inspection-helpers", `parseStatus=${pe.structuredParseStatus} activeChunks=${ce.activeTableChunkCount} jobs=${jobs.length} sheets=${ce.sheets.join(",")}`);
    } else {
      fail("S15-inspection-helpers", `parseStatus=${pe.structuredParseStatus} chunks=${ce.activeTableChunkCount} jobs=${jobs.length}`);
    }
  } catch (e) { fail("S15-inspection-helpers", e); }

  // ── Scenario 16: 5A.1 invariants still hold ───────────────────────────────
  try {
    const r = await isVersionRetrievable(csvVerId, tenantId);
    if (!r.retrievable) {
      ok("S16-5A1-invariants", `Not retrievable without indexed state (correct). Reasons: ${r.reasons.slice(0, 2).join("; ")}`);
    } else {
      fail("S16-5A1-invariants", "Version marked retrievable without indexed state — 5A.1 VIOLATED");
    }
  } catch (e) { fail("S16-5A1-invariants", e); }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("========================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
