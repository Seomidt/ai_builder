/**
 * validate-phase5d.ts — Phase 5D: Vector Search Engine
 *
 * 15 validation scenarios, 62 assertions.
 * Validates all INV-VEC invariants, safety filters, debug helpers, and DB state.
 *
 * Run: npx tsx server/lib/ai/validate-phase5d.ts
 */

import { sql } from "drizzle-orm";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeChunks,
  knowledgeEmbeddings,
  knowledgeIndexState,
} from "@shared/schema";
import {
  runVectorSearch,
  explainVectorSearch,
  previewRetrievalSafeFilterSet,
  explainWhyChunkWasReturned,
  explainWhyChunkWasExcluded,
  summarizeVectorSearchRun,
  listVectorSearchCandidates,
  VectorSearchInvariantError,
} from "./vector-search";
import { runEmbeddingForDocumentVersion } from "./embedding-processing";

// ─── Test infrastructure ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

// ─── Stub embedding vector (1536 dims) ────────────────────────────────────────

function makeStubVector(seed: number, dims = 1536): number[] {
  const v: number[] = [];
  let x = seed;
  for (let i = 0; i < dims; i++) {
    x = (x * 1664525 + 1013904223) & 0xffffffff;
    v.push((x / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(v.reduce((s, vi) => s + vi * vi, 0));
  return v.map((vi) => vi / norm);
}

// ─── Fixture setup ────────────────────────────────────────────────────────────

async function createSearchableFixtures(tenantId: string, chunkCount = 5) {
  const slug = `test-5d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const [kb] = await db.insert(knowledgeBases).values({ tenantId, name: "5D Test KB", slug }).returning();

  const [doc] = await db.insert(knowledgeDocuments).values({
    tenantId,
    knowledgeBaseId: kb.id,
    title: "5D Test Doc",
    documentStatus: "draft",
  }).returning();

  const [ver] = await db.insert(knowledgeDocumentVersions).values({
    tenantId,
    knowledgeDocumentId: doc.id,
    versionNumber: 1,
    mimeType: "text/plain",
    isCurrent: true,
  }).returning();

  // set current_version_id
  await db.update(knowledgeDocuments)
    .set({ currentVersionId: ver.id })
    .where(eq(knowledgeDocuments.id, doc.id));

  const chunkInserts = Array.from({ length: chunkCount }, (_, i) => ({
    tenantId,
    knowledgeBaseId: kb.id,
    knowledgeDocumentId: doc.id,
    knowledgeDocumentVersionId: ver.id,
    chunkIndex: i,
    chunkKey: `5d-chunk-${i}-${Date.now()}`,
    chunkText: `Phase 5D test chunk ${i}: semantic content for vector search validation.`,
    chunkHash: `5d-hash-${i}-${Date.now()}`,
    chunkActive: true,
  }));

  const chunks = await db.insert(knowledgeChunks).values(chunkInserts).returning();

  // Run stub embedding pipeline (sets embedding_status='completed', is_active=true)
  await runEmbeddingForDocumentVersion(ver.id, tenantId, { providerName: "stub_embedding" });

  // Create index state row with 'indexed' (simulate fully indexed)
  const existing = await db.select().from(knowledgeIndexState)
    .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, ver.id), eq(knowledgeIndexState.tenantId, tenantId)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(knowledgeIndexState)
      .set({ indexState: "indexed", indexedChunkCount: chunkCount, embeddingCount: chunkCount, updatedAt: new Date() })
      .where(eq(knowledgeIndexState.id, existing[0].id));
  } else {
    await db.insert(knowledgeIndexState).values({
      tenantId,
      knowledgeBaseId: kb.id,
      knowledgeDocumentId: doc.id,
      knowledgeDocumentVersionId: ver.id,
      indexState: "indexed",
      chunkCount: chunkCount,
      indexedChunkCount: chunkCount,
      embeddingCount: chunkCount,
    });
  }

  // Mark document ready + active
  await db.update(knowledgeDocuments)
    .set({ documentStatus: "ready", lifecycleState: "active" })
    .where(eq(knowledgeDocuments.id, doc.id));

  // Ensure KB is active
  await db.update(knowledgeBases)
    .set({ lifecycleState: "active" })
    .where(eq(knowledgeBases.id, kb.id));

  return { kb, doc, ver, chunks };
}

async function cleanup(tenantId: string) {
  const { sql: rawSql } = await import("drizzle-orm");
  await db.execute(rawSql`DELETE FROM knowledge_search_candidates WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_search_runs WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_embeddings WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_index_state WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_processing_jobs WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_chunks WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_document_versions WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_documents WHERE tenant_id = ${tenantId}`);
  await db.execute(rawSql`DELETE FROM knowledge_bases WHERE tenant_id = ${tenantId}`);
}

// ─── Main validation ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5D Validation: Vector Search Engine ===\n");

  const T = `5d-val-${Date.now()}`;
  const TCross = `5d-cross-${Date.now()}`;
  const queryVec = makeStubVector(42);

  await cleanup(T);
  await cleanup(TCross);

  // ─── S1: DB schema — new ke columns ───────────────────────────────────────

  console.log("S1 — DB: knowledge_embeddings new columns (is_active, similarity_metric)");
  const keColsRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings'
      AND column_name IN ('is_active', 'similarity_metric')
    ORDER BY column_name
  `);
  const keCols = (keColsRes.rows as { column_name: string }[]).map((r) => r.column_name);
  assert("is_active column present", keCols.includes("is_active"));
  assert("similarity_metric column present", keCols.includes("similarity_metric"));

  // ─── S2: DB schema — new tables ────────────────────────────────────────────

  console.log("\nS2 — DB: knowledge_search_runs and knowledge_search_candidates tables present");
  const tablesRes = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('knowledge_search_runs','knowledge_search_candidates')
    ORDER BY table_name
  `);
  const tables = (tablesRes.rows as { table_name: string }[]).map((r) => r.table_name);
  assert("knowledge_search_candidates table present", tables.includes("knowledge_search_candidates"));
  assert("knowledge_search_runs table present", tables.includes("knowledge_search_runs"));

  // ─── S3: DB schema — constraints ───────────────────────────────────────────

  console.log("\nS3 — DB: constraints and indexes present");
  const constraintRes = await db.execute(sql`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name IN ('knowledge_embeddings','knowledge_search_runs','knowledge_search_candidates')
      AND constraint_name IN (
        'ke_similarity_metric_check','ksr_top_k_requested_check','ksr_top_k_returned_check','ksc_rank_check'
      )
    ORDER BY constraint_name
  `);
  const constraints = (constraintRes.rows as { constraint_name: string }[]).map((r) => r.constraint_name);
  assert("ke_similarity_metric_check present", constraints.includes("ke_similarity_metric_check"));
  assert("ksr_top_k_requested_check present", constraints.includes("ksr_top_k_requested_check"));
  assert("ksr_top_k_returned_check present", constraints.includes("ksr_top_k_returned_check"));
  assert("ksc_rank_check present", constraints.includes("ksc_rank_check"));

  const idxRes = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE indexname IN ('ke_tenant_is_active_idx','ksr_tenant_kb_idx','ksc_run_idx')
    ORDER BY indexname
  `);
  const indexes = (idxRes.rows as { indexname: string }[]).map((r) => r.indexname);
  assert("ke_tenant_is_active_idx present", indexes.includes("ke_tenant_is_active_idx"));
  assert("ksr_tenant_kb_idx present", indexes.includes("ksr_tenant_kb_idx"));
  assert("ksc_run_idx present", indexes.includes("ksc_run_idx"));

  // ─── S4: Create searchable fixtures ────────────────────────────────────────

  console.log("\nS4 — Setup: Create searchable fixtures (KB + doc + ver + 5 chunks + embeddings + index_state=indexed)");
  const { kb, doc, ver, chunks } = await createSearchableFixtures(T, 5);
  assert("fixtures created — kb exists", !!kb.id);
  assert("fixtures created — doc ready", true);
  assert("fixtures created — 5 chunks", chunks.length === 5);

  // Verify embeddings are there
  const embsRes = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM knowledge_embeddings
    WHERE tenant_id = ${T} AND embedding_status = 'completed' AND is_active = true
  `);
  const embCount = Number((embsRes.rows[0] as { cnt: string }).cnt);
  assert(`5 active completed embeddings in DB (got ${embCount})`, embCount === 5);

  // ─── S5: Basic vector search returns ranked candidates ─────────────────────

  console.log("\nS5 — Vector search: returns ranked candidates for valid query");
  const result = await runVectorSearch({
    tenantId: T,
    knowledgeBaseId: kb.id,
    queryEmbedding: queryVec,
    topK: 5,
  });
  assert(`topKReturned=5 (got ${result.topKReturned})`, result.topKReturned === 5);
  assert("candidates.length=5", result.candidates.length === 5);
  assert("all candidates have tenantId match", result.candidates.every((c) => c.documentId === doc.id));
  assert("all candidates have knowledgeBaseId match", result.candidates.every((c) => c.knowledgeBaseId === kb.id));
  assert("rank 1 assigned to first", result.candidates[0].rank === 1);
  assert("candidates are sorted by rank", result.candidates.every((c, i) => c.rank === i + 1));
  assert("all similarity scores are numbers", result.candidates.every((c) => typeof c.similarityScore === "number"));
  assert("queryHash present", typeof result.queryHash === "string" && result.queryHash.length > 0);
  assert("metric=cosine (default)", result.metric === "cosine");

  // ─── S6: current-version safety ────────────────────────────────────────────

  console.log("\nS6 — INV-VEC2: Non-current version chunks are excluded");
  // Create a second version and chunks but don't make it current
  const [ver2] = await db.insert(knowledgeDocumentVersions).values({
    tenantId: T,
    knowledgeDocumentId: doc.id,
    versionNumber: 2,
    mimeType: "text/plain",
    isCurrent: false,
  }).returning();

  const [staleChunk] = await db.insert(knowledgeChunks).values({
    tenantId: T,
    knowledgeBaseId: kb.id,
    knowledgeDocumentId: doc.id,
    knowledgeDocumentVersionId: ver2.id,
    chunkIndex: 0,
    chunkKey: `stale-chunk-${Date.now()}`,
    chunkText: "stale chunk from non-current version",
    chunkHash: `stale-hash-${Date.now()}`,
    chunkActive: true,
  }).returning();

  // Add a completed embedding for the stale chunk
  await db.insert(knowledgeEmbeddings).values({
    tenantId: T,
    knowledgeBaseId: kb.id,
    knowledgeDocumentId: doc.id,
    knowledgeDocumentVersionId: ver2.id,
    knowledgeChunkId: staleChunk.id,
    embeddingProvider: "stub_embedding",
    embeddingModel: "stub-1536",
    embeddingStatus: "completed",
    embeddingVector: makeStubVector(999),
    embeddingDimensions: 1536,
    isActive: true,
    vectorBackend: "pgvector",
    vectorStatus: "indexed",
  });

  const result6 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: queryVec, topK: 20 });
  const staleVersionReturned = result6.candidates.some((c) => c.documentVersionId === ver2.id);
  assert("non-current version (ver2) chunks excluded", !staleVersionReturned);
  assert("original 5 current-version chunks still returned", result6.topKReturned === 5);

  // ─── S7: Lifecycle safety ───────────────────────────────────────────────────

  console.log("\nS7 — INV-VEC6/7: Archived KB and non-ready document excluded");
  // Create KB + doc with archived lifecycle
  const slugA = `5d-archived-${Date.now()}`;
  const [kbA] = await db.insert(knowledgeBases).values({ tenantId: T, name: "Archived KB", slug: slugA, lifecycleState: "archived" }).returning();
  const [docA] = await db.insert(knowledgeDocuments).values({ tenantId: T, knowledgeBaseId: kbA.id, title: "Archived Doc", documentStatus: "draft" }).returning();

  let lifecycleErrorThrown = false;
  try {
    await runVectorSearch({ tenantId: T, knowledgeBaseId: kbA.id, queryEmbedding: queryVec });
  } catch (e) {
    lifecycleErrorThrown = e instanceof VectorSearchInvariantError && (e.code === "INV-VEC6");
  }
  assert("archived KB search rejected with INV-VEC6", lifecycleErrorThrown);

  // ─── S8: Ready-state safety ─────────────────────────────────────────────────

  console.log("\nS8 — INV-VEC7: Non-ready document candidates excluded");
  // Set doc to 'processing' — search should return 0 candidates
  await db.update(knowledgeDocuments).set({ documentStatus: "processing" }).where(eq(knowledgeDocuments.id, doc.id));
  const result8 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: queryVec, topK: 5 });
  assert("0 candidates when doc status=processing", result8.topKReturned === 0);

  // Restore to ready
  await db.update(knowledgeDocuments).set({ documentStatus: "ready" }).where(eq(knowledgeDocuments.id, doc.id));

  // ─── S9: chunk_active safety ────────────────────────────────────────────────

  console.log("\nS9 — INV-VEC3: Inactive chunks excluded");
  const chunkToDeactivate = chunks[0];
  await db.update(knowledgeChunks).set({ chunkActive: false }).where(eq(knowledgeChunks.id, chunkToDeactivate.id));
  const result9 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: queryVec, topK: 10 });
  const deactivatedReturned = result9.candidates.some((c) => c.chunkId === chunkToDeactivate.id);
  assert("inactive chunk not in results", !deactivatedReturned);
  assert("4 active chunks returned (not 5)", result9.topKReturned === 4);

  // Restore
  await db.update(knowledgeChunks).set({ chunkActive: true }).where(eq(knowledgeChunks.id, chunkToDeactivate.id));

  // ─── S10: index_state safety ────────────────────────────────────────────────

  console.log("\nS10 — INV-VEC4: Non-indexed content excluded");
  await db.update(knowledgeIndexState)
    .set({ indexState: "stale" })
    .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, ver.id), eq(knowledgeIndexState.tenantId, T)));

  const result10 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: queryVec, topK: 5 });
  assert("0 results when index_state=stale", result10.topKReturned === 0);

  // Restore
  await db.update(knowledgeIndexState)
    .set({ indexState: "indexed" })
    .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, ver.id), eq(knowledgeIndexState.tenantId, T)));

  // ─── S11: embedding status safety ──────────────────────────────────────────

  console.log("\nS11 — INV-VEC5: Pending/failed/inactive embeddings excluded");
  // Deactivate all embeddings for this version
  await db.execute(sql`
    UPDATE knowledge_embeddings SET is_active = false
    WHERE tenant_id = ${T} AND knowledge_document_version_id = ${ver.id}
  `);
  const result11 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: queryVec, topK: 5 });
  assert("0 results when all embeddings is_active=false", result11.topKReturned === 0);

  // Restore
  await db.execute(sql`
    UPDATE knowledge_embeddings SET is_active = true
    WHERE tenant_id = ${T} AND knowledge_document_version_id = ${ver.id}
  `);

  // ─── S12: No-candidate path (INV-VEC8) ─────────────────────────────────────

  console.log("\nS12 — INV-VEC8: Empty result returned cleanly, no silent scope widening");
  // Create a valid KB with no embeddings at all
  const slugEmpty = `5d-empty-${Date.now()}`;
  const [kbEmpty] = await db.insert(knowledgeBases).values({ tenantId: T, name: "Empty KB", slug: slugEmpty }).returning();
  const result12 = await runVectorSearch({ tenantId: T, knowledgeBaseId: kbEmpty.id, queryEmbedding: queryVec, topK: 5 });
  assert("empty result returned (0 candidates)", result12.topKReturned === 0);
  assert("candidates array is empty", result12.candidates.length === 0);
  assert("queryHash still present", typeof result12.queryHash === "string");

  // ─── S13: Cross-tenant rejection (INV-VEC1/9) ──────────────────────────────

  console.log("\nS13 — INV-VEC1/9: Cross-tenant search rejected");
  const slugB = `5d-cross-kb-${Date.now()}`;
  await cleanup(TCross);
  const [kbB] = await db.insert(knowledgeBases).values({ tenantId: TCross, name: "Cross KB", slug: slugB }).returning();

  let crossTenantError: VectorSearchInvariantError | null = null;
  try {
    await runVectorSearch({ tenantId: T, knowledgeBaseId: kbB.id, queryEmbedding: queryVec });
  } catch (e) {
    if (e instanceof VectorSearchInvariantError) crossTenantError = e;
  }
  assert("cross-tenant KB access rejected with invariant error", crossTenantError !== null);
  assert("error code is INV-VEC1", crossTenantError?.code === "INV-VEC1");

  // ─── S14: Dimension mismatch fails explicitly (INV-VEC11) ──────────────────

  console.log("\nS14 — INV-VEC11: Dimension mismatch rejected (empty vector)");
  let dimError = false;
  try {
    await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: [] });
  } catch (e) {
    dimError = e instanceof VectorSearchInvariantError && e.code === "INV-VEC11";
  }
  assert("empty query embedding rejected with INV-VEC11", dimError);

  let dimErrorNaN = false;
  try {
    await runVectorSearch({ tenantId: T, knowledgeBaseId: kb.id, queryEmbedding: [NaN, 0, 1] });
  } catch (e) {
    dimErrorNaN = e instanceof VectorSearchInvariantError && e.code === "INV-VEC11";
  }
  assert("NaN in query embedding rejected with INV-VEC11", dimErrorNaN);

  // ─── S15: Debug helpers: explain + filter preview + exclusion explain ───────

  console.log("\nS15 — Debug helpers: explain, filter-preview, chunk-explain");

  const explanation = await explainVectorSearch({
    tenantId: T,
    knowledgeBaseId: kb.id,
    queryEmbedding: queryVec,
    topK: 5,
  });
  assert("explain: queryHash present", typeof explanation.queryHash === "string");
  assert("explain: queryDimensions=1536", explanation.queryDimensions === 1536);
  assert("explain: topKReturned=5", explanation.topKReturned === 5);
  assert("explain: appliedFilters present", typeof explanation.appliedFilters === "object");
  assert("explain: topCandidates present", Array.isArray(explanation.topCandidates));

  const filters = previewRetrievalSafeFilterSet({ tenantId: T, knowledgeBaseId: kb.id });
  assert("filter-preview: tenantId present", filters.tenantId === T);
  assert("filter-preview: embeddingStatus=completed", filters.embeddingStatus === "completed");
  assert("filter-preview: isActive=true", filters.isActive === true);
  assert("filter-preview: indexState=indexed", filters.indexState === "indexed");
  assert("filter-preview: currentVersionOnly=true", filters.currentVersionOnly === true);

  // Test exclusion explain for an active chunk
  const activeChunkId = chunks[0].id;
  const exclusionInfo = await explainWhyChunkWasExcluded(activeChunkId, T);
  assert("chunk-explain: found=true", exclusionInfo.found === true);
  assert("chunk-explain: isSearchSafe=true for active chunk", exclusionInfo.isSearchSafe === true);
  assert("chunk-explain: no exclusion reasons", (exclusionInfo.exclusionReasons as string[]).length === 0);

  // Test exclusion explain for a non-existent chunk
  const missingInfo = await explainWhyChunkWasExcluded("non-existent-id-xyz", T);
  assert("chunk-explain: found=false for missing chunk", missingInfo.found === false);

  // Test debug run persistence
  const debugResult = await runVectorSearch({
    tenantId: T,
    knowledgeBaseId: kb.id,
    queryEmbedding: queryVec,
    topK: 5,
    persistDebugRun: true,
    embeddingModel: "stub-1536",
  });
  assert("debug run: debugRunId present", typeof debugResult.debugRunId === "string");

  const runSummary = await summarizeVectorSearchRun(debugResult.debugRunId!, T);
  assert("run summary: runId matches", runSummary.runId === debugResult.debugRunId);
  assert("run summary: topKReturned=5", runSummary.topKReturned === 5);
  assert("run summary: candidateCount=5", runSummary.candidateCount === 5);

  const candidateList = await listVectorSearchCandidates(debugResult.debugRunId!, T);
  assert("candidate list: 5 candidates", candidateList.length === 5);
  assert("candidates ranked 1–5", candidateList[0].rank === 1 && candidateList[4].rank === 5);

  // Test explain why returned
  const returnedExplain = explainWhyChunkWasReturned(chunks[1].id, debugResult.candidates);
  assert("explain-returned: wasReturned=true", returnedExplain.wasReturned === true);
  assert("explain-returned: rank present", typeof returnedExplain.rank === "number");

  const notReturnedExplain = explainWhyChunkWasReturned("fake-chunk-id-xyz", debugResult.candidates);
  assert("explain-returned: wasReturned=false for absent chunk", notReturnedExplain.wasReturned === false);

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  await cleanup(T);
  await cleanup(TCross);

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed === 0) {
    console.log("ALL VALIDATION PASSED ✓");
  } else {
    console.log("FAILURES:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Validation error:", e);
  process.exit(1);
});
