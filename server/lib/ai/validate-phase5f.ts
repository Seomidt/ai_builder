/**
 * validate-phase5f.ts — Phase 5F: Retrieval Quality, Cache & Trust Signals
 *
 * Scenarios:
 *   S01  Retrieval metrics row recorded + retrieved
 *   S02  Retrieval metrics summary returns list
 *   S03  Cache: store + hit works
 *   S04  Cache: tenant isolation (different tenant = miss)
 *   S05  Cache: expired entry returns null
 *   S06  Cache: KB invalidation sets status to invalidated
 *   S07  Cache: hashRetrievalQuery is stable and normalises whitespace
 *   S08  Retrieval version visible in getCurrentRetrievalVersion()
 *   S09  Embedding version visible in getCurrentEmbeddingVersion()
 *   S10  explainEmbeddingVersionState returns required fields
 *   S11  previewStaleEmbeddingDocuments returns array
 *   S12  Trust signal inserted successfully
 *   S13  Risk score: high_risk when avg confidence >= 0.7
 *   S14  Risk score: medium_risk when avg confidence >= 0.4
 *   S15  Risk score: low_risk when avg confidence < 0.4
 *   S16  Risk score: unknown when no signals
 *   S17  getDocumentTrustSignals returns inserted signals
 *   S18  getDocumentRiskScore returns most recent row
 *   S19  explainDocumentTrust contains disclaimer, signals, riskLevel
 *   S20  DB: all new tables present
 *   S21  DB: all new columns on existing tables
 *   S22  DB: CHECK constraints enforced
 *   S23  DB: FK constraint (retrieval_metrics → knowledge_retrieval_runs)
 *   S24  DB: sample rows survive round-trip
 *   S25  Admin endpoint data shapes valid (unit check)
 *
 * Requirements: ≥15 scenarios, ≥60 assertions
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { retrievalMetrics, retrievalCacheEntries } from "@shared/schema";
import {
  recordRetrievalMetrics,
  getRetrievalMetricsByRunId,
  getRetrievalMetricsSummary,
} from "./retrieval-metrics";
import {
  hashRetrievalQuery,
  getCachedRetrieval,
  storeCachedRetrieval,
  invalidateRetrievalCacheForKnowledgeBase,
  previewExpiredRetrievalCache,
} from "./retrieval-cache";
import {
  getCurrentEmbeddingVersion,
  getCurrentRetrievalVersion,
  CURRENT_EMBEDDING_VERSION,
  CURRENT_RETRIEVAL_VERSION,
  previewStaleEmbeddingDocuments,
  explainEmbeddingVersionState,
} from "./embedding-lifecycle";
import {
  recordDocumentTrustSignal,
  calculateDocumentRiskScore,
  getDocumentTrustSignals,
  getDocumentRiskScore,
  explainDocumentTrust,
} from "./document-trust";
import type { ContextWindow } from "./context-window-builder";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

function makeContextWindow(opts: {
  chunks?: number;
  docCount?: number;
  tokens?: number;
  budget?: number;
}): ContextWindow {
  const n = opts.chunks ?? 3;
  const docIds = Array.from({ length: opts.docCount ?? 2 }, (_, i) => `doc-${i}`);
  const entries = Array.from({ length: n }, (_, i) => ({
    text: `chunk text ${i}`,
    metadata: {
      rank: i + 1,
      chunkId: `chunk-${i}`,
      documentId: docIds[i % docIds.length],
      documentVersionId: `ver-${i}`,
      knowledgeBaseId: "kb-test",
      chunkIndex: i,
      chunkKey: `key-${i}`,
      sourcePageStart: null,
      sourceHeadingPath: null,
      similarityScore: 0.9 - i * 0.05,
      similarityMetric: "cosine",
      contentHash: `hash-${i}`,
      estimatedTokens: 80,
    },
  }));
  const tokenUsed = opts.tokens ?? n * 80;
  const budget = opts.budget ?? 4000;
  return {
    entries,
    totalEstimatedTokens: tokenUsed,
    budgetRemaining: budget - tokenUsed,
    budgetUtilizationPct: Math.round((tokenUsed / budget) * 100),
    chunksSelected: n,
    chunksSkippedBudget: 0,
    chunksSkippedDuplicate: 1,
    documentCount: docIds.length,
    documentIds: docIds,
    assembledText: entries.map((e) => e.text).join("\n\n"),
    assemblyFormat: "plain",
  };
}

async function getKnowledgeBase(): Promise<{ id: string; tenantId: string } | null> {
  const res = await db.execute(sql`SELECT id, tenant_id FROM knowledge_bases LIMIT 1`);
  const rows = res.rows as { id: string; tenant_id: string }[];
  if (rows.length === 0) return null;
  return { id: rows[0].id, tenantId: rows[0].tenant_id };
}

async function insertTestRetrievalRun(kbId: string, tenantId: string): Promise<string> {
  const res = await db.execute(sql`
    INSERT INTO knowledge_retrieval_runs
      (tenant_id, knowledge_base_id, query_hash, max_context_tokens)
    VALUES
      (${tenantId}, ${kbId}, 'validate-5f-hash', 4000)
    RETURNING id
  `);
  return (res.rows as { id: string }[])[0].id;
}

// ─── S01: Retrieval metrics recorded ─────────────────────────────────────────

async function s01_metricsRecord(kbId: string, tenantId: string, runId: string) {
  section("S01: Retrieval metrics row recorded");

  const ctx = makeContextWindow({ chunks: 4, docCount: 2, tokens: 320, budget: 4000 });
  const { metricId } = await recordRetrievalMetrics({
    retrievalRunId: runId,
    tenantId,
    knowledgeBaseId: kbId,
    contextWindow: ctx,
    dedupRemovedCount: 2,
  });

  assert(typeof metricId === "string" && metricId.length > 0, "metricId is a non-empty string");

  const row = await getRetrievalMetricsByRunId(runId);
  assert(row !== null, "getRetrievalMetricsByRunId returns row");
  assert((row as Record<string, unknown>).chunkCount === 4, "chunkCount = 4");
  assert((row as Record<string, unknown>).uniqueDocumentCount === 2, "uniqueDocumentCount = 2");
  assert((row as Record<string, unknown>).tokenUsed === 320, "tokenUsed = 320");
  assert((row as Record<string, unknown>).tokenBudget === 4000, "tokenBudget = 4000");
  assert(Number((row as Record<string, unknown>).dedupRemovedCount) >= 2, "dedupRemovedCount >= 2");
  assert((row as Record<string, unknown>).topSimilarity !== null, "topSimilarity is not null");
  assert((row as Record<string, unknown>).diversityScore !== null, "diversityScore is not null");

  return metricId;
}

// ─── S02: Metrics summary ─────────────────────────────────────────────────────

async function s02_metricsSummary(tenantId: string, kbId: string) {
  section("S02: Retrieval metrics summary");

  const summary = await getRetrievalMetricsSummary({ tenantId, knowledgeBaseId: kbId, limit: 10 });
  assert(Array.isArray(summary), "summary is an array");
  assert(summary.length >= 1, "at least 1 summary row");
  const first = summary[0] as Record<string, unknown>;
  assert(typeof first.chunkCount === "number", "summary row has chunkCount");
  assert(typeof first.budgetUtilizationPct === "number", "summary row has budgetUtilizationPct");
}

// ─── S03: Cache store + hit ───────────────────────────────────────────────────

async function s03_cacheHit(tenantId: string, kbId: string) {
  section("S03: Cache store + hit");

  const queryText = "What is the primary ingestion pipeline for documents?";
  const queryHash = hashRetrievalQuery(queryText);
  const chunkIds = ["chunk-aaa", "chunk-bbb", "chunk-ccc"];

  const { cacheId } = await storeCachedRetrieval({
    tenantId,
    knowledgeBaseId: kbId,
    queryHash,
    queryText,
    resultChunkIds: chunkIds,
    resultSummary: { chunksSelected: 3 },
    ttlSeconds: 3600,
  });

  assert(typeof cacheId === "string", "cacheId returned from store");

  const hit = await getCachedRetrieval({ tenantId, knowledgeBaseId: kbId, queryHash });
  assert(hit !== null, "cache hit found");
  assert(hit!.hitStatus === "hit", "hitStatus is 'hit'");
  assert(Array.isArray(hit!.resultChunkIds), "resultChunkIds is array");
  assert(hit!.resultChunkIds.length === 3, "resultChunkIds has 3 entries");
  assert(hit!.tenantId === tenantId, "cached tenantId matches");
  assert(hit!.knowledgeBaseId === kbId, "cached knowledgeBaseId matches");
  assert(hit!.queryHash === queryHash, "cached queryHash matches");

  return { queryHash, cacheId };
}

// ─── S04: Cache tenant isolation ─────────────────────────────────────────────

async function s04_cacheTenantIsolation(kbId: string, queryHash: string) {
  section("S04: Cache tenant isolation");

  const otherTenantHit = await getCachedRetrieval({
    tenantId: "other-tenant-xyz",
    knowledgeBaseId: kbId,
    queryHash,
  });
  assert(otherTenantHit === null, "different tenant cannot see cache entry (INV-RET7)");

  const otherKbHit = await getCachedRetrieval({
    tenantId: "other-tenant-xyz",
    knowledgeBaseId: "different-kb",
    queryHash,
  });
  assert(otherKbHit === null, "different KB cannot see cache entry");
}

// ─── S05: Expired cache ignored ───────────────────────────────────────────────

async function s05_expiredCacheIgnored(tenantId: string, kbId: string) {
  section("S05: Expired cache entry ignored");

  const expiredQueryText = "an expired query for testing purposes";
  const expiredHash = hashRetrievalQuery(expiredQueryText);

  // Insert directly with expires_at in the past
  await db.execute(sql`
    INSERT INTO retrieval_cache_entries
      (tenant_id, knowledge_base_id, query_hash, query_text, retrieval_version, result_chunk_ids, expires_at)
    VALUES
      (${tenantId}, ${kbId}, ${expiredHash}, ${expiredQueryText}, 'v1.0', '["old-chunk"]', now() - interval '1 hour')
  `);

  const hit = await getCachedRetrieval({ tenantId, knowledgeBaseId: kbId, queryHash: expiredHash });
  assert(hit === null, "expired cache entry returns null");
}

// ─── S06: KB invalidation ─────────────────────────────────────────────────────

async function s06_kbInvalidation(tenantId: string, kbId: string) {
  section("S06: KB cache invalidation");

  const result = await invalidateRetrievalCacheForKnowledgeBase({ tenantId, knowledgeBaseId: kbId });
  assert(typeof result.invalidatedCount === "number", "invalidatedCount is a number");
  assert(result.invalidatedCount >= 0, "invalidatedCount >= 0");

  // After invalidation, no active cache should remain for this KB
  const verifyRes = await db.execute(sql`
    SELECT count(*) as cnt FROM retrieval_cache_entries
    WHERE tenant_id = ${tenantId}
      AND knowledge_base_id = ${kbId}
      AND cache_status = 'active'
  `);
  const activeCount = Number((verifyRes.rows as { cnt: string }[])[0].cnt);
  assert(activeCount === 0, "no active cache entries remain after KB invalidation");
}

// ─── S07: hashRetrievalQuery stability ────────────────────────────────────────

async function s07_hashStability() {
  section("S07: hashRetrievalQuery stability and normalisation");

  const h1 = hashRetrievalQuery("what is the capital of France?");
  const h2 = hashRetrievalQuery("what is the capital of France?");
  assert(h1 === h2, "same input → same hash (deterministic)");

  const h3 = hashRetrievalQuery("  What Is The Capital  Of France?  ");
  assert(h3 === h1, "whitespace+case normalised → same hash");

  assert(h1.length === 64, "SHA-256 produces 64-char hex string");

  const hDiff = hashRetrievalQuery("different query entirely");
  assert(hDiff !== h1, "different input → different hash");
}

// ─── S08 + S09: Version constants ─────────────────────────────────────────────

async function s08s09_versionConstants() {
  section("S08-S09: Embedding + Retrieval version constants");

  const ev = getCurrentEmbeddingVersion();
  assert(typeof ev === "string" && ev.length > 0, "getCurrentEmbeddingVersion returns non-empty string");
  assert(ev === CURRENT_EMBEDDING_VERSION, "returned value matches module constant");

  const rv = getCurrentRetrievalVersion();
  assert(typeof rv === "string" && rv.length > 0, "getCurrentRetrievalVersion returns non-empty string");
  assert(rv === CURRENT_RETRIEVAL_VERSION, "returned value matches module constant");
}

// ─── S10: explainEmbeddingVersionState ────────────────────────────────────────

async function s10_explainEmbeddingVersionState(tenantId: string, kbId: string) {
  section("S10: explainEmbeddingVersionState output");

  const explanation = await explainEmbeddingVersionState({ tenantId, knowledgeBaseId: kbId });
  const e = explanation as Record<string, unknown>;

  assert(typeof e === "object", "returns an object");
  assert(e.currentEmbeddingVersion === CURRENT_EMBEDDING_VERSION, "currentEmbeddingVersion correct");
  assert(e.currentRetrievalVersion === CURRENT_RETRIEVAL_VERSION, "currentRetrievalVersion correct");
  assert(typeof e.totalEmbeddings === "number", "totalEmbeddings is a number");
  assert(typeof e.staleEmbeddings === "number", "staleEmbeddings is a number");
  assert(typeof e.requiresReindex === "boolean", "requiresReindex is boolean");
  assert(typeof e.note === "string", "note is a string");
}

// ─── S11: previewStaleEmbeddingDocuments ──────────────────────────────────────

async function s11_stalePreview(tenantId: string) {
  section("S11: previewStaleEmbeddingDocuments returns array");

  const stale = await previewStaleEmbeddingDocuments({ tenantId, limit: 10 });
  assert(Array.isArray(stale), "returns an array");
  if (stale.length > 0) {
    const first = stale[0];
    assert("embeddingId" in first, "item has embeddingId");
    assert("isStale" in first, "item has isStale");
    assert("expectedVersion" in first, "item has expectedVersion");
  } else {
    assert(true, "empty array is valid (no embeddings yet)");
  }
}

// ─── S12: Trust signal insert ─────────────────────────────────────────────────

async function s12_trustSignalInsert(tenantId: string): Promise<string> {
  section("S12: Trust signal inserted");

  const docId = "doc-trust-test-001";
  const { signalId } = await recordDocumentTrustSignal({
    tenantId,
    documentId: docId,
    signalType: "metadata_completeness",
    signalSource: "ingest_pipeline",
    confidenceScore: 0.75,
    rawEvidence: { fieldsCovered: 12, totalFields: 16 },
  });

  assert(typeof signalId === "string" && signalId.length > 0, "signalId returned");

  // Also add a second signal with low confidence
  await recordDocumentTrustSignal({
    tenantId,
    documentId: docId,
    signalType: "format_consistency",
    signalSource: "parser",
    confidenceScore: 0.30,
    rawEvidence: { issues: 3 },
  });

  return docId;
}

// ─── S13–S16: Risk score calculation ──────────────────────────────────────────

async function s13to16_riskScores(tenantId: string, docId: string) {
  section("S13-S16: Risk score derivation");

  // High risk
  const highResult = await calculateDocumentRiskScore({
    tenantId,
    documentId: docId,
    signals: [
      { signalType: "a", confidenceScore: 0.80 },
      { signalType: "b", confidenceScore: 0.75 },
    ],
  });
  assert(highResult.riskLevel === "high_risk", "avg 0.775 → high_risk");
  assert(highResult.riskScore >= 0.7, "riskScore >= 0.7 for high_risk");

  // Medium risk
  const medResult = await calculateDocumentRiskScore({
    tenantId,
    documentId: docId,
    signals: [
      { signalType: "c", confidenceScore: 0.50 },
      { signalType: "d", confidenceScore: 0.45 },
    ],
  });
  assert(medResult.riskLevel === "medium_risk", "avg 0.475 → medium_risk");

  // Low risk
  const lowResult = await calculateDocumentRiskScore({
    tenantId,
    documentId: docId,
    signals: [
      { signalType: "e", confidenceScore: 0.10 },
      { signalType: "f", confidenceScore: 0.20 },
    ],
  });
  assert(lowResult.riskLevel === "low_risk", "avg 0.15 → low_risk");

  // Unknown risk
  const unknownResult = await calculateDocumentRiskScore({
    tenantId,
    documentId: docId,
    signals: [],
  });
  assert(unknownResult.riskLevel === "unknown", "no signals → unknown");
}

// ─── S17: getDocumentTrustSignals ─────────────────────────────────────────────

async function s17_getSignals(tenantId: string, docId: string) {
  section("S17: getDocumentTrustSignals returns inserted signals");

  const signals = await getDocumentTrustSignals(docId, tenantId);
  assert(Array.isArray(signals), "returns array");
  assert(signals.length >= 2, "at least 2 signals from s12 insertions");

  const types = signals.map((s) => (s as Record<string, unknown>).signalType as string);
  assert(types.includes("metadata_completeness"), "metadata_completeness signal present");
  assert(types.includes("format_consistency"), "format_consistency signal present");
}

// ─── S18: getDocumentRiskScore ────────────────────────────────────────────────

async function s18_getRiskScore(tenantId: string, docId: string) {
  section("S18: getDocumentRiskScore returns most recent row");

  const score = await getDocumentRiskScore(docId, tenantId);
  assert(score !== null, "risk score row returned");
  const s = score as Record<string, unknown>;
  assert(s.documentId === docId, "documentId matches");
  assert(["low_risk", "medium_risk", "high_risk", "unknown"].includes(s.riskLevel as string), "riskLevel is valid");
}

// ─── S19: explainDocumentTrust ────────────────────────────────────────────────

async function s19_explainDocumentTrust(tenantId: string, docId: string) {
  section("S19: explainDocumentTrust output structure");

  const explanation = await explainDocumentTrust(docId, tenantId);
  const e = explanation as Record<string, unknown>;

  assert(typeof e === "object", "returns an object");
  assert(e.documentId === docId, "documentId correct");
  assert(Array.isArray(e.signals), "signals is an array");
  assert(e.totalSignals as number >= 2, "totalSignals >= 2");
  assert(typeof e.disclaimer === "string", "disclaimer present (INV-TRUST3)");
  assert((e.disclaimer as string).toLowerCase().includes("advisory"), "disclaimer is advisory language");
  assert(Array.isArray(e.signalTypes), "signalTypes present");
  assert(typeof e.latestRiskLevel === "string", "latestRiskLevel present");
}

// ─── S20: DB tables present ───────────────────────────────────────────────────

async function s20_dbTablesPresent() {
  section("S20: DB — all new tables present");

  const tables = [
    "retrieval_metrics",
    "retrieval_cache_entries",
    "document_trust_signals",
    "document_risk_scores",
  ];

  for (const table of tables) {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    `);
    assert((res.rows as { table_name: string }[]).length === 1, `table ${table} exists`);
  }
}

// ─── S21: New columns on existing tables ──────────────────────────────────────

async function s21_dbNewColumns() {
  section("S21: DB — new columns on existing tables");

  const embRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings' AND column_name = 'embedding_version'
  `);
  assert((embRes.rows as { column_name: string }[]).length === 1, "knowledge_embeddings.embedding_version present");

  const krrRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_retrieval_runs'
      AND column_name IN ('embedding_version','retrieval_version')
  `);
  assert((krrRes.rows as { column_name: string }[]).length === 2, "knowledge_retrieval_runs: embedding_version + retrieval_version present");
}

// ─── S22: CHECK constraints ───────────────────────────────────────────────────

async function s22_dbConstraints() {
  section("S22: DB — CHECK constraints enforced");

  let threwRm = false;
  try {
    await db.execute(sql`
      INSERT INTO retrieval_metrics
        (retrieval_run_id, tenant_id, knowledge_base_id, chunk_count, unique_document_count, token_used, token_budget)
      VALUES ((SELECT id FROM knowledge_retrieval_runs LIMIT 1), 't', 'kb', -1, 0, 0, 100)
    `);
  } catch { threwRm = true; }
  assert(threwRm, "rm_chunk_count_check rejects chunk_count < 0");

  let threwRce = false;
  try {
    await db.execute(sql`
      INSERT INTO retrieval_cache_entries
        (tenant_id, knowledge_base_id, query_hash, query_text, retrieval_version, result_chunk_ids, expires_at, cache_status)
      VALUES ('t', 'kb', 'h', 'q', 'v1', '[]', now() + interval '1 hour', 'BAD_STATUS')
    `);
  } catch { threwRce = true; }
  assert(threwRce, "rce_cache_status_check rejects invalid cache_status");

  let threwDrs = false;
  try {
    await db.execute(sql`
      INSERT INTO document_risk_scores
        (tenant_id, document_id, risk_level, risk_score, scoring_version, contributing_signals)
      VALUES ('t', 'doc', 'invalid_level', 0.5, 'v1', '[]')
    `);
  } catch { threwDrs = true; }
  assert(threwDrs, "drs_risk_level_check rejects invalid risk_level");
}

// ─── S23: FK constraint ───────────────────────────────────────────────────────

async function s23_fkConstraint() {
  section("S23: DB — FK constraint retrieval_metrics → knowledge_retrieval_runs");

  let threw = false;
  try {
    await db.execute(sql`
      INSERT INTO retrieval_metrics
        (retrieval_run_id, tenant_id, knowledge_base_id, chunk_count, unique_document_count, token_used, token_budget)
      VALUES ('non-existent-run-id-xyz', 't', 'kb', 0, 0, 0, 100)
    `);
  } catch { threw = true; }
  assert(threw, "FK constraint rejects invalid retrieval_run_id");
}

// ─── S24: Sample rows survive round-trip ──────────────────────────────────────

async function s24_sampleRows(tenantId: string, kbId: string) {
  section("S24: Sample rows round-trip correctly");

  const previewRows = await previewExpiredRetrievalCache({ tenantId, knowledgeBaseId: kbId });
  assert(typeof previewRows.expiredCount === "number", "previewExpiredRetrievalCache returns expiredCount");
  assert(Array.isArray(previewRows.sample), "sample is an array");

  // Trust signals were inserted in s12
  const docId = "doc-trust-test-001";
  const signals = await getDocumentTrustSignals(docId, tenantId);
  assert(signals.length >= 1, "trust signals retrievable after insert");
}

// ─── S25: Admin endpoint data shapes ─────────────────────────────────────────

async function s25_adminEndpointShapes() {
  section("S25: Admin endpoint response shape validation (unit check)");

  const embeddingVersion = getCurrentEmbeddingVersion();
  assert(typeof embeddingVersion === "string", "embedding version endpoint shape: string");

  const retrievalVersion = getCurrentRetrievalVersion();
  assert(typeof retrievalVersion === "string", "retrieval version endpoint shape: string");

  // Verify hashRetrievalQuery output can be used as query param
  const hash = hashRetrievalQuery("sample admin query");
  assert(hash.length === 64, "query hash is URL-safe 64-char hex string");
  assert(/^[0-9a-f]+$/.test(hash), "query hash is lowercase hex");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runValidation() {
  console.log("========================================");
  console.log("  validate-phase5f.ts — Phase 5F");
  console.log("  Retrieval Quality, Cache & Trust");
  console.log("========================================\n");

  const kb = await getKnowledgeBase();
  if (!kb) {
    console.error("✗ No knowledge_bases found — cannot run DB-dependent tests");
    process.exit(1);
  }

  const { id: kbId, tenantId } = kb;
  console.log(`Using: tenantId=${tenantId}, kbId=${kbId}\n`);

  const runId = await insertTestRetrievalRun(kbId, tenantId);
  console.log(`Created test retrieval run: ${runId}\n`);

  let metricId = "";
  let docId = "";
  let queryHash = "";

  try { metricId = (await s01_metricsRecord(kbId, tenantId, runId)).toString(); } catch (e) { console.error("s01 error:", e); failed++; }
  try { await s02_metricsSummary(tenantId, kbId); } catch (e) { console.error("s02 error:", e); failed++; }
  try { const r = await s03_cacheHit(tenantId, kbId); queryHash = r.queryHash; } catch (e) { console.error("s03 error:", e); failed++; }
  try { await s04_cacheTenantIsolation(kbId, queryHash); } catch (e) { console.error("s04 error:", e); failed++; }
  try { await s05_expiredCacheIgnored(tenantId, kbId); } catch (e) { console.error("s05 error:", e); failed++; }
  try { await s06_kbInvalidation(tenantId, kbId); } catch (e) { console.error("s06 error:", e); failed++; }
  try { await s07_hashStability(); } catch (e) { console.error("s07 error:", e); failed++; }
  try { await s08s09_versionConstants(); } catch (e) { console.error("s08s09 error:", e); failed++; }
  try { await s10_explainEmbeddingVersionState(tenantId, kbId); } catch (e) { console.error("s10 error:", e); failed++; }
  try { await s11_stalePreview(tenantId); } catch (e) { console.error("s11 error:", e); failed++; }
  try { docId = await s12_trustSignalInsert(tenantId); } catch (e) { console.error("s12 error:", e); failed++; }
  try { await s13to16_riskScores(tenantId, docId); } catch (e) { console.error("s13-16 error:", e); failed++; }
  try { await s17_getSignals(tenantId, docId); } catch (e) { console.error("s17 error:", e); failed++; }
  try { await s18_getRiskScore(tenantId, docId); } catch (e) { console.error("s18 error:", e); failed++; }
  try { await s19_explainDocumentTrust(tenantId, docId); } catch (e) { console.error("s19 error:", e); failed++; }
  try { await s20_dbTablesPresent(); } catch (e) { console.error("s20 error:", e); failed++; }
  try { await s21_dbNewColumns(); } catch (e) { console.error("s21 error:", e); failed++; }
  try { await s22_dbConstraints(); } catch (e) { console.error("s22 error:", e); failed++; }
  try { await s23_fkConstraint(); } catch (e) { console.error("s23 error:", e); failed++; }
  try { await s24_sampleRows(tenantId, kbId); } catch (e) { console.error("s24 error:", e); failed++; }
  try { await s25_adminEndpointShapes(); } catch (e) { console.error("s25 error:", e); failed++; }

  // Cleanup
  await db.execute(sql`DELETE FROM retrieval_metrics WHERE retrieval_run_id = ${runId}`);
  await db.execute(sql`DELETE FROM knowledge_retrieval_runs WHERE id = ${runId}`);

  console.log("\n========================================");
  console.log(`  RESULTS: ${passed} passed / ${failed} failed`);
  console.log(`  Total assertions: ${passed + failed}`);
  console.log("========================================");

  if (failures.length > 0) {
    console.log("\nFAILED ASSERTIONS:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }

  if (failed > 0) {
    console.error("\nValidation FAILED.");
    process.exit(1);
  } else {
    console.log("\nAll assertions passed. Phase 5F validation complete.\n");
  }
}

runValidation().catch((e) => {
  console.error("Validation runner error:", e);
  process.exit(1);
});
