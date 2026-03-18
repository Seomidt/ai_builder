/**
 * Phase 5C Validation — Embedding Pipeline & Vector Preparation
 * 10 validation scenarios covering the Definition of Done.
 *
 * Run with: npx tsx server/lib/ai/validate-phase5c.ts
 *
 * Uses stub_embedding provider — no real API calls.
 */

import { db } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import {
  knowledgeEmbeddings,
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeChunks,
  knowledgeIndexState,
  knowledgeProcessingJobs,
} from "../../../shared/schema";
import {
  runEmbeddingForDocumentVersion,
  retryEmbeddingForDocumentVersion,
  explainEmbeddingState,
  listEmbeddingJobs,
  summarizeEmbeddingResult,
} from "./embedding-processing";
import {
  selectEmbeddingProvider,
  stubEmbeddingProvider,
  openaiSmallEmbeddingProvider,
  normalizeEmbeddingVector,
  computeEmbeddingContentHash,
  summarizeEmbeddingCost,
  splitIntoBatches,
} from "./embedding-providers";

// ─── Test infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const TENANT_ID = `validate-5c-${Date.now()}`;
const TENANT_ID_B = `validate-5c-b-${Date.now()}`;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedSubstring: string, label: string): Promise<void> {
  try {
    await fn();
    console.error(`  ✗ FAIL: ${label} — expected async throw, but did not throw`);
    failed++;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${label} — expected "${expectedSubstring}" in "${msg}"`);
      failed++;
    }
  }
}

// ─── Setup: create minimal KB + doc + version + chunks ───────────────────────

async function createTestFixtures(tenantId: string, chunkCount: number = 5) {
  const slug = `test-kb-5c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const [kb] = await db
    .insert(knowledgeBases)
    .values({
      tenantId,
      name: `Test KB 5C (${chunkCount} chunks)`,
      slug,
    })
    .returning();

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId,
      knowledgeBaseId: kb.id,
      title: `Test Doc 5C`,
    })
    .returning();

  const [ver] = await db
    .insert(knowledgeDocumentVersions)
    .values({
      tenantId,
      knowledgeDocumentId: doc.id,
      versionNumber: 1,
      mimeType: "text/plain",
      isCurrent: true,
    })
    .returning();

  const chunkInserts = [];
  for (let i = 0; i < chunkCount; i++) {
    chunkInserts.push({
      tenantId,
      knowledgeBaseId: kb.id,
      knowledgeDocumentId: doc.id,
      knowledgeDocumentVersionId: ver.id,
      chunkIndex: i,
      chunkKey: `chunk-key-5c-${i}-${Date.now()}`,
      chunkText: `This is chunk ${i} of the test document for Phase 5C embedding validation. Content: ${Math.random().toString(36)}`,
      chunkHash: `hash-5c-${i}`,
      chunkActive: true,
    });
  }

  const chunks = await db.insert(knowledgeChunks).values(chunkInserts).returning();
  return { kb, doc, ver, chunks };
}

async function cleanup(tenantId: string) {
  await db.delete(knowledgeEmbeddings).where(eq(knowledgeEmbeddings.tenantId, tenantId));
  await db.delete(knowledgeIndexState).where(eq(knowledgeIndexState.tenantId, tenantId));
  await db.delete(knowledgeProcessingJobs).where(eq(knowledgeProcessingJobs.tenantId, tenantId));
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.tenantId, tenantId));
  await db.delete(knowledgeDocumentVersions).where(eq(knowledgeDocumentVersions.tenantId, tenantId));
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.tenantId, tenantId));
  await db.delete(knowledgeBases).where(eq(knowledgeBases.tenantId, tenantId));
}

// ─── S1: DB columns for ke ────────────────────────────────────────────────────

async function s1_dbColumns() {
  console.log("\nS1 — DB: knowledge_embeddings new columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings'
      AND column_name IN ('embedding_status','embedding_vector','embedding_dimensions','token_usage','estimated_cost_usd','updated_at')
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 6, `All 6 ke new columns present (got ${cols.length})`);
}

// ─── S2: DB columns for kpj ──────────────────────────────────────────────────

async function s2_kpjColumns() {
  console.log("\nS2 — DB: knowledge_processing_jobs embedding columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_processing_jobs'
      AND column_name IN ('embedding_provider','embedding_model','token_usage','estimated_cost_usd')
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 4, `All 4 kpj embedding columns present (got ${cols.length})`);
}

// ─── S3: job_type CHECK includes embedding types ──────────────────────────────

