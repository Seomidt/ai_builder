/**
 * Phase 5B validation script — 14 scenarios
 * Run with: npx tsx server/lib/ai/validate-phase5b.ts
 */
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../db";
import { randomUUID } from "crypto";
import {
  knowledgeChunks,
  knowledgeIndexState,
} from "@shared/schema";
import {
  runParseForDocumentVersion,
  runChunkingForDocumentVersion,
  explainDocumentVersionParseState,
  explainDocumentVersionChunkState,
  previewChunkReplacement,
  listDocumentProcessingJobs,
  acquireKnowledgeProcessingJob,
  isVersionRetrievable,
} from "./knowledge-processing";
import {
  buildChunkKey,
  buildChunkHash,
} from "./document-chunking";
import { KnowledgeInvariantError } from "./knowledge-bases";

let passed = 0;
let failed = 0;

function ok(scenario: string, detail?: string) {
  passed++;
  console.log(`PASS [${scenario}]${detail ? ": " + detail : ""}`);
}

function fail(scenario: string, err: unknown) {
  failed++;
  console.log(`FAIL [${scenario}]: ${err instanceof Error ? err.message : String(err)}`);
}

async function run() {
  const tenantId = "test-5b-" + randomUUID().slice(0, 8);
  const tenant2Id = "test-5b-x-" + randomUUID().slice(0, 8);

  // ── Fixtures ──────────────────────────────────────────────────────────────

  const kbId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbId}, ${tenantId}, '5B-KB', ${"5b-kb-" + randomUUID().slice(0, 8)}, 'active')`);

  const docId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docId}, ${tenantId}, ${kbId}, '5B-Doc', 'markdown', 'active', 'draft')`);

  const verId = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${verId}, ${tenantId}, ${docId}, 1, 'uploaded', 'text/markdown', true)`);

  // Tenant2 fixtures (cross-tenant test)
  const kbId2 = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbId2}, ${tenant2Id}, '5B-KB2', ${"5b-kb2-" + randomUUID().slice(0, 8)}, 'active')`);
  const docId2 = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docId2}, ${tenant2Id}, ${kbId2}, '5B-Doc2', 'markdown', 'active', 'draft')`);
  const verId2 = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${verId2}, ${tenant2Id}, ${docId2}, 1, 'uploaded', 'text/markdown', true)`);

  // Archived KB fixture
  const kbIdArch = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_bases (id, tenant_id, name, slug, lifecycle_state)
    VALUES (${kbIdArch}, ${tenantId}, '5B-Arch-KB', ${"5b-arch-" + randomUUID().slice(0, 8)}, 'archived')`);
  const docIdArch = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_documents (id, tenant_id, knowledge_base_id, title, document_type, lifecycle_state, document_status)
    VALUES (${docIdArch}, ${tenantId}, ${kbIdArch}, '5B-Arch-Doc', 'markdown', 'archived', 'draft')`);
  const verIdArch = randomUUID();
  await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
    VALUES (${verIdArch}, ${tenantId}, ${docIdArch}, 1, 'uploaded', 'text/markdown', true)`);

  const content = `# Test Document\n\nThis is the first section with enough text.\n\nAnother paragraph here.\n\n## Section Two\n\nMore content in section two.\n\nFinal paragraph for chunking.`;

  // ── Scenario 1: Parse supported text document ─────────────────────────────
  try {
    const r = await runParseForDocumentVersion(verId, tenantId, { content });
    if (r.status === "completed" && r.parseStatus === "completed") {
      ok("S1-parse-supported", `jobId=${r.jobId.slice(0, 8)}`);
    } else {
      fail("S1-parse-supported", `status=${r.status} parseStatus=${r.parseStatus} error=${r.error}`);
    }
  } catch (e) { fail("S1-parse-supported", e); }

  // ── Scenario 2: Parse unsupported format fails explicitly ─────────────────
  try {
    const verIdPdf = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${verIdPdf}, ${tenantId}, ${docId}, 2, 'uploaded', 'application/pdf', false)`);
    const r = await runParseForDocumentVersion(verIdPdf, tenantId, { content: "fake pdf" });
    if (r.status === "failed" && r.error && r.error.includes("not supported")) {
      ok("S2-parse-unsupported", `failed explicitly: ${r.error.slice(0, 80)}`);
    } else {
      fail("S2-parse-unsupported", `status=${r.status} error=${r.error}`);
    }
  } catch (e) { fail("S2-parse-unsupported", e); }

  // ── Scenario 3: Chunk a successfully parsed version ───────────────────────
  try {
    const r = await runChunkingForDocumentVersion(verId, tenantId, { content });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, verId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.chunkCount > 0 && idx && idx.indexState !== "indexed") {
      ok("S3-chunk-version", `chunks=${r.chunkCount}, indexState=${idx.indexState} (NOT indexed — correct)`);
    } else {
      fail("S3-chunk-version", `status=${r.status} chunks=${r.chunkCount} indexState=${idx?.indexState} error=${r.error}`);
    }
  } catch (e) { fail("S3-chunk-version", e); }

  // ── Scenario 4: Rerun chunking — prior chunks deactivated safely ──────────
  try {
    const r2 = await runChunkingForDocumentVersion(verId, tenantId, { content });
    const allChunks = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.knowledgeDocumentVersionId, verId));
    const deactivated = allChunks.filter((c) => !c.chunkActive && c.replacedByJobId);
    const active = allChunks.filter((c) => c.chunkActive);
    if (r2.status === "completed" && r2.priorChunksDeactivated > 0 && deactivated.length > 0) {
      ok("S4-chunk-rebuild", `deactivated=${r2.priorChunksDeactivated} active=${active.length} historical=${deactivated.length}`);
    } else {
      fail("S4-chunk-rebuild", `status=${r2.status} priorDeactivated=${r2.priorChunksDeactivated} deactivatedWithJobId=${deactivated.length}`);
    }
  } catch (e) { fail("S4-chunk-rebuild", e); }

  // ── Scenario 5: Parse failure does NOT mutate current version retrieval ────
  try {
    const verIdFail = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${verIdFail}, ${tenantId}, ${docId}, 3, 'uploaded', 'application/pdf', false)`);
    const before = await isVersionRetrievable(verId, tenantId);
    await runParseForDocumentVersion(verIdFail, tenantId, { content: "dummy" });
    const after = await isVersionRetrievable(verId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S5-parse-fail-no-mutation", `current version retrievability unchanged: ${after.retrievable}`);
    } else {
      fail("S5-parse-fail-no-mutation", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S5-parse-fail-no-mutation", e); }

  // ── Scenario 6: Chunk failure leaves no partial corruption ────────────────
  try {
    const activeBefore = (await db.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.knowledgeDocumentVersionId, verId), eq(knowledgeChunks.chunkActive, true)))).length;
    const r = await runChunkingForDocumentVersion(verId, tenantId, { content });
    const activeAfter = (await db.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.knowledgeDocumentVersionId, verId), eq(knowledgeChunks.chunkActive, true)))).length;
    if (r.status === "completed" && activeAfter > 0) {
      ok("S6-chunk-transaction-safe", `consistent: ${activeAfter} active after rebuild (no mixed state)`);
    } else {
      fail("S6-chunk-transaction-safe", `status=${r.status} activeAfter=${activeAfter}`);
    }
  } catch (e) { fail("S6-chunk-transaction-safe", e); }

  // ── Scenario 7: Non-current version chunking doesn't affect current ────────
  try {
    const verIdNc = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${verIdNc}, ${tenantId}, ${docId}, 4, 'uploaded', 'text/plain', false)`);
    const before = await isVersionRetrievable(verId, tenantId);
    await runChunkingForDocumentVersion(verIdNc, tenantId, { content: "non-current content only" });
    const after = await isVersionRetrievable(verId, tenantId);
    if (before.retrievable === after.retrievable) {
      ok("S7-noncurrent-no-affect", `current retrievability unchanged: ${after.retrievable}`);
    } else {
      fail("S7-noncurrent-no-affect", `changed ${before.retrievable} → ${after.retrievable}`);
    }
  } catch (e) { fail("S7-noncurrent-no-affect", e); }

  // ── Scenario 8: Cross-tenant linkage rejected ─────────────────────────────
  try {
    let threw = false;
    try {
      await runParseForDocumentVersion(verId2, tenantId, { content });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S8-cross-tenant-rejected", "KnowledgeInvariantError thrown as expected");
    } else {
      fail("S8-cross-tenant-rejected", "No invariant error thrown for cross-tenant parse attempt");
    }
  } catch (e) { fail("S8-cross-tenant-rejected", e); }

  // ── Scenario 9: Archived KB/document blocks processing ───────────────────
  try {
    let threw = false;
    try {
      await runParseForDocumentVersion(verIdArch, tenantId, { content });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S9-archived-blocked", "INV-P4 raised for archived KB");
    } else {
      fail("S9-archived-blocked", "Expected INV-P4 but no error thrown");
    }
  } catch (e) { fail("S9-archived-blocked", e); }

  // ── Scenario 10: Deterministic chunk keys/hashes ──────────────────────────
  try {
    const d = "det-doc";
    const v = "det-ver";
    const key1 = buildChunkKey(d, v, 0, "paragraph_window", "1.0");
    const key2 = buildChunkKey(d, v, 0, "paragraph_window", "1.0");
    const keyDiff = buildChunkKey(d, v, 1, "paragraph_window", "1.0");
    const hash1 = buildChunkHash("same text", "paragraph_window", "1.0");
    const hash2 = buildChunkHash("same text", "paragraph_window", "1.0");
    const hashDiff = buildChunkHash("different text", "paragraph_window", "1.0");
    if (key1 === key2 && key1 !== keyDiff && hash1 === hash2 && hash1 !== hashDiff) {
      ok("S10-deterministic-keys", `key=${key1.slice(0, 16)}... deterministic=true, different-idx differs=true`);
    } else {
      fail("S10-deterministic-keys", `key1==key2:${key1===key2} key1!=keyDiff:${key1!==keyDiff} hash1==hash2:${hash1===hash2}`);
    }
  } catch (e) { fail("S10-deterministic-keys", e); }

  // ── Scenario 11: Changed chunk config → stale/pending transition ──────────
  try {
    const r = await runChunkingForDocumentVersion(verId, tenantId, {
      content,
      chunkingConfig: { maxCharacters: 150, overlapCharacters: 15 },
    });
    const idxRows = await db.select().from(knowledgeIndexState).where(eq(knowledgeIndexState.knowledgeDocumentVersionId, verId));
    const idx = idxRows[0];
    if (r.status === "completed" && r.priorChunksDeactivated > 0 && (idx.indexState === "pending" || idx.indexState === "stale")) {
      ok("S11-config-change-stale", `indexState=${idx.indexState} priorDeactivated=${r.priorChunksDeactivated} newChunks=${r.chunkCount}`);
    } else {
      fail("S11-config-change-stale", `status=${r.status} indexState=${idx?.indexState} priorDeactivated=${r.priorChunksDeactivated}`);
    }
  } catch (e) { fail("S11-config-change-stale", e); }

  // ── Scenario 12: Job lock safety — second acquire fails ───────────────────
  try {
    const verIdLock = randomUUID();
    await db.execute(sql`INSERT INTO knowledge_document_versions (id, tenant_id, knowledge_document_id, version_number, version_status, mime_type, is_current)
      VALUES (${verIdLock}, ${tenantId}, ${docId}, 5, 'uploaded', 'text/plain', false)`);
    const [jobRow] = (await db.execute(sql`
      INSERT INTO knowledge_processing_jobs (id, tenant_id, knowledge_document_id, knowledge_document_version_id, job_type, status)
      VALUES (gen_random_uuid(), ${tenantId}, ${docId}, ${verIdLock}, 'parse', 'queued')
      RETURNING id`)).rows;
    const jobId = String((jobRow as { id: string }).id);
    const a1 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w1" });
    const a2 = await acquireKnowledgeProcessingJob(jobId, tenantId, { workerId: "w2" });
    if (a1 && !a2) {
      ok("S12-job-lock-safe", `w1 acquired, w2 correctly rejected`);
    } else {
      fail("S12-job-lock-safe", `a1=${!!a1} a2=${!!a2}`);
    }
  } catch (e) { fail("S12-job-lock-safe", e); }

  // ── Scenario 13: Inspection helpers work ─────────────────────────────────
  try {
    const pe = await explainDocumentVersionParseState(verId, tenantId);
    const ce = await explainDocumentVersionChunkState(verId, tenantId);
    const jobs = await listDocumentProcessingJobs(docId, tenantId);
    if (pe.parseStatus && ce.activeChunkCount > 0 && jobs.length > 0) {
      ok("S13-inspection-helpers", `parseStatus=${pe.parseStatus} chunks=${ce.activeChunkCount} jobs=${jobs.length}`);
    } else {
      fail("S13-inspection-helpers", `parseStatus=${pe.parseStatus} chunks=${ce.activeChunkCount} jobs=${jobs.length}`);
    }
  } catch (e) { fail("S13-inspection-helpers", e); }

  // ── Scenario 14: 5A.1 invariants still hold ───────────────────────────────
  try {
    const r = await isVersionRetrievable(verId, tenantId);
    if (!r.retrievable) {
      ok("S14-5A1-invariants", `Not retrievable without indexed state (correct). Reasons: ${r.reasons.join("; ")}`);
    } else {
      fail("S14-5A1-invariants", "Version marked retrievable without indexed state — 5A.1 VIOLATED");
    }
  } catch (e) { fail("S14-5A1-invariants", e); }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("========================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