async function s3_jobTypeCheck() {
  console.log("\nS3 — DB: kpj_job_type_check includes embedding_generate + embedding_retry");
  const result = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) as def FROM pg_constraint c JOIN pg_class t ON c.conrelid=t.oid
    WHERE t.relname='knowledge_processing_jobs' AND c.conname='kpj_job_type_check'
  `);
  const def = ((result.rows[0] as Record<string, string>)?.def ?? "");
  assert(def.includes("embedding_generate"), "embedding_generate in job_type CHECK");
  assert(def.includes("embedding_retry"), "embedding_retry in job_type CHECK");
}

// ─── S4: Provider abstraction ─────────────────────────────────────────────────

function s4_providerAbstraction() {
  console.log("\nS4 — Provider abstraction: selectEmbeddingProvider routes correctly");
  const p1 = selectEmbeddingProvider("openai_small");
  assert(p1.info.name === "openai", "openai_small resolves to openai provider");
  assert(p1.info.model === "text-embedding-3-small", "model=text-embedding-3-small");
  assert(p1.info.dimensions === 1536, "dimensions=1536");

  const p2 = selectEmbeddingProvider("openai_large");
  assert(p2.info.model === "text-embedding-3-large", "openai_large resolves to text-embedding-3-large");
  assert(p2.info.dimensions === 3072, "openai_large dimensions=3072");

  const p3 = selectEmbeddingProvider("stub_embedding");
  assert(p3.info.name === "stub_embedding", "stub_embedding resolves correctly");
  assert(p3.info.dimensions === 1536, "stub dimensions=1536");

  try {
    selectEmbeddingProvider("unknown_provider_xyz");
    assert(false, "Unknown provider should throw");
  } catch (err) {
    assert((err as Error).message.includes("Unknown embedding provider"), "Unknown provider throws explicit error");
  }
}

// ─── S5: Stub provider generates deterministic vectors ───────────────────────

async function s5_stubProviderDeterminism() {
  console.log("\nS5 — Stub provider: deterministic vectors + correct dimensions");
  const texts = ["Hello world", "Test embedding text for Phase 5C"];
  const result = await stubEmbeddingProvider.generateBatch(texts);

  assert(result.vectors.length === 2, "vectors.length=2");
  assert(result.dimensions === 1536, "dimensions=1536");
  assert(result.vectors[0].length === 1536, "vector[0] has 1536 dimensions");
  assert(result.provider === "stub_embedding", "provider=stub_embedding");
  assert(result.tokenUsage > 0, "tokenUsage > 0");
  assert(result.estimatedCostUsd === 0, "estimatedCostUsd=0 (stub has no cost)");

  // Determinism check
  const result2 = await stubEmbeddingProvider.generateBatch(texts);
  assert(
    result.vectors[0][0] === result2.vectors[0][0],
    "Stub vector is deterministic (same text → same first value)",
  );
}

// ─── S6: Embed document with 5 chunks — rows created, vectors stored ──────────

async function s6_embedDocument() {
  console.log("\nS6 — runEmbeddingForDocumentVersion: 5 chunks → 5 embedding rows with vectors");
  const { kb, doc, ver, chunks } = await createTestFixtures(TENANT_ID, 5);

  const result = await runEmbeddingForDocumentVersion(ver.id, TENANT_ID, {
    providerName: "stub_embedding",
    batchSize: 10,
  });

  assert(result.status === "completed", `status=completed (got ${result.status})`);
  assert(result.chunksProcessed === 5, `chunksProcessed=5 (got ${result.chunksProcessed})`);
  assert(result.embeddingsCreated === 5, `embeddingsCreated=5 (got ${result.embeddingsCreated})`);
  assert(result.provider === "stub_embedding", "provider=stub_embedding");
  assert(result.model === "stub-1536", "model=stub-1536");
  assert(result.batchCount >= 1, "batchCount >= 1");
  assert(result.totalTokenUsage > 0, "totalTokenUsage > 0");

  // Verify embedding rows in DB
  const rows = await db
    .select()
    .from(knowledgeEmbeddings)
    .where(and(eq(knowledgeEmbeddings.knowledgeDocumentVersionId, ver.id), eq(knowledgeEmbeddings.tenantId, TENANT_ID)));

  assert(rows.length === 5, `5 embedding rows in DB (got ${rows.length})`);
  assert(rows.every((r) => r.embeddingStatus === "completed"), "all embedding rows have status=completed");
  assert(rows.every((r) => r.embeddingVector !== null && (r.embeddingVector?.length ?? 0) === 1536), "all vectors have 1536 dimensions");
  assert(rows.every((r) => r.embeddingDimensions === 1536), "all embeddingDimensions=1536");

  return { jobId: result.jobId, ver, doc, kb };
}

// ─── S7: embedding_count updated in index_state ───────────────────────────────

async function s7_embeddingCountUpdated(versionId: string) {
  console.log("\nS7 — index_state.embedding_count updated after embedding run");
  const [idxRow] = await db
    .select()
    .from(knowledgeIndexState)
    .where(and(eq(knowledgeIndexState.knowledgeDocumentVersionId, versionId), eq(knowledgeIndexState.tenantId, TENANT_ID)));

  assert(idxRow !== undefined, "index_state row exists after embedding run");
  assert(idxRow?.embeddingCount === 5, `embeddingCount=5 (got ${idxRow?.embeddingCount})`);
  assert(idxRow?.indexState !== "indexed", `index_state NOT 'indexed' (is '${idxRow?.indexState}') — INV-EMB4`);
}

// ─── S8: Re-run replaces embeddings deterministically ────────────────────────

async function s8_deterministicReplacement(versionId: string, jobId1: string) {
  console.log("\nS8 — Deterministic replacement: re-run deactivates prior embeddings (INV-EMB3/7)");

  const result2 = await retryEmbeddingForDocumentVersion(versionId, TENANT_ID, {
    providerName: "stub_embedding",
    batchSize: 10,
  });

  assert(result2.status === "completed", `re-run status=completed (got ${result2.status})`);
  assert(result2.embeddingsCreated === 5, `re-run embeddingsCreated=5 (got ${result2.embeddingsCreated})`);
  assert(result2.priorEmbeddingsDeactivated === 5, `priorEmbeddingsDeactivated=5 (got ${result2.priorEmbeddingsDeactivated})`);
  assert(result2.jobId !== jobId1, "re-run creates a new job");

  // Only completed embeddings should be new ones
  const active = await db
    .select()
    .from(knowledgeEmbeddings)
    .where(
      and(
        eq(knowledgeEmbeddings.knowledgeDocumentVersionId, versionId),
        eq(knowledgeEmbeddings.tenantId, TENANT_ID),
        eq(knowledgeEmbeddings.embeddingStatus, "completed"),
      ),
    );
  assert(active.length === 5, `Only 5 completed embeddings after re-run (got ${active.length})`);
}

// ─── S9: Cross-tenant access denied (INV-EMB1) ────────────────────────────────

async function s9_crossTenantRejected(versionId: string) {
  console.log("\nS9 — Cross-tenant access denied (INV-EMB1)");
  await assertThrowsAsync(
    () => runEmbeddingForDocumentVersion(versionId, TENANT_ID_B, { providerName: "stub_embedding" }),
    "INV-EMB1",
    "Cross-tenant embedding attempt rejected with INV-EMB1",
  );
}

// ─── S10: Batch size handling ─────────────────────────────────────────────────

async function s10_batchSizeHandling() {
  console.log("\nS10 — Batch size: 3-chunk batchSize=2 produces >=2 batches");
  const TENANT_BATCH = `validate-5c-batch-${Date.now()}`;
  const { ver } = await createTestFixtures(TENANT_BATCH, 3);

  const result = await runEmbeddingForDocumentVersion(ver.id, TENANT_BATCH, {
    providerName: "stub_embedding",
    batchSize: 2,
  });

  assert(result.status === "completed", `batch-test status=completed (got ${result.status})`);
  assert(result.chunksProcessed === 3, `batch-test chunksProcessed=3 (got ${result.chunksProcessed})`);
  assert(result.batchCount >= 2, `batchCount >= 2 for 3 chunks with batchSize=2 (got ${result.batchCount})`);
  assert(result.embeddingsCreated === 3, `batch-test embeddingsCreated=3 (got ${result.embeddingsCreated})`);

  // Utility function test
  const batches = splitIntoBatches([1, 2, 3, 4, 5], 2);
  assert(batches.length === 3, `splitIntoBatches(5 items, size=2) → 3 batches (got ${batches.length})`);
  assert(batches[0].length === 2, "first batch has 2 items");
  assert(batches[2].length === 1, "last batch has 1 item");

  await cleanup(TENANT_BATCH);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5C Validation: Embedding Pipeline & Vector Preparation ===");

  await s1_dbColumns();
  await s2_kpjColumns();
  await s3_jobTypeCheck();
  s4_providerAbstraction();
  await s5_stubProviderDeterminism();
  const { jobId, ver } = await s6_embedDocument();
  await s7_embeddingCountUpdated(ver.id);
  await s8_deterministicReplacement(ver.id, jobId);
  await s9_crossTenantRejected(ver.id);
  await s10_batchSizeHandling();

  // Cleanup
  await cleanup(TENANT_ID);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("VALIDATION FAILED");
    process.exit(1);
  } else {
    console.log("ALL VALIDATION PASSED ✓");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Validation runner error:", err);
  process.exit(1);
});
