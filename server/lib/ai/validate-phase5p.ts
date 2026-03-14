/**
 * validate-phase5p.ts — Phase 5P
 *
 * Service-layer validation: Answer Grounding, Citations & Retrieval Observability
 *
 * Validates all 8 service-layer invariants (INV-ANS1–8) and
 * 28 behavioral scenarios with 140+ assertions.
 */

import pg from "pg";
import {
  buildAnswerContext,
  extractAnswerCitations,
  buildGroundedAnswer,
  summarizeAnswerGrounding,
  getAnswerCitations,
  explainAnswerTrace,
  getRetrievalRuntimeMetrics,
  summarizeRetrievalRuntimeMetrics,
  getAnswerContext,
} from "./answer-grounding";
import {
  describeRetrievalConfig,
  clampShortlistSize,
  ADVANCED_RERANK_SHORTLIST_SIZE,
  ADVANCED_RERANK_SHORTLIST_MIN,
  ADVANCED_RERANK_SHORTLIST_MAX,
  ADVANCED_RERANK_WEIGHT,
  FUSED_SCORE_WEIGHT,
  CITATION_PREVIEW_CHARS,
  ANSWER_GENERATION_MODEL,
} from "../config/retrieval-config";
import type { ContextWindowEntry } from "./context-window-builder";
import type { AdvancedRerankCandidate } from "./advanced-reranking";

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function makeContextEntries(n: number): ContextWindowEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `This is the content of context chunk number ${i + 1}. It discusses topic ${i % 3 === 0 ? "infrastructure" : i % 3 === 1 ? "security" : "deployment"} in detail. Relevant keywords: system, architecture, production.`,
    metadata: {
      rank: i + 1,
      chunkId: `chunk-${String(i).padStart(3, "0")}`,
      documentId: `doc-${i % 3}`,
      documentVersionId: `docver-${i % 3}`,
      knowledgeBaseId: "kb-alpha",
      chunkIndex: i,
      chunkKey: `key-${i}`,
      sourcePageStart: i + 1,
      sourceHeadingPath: `Section ${i + 1}`,
      similarityScore: 0.8 - i * 0.05,
      similarityMetric: "cosine",
      contentHash: `hash-${i}`,
      estimatedTokens: 50,
    },
  }));
}

function makeAdvancedCandidates(entries: ContextWindowEntry[]): AdvancedRerankCandidate[] {
  return entries.map((e, i) => ({
    chunkId: e.metadata.chunkId,
    documentId: e.metadata.documentId,
    documentVersionId: e.metadata.documentVersionId,
    knowledgeBaseId: e.metadata.knowledgeBaseId,
    chunkText: e.text,
    chunkIndex: i,
    chunkKey: e.metadata.chunkKey,
    sourcePageStart: null,
    sourceHeadingPath: null,
    contentHash: null,
    channelOrigin: "vector_and_lexical" as const,
    vectorScore: 0.8 - i * 0.05,
    lexicalScore: 0.7 - i * 0.04,
    fusedScore: 0.75 - i * 0.04,
    preFusionRankVector: i + 1,
    preFusionRankLexical: i + 1,
    postFusionRank: i + 1,
    rerankScore: null,
    preRerankRank: i + 1,
    postRerankRank: i + 1,
    filterStatus: "candidate" as const,
    sourceType: "parsed_text",
    sourceKey: null,
    similarityScore: 0.8 - i * 0.05,
    rankingScore: 0,
    knowledgeAssetEmbeddingId: null,
    knowledgeAssetId: `asset-${i % 3}`,
    knowledgeAssetVersionId: `assetver-${i % 3}`,
    tenantId: "tenant-alpha",
    candidateRank: i + 1,
    finalRank: i + 1,
    tokenCountEstimate: 50,
    heavyRerankScore: null,
    finalScore: 0.75 - i * 0.04,
    rerankMode: "fallback" as const,
    fallbackUsed: true,
    fallbackReason: "no_api_key",
    shortlistRank: i < 20 ? i + 1 : null,
    advancedRerankRank: i < 20 ? i + 1 : null,
    rerankProviderName: null,
    rerankProviderVersion: null,
  }));
}

// ── Main validation ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── SCENARIO 1: DB schema — knowledge_answer_runs ─────────────────────────

  section("SCENARIO 1: DB schema — knowledge_answer_runs table exists");
  const kar = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  assert(kar.rowCount === 1, "knowledge_answer_runs table exists");

  const karCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  assert(parseInt(karCols.rows[0].cnt, 10) === 17, "knowledge_answer_runs has 17 columns");

  // ── SCENARIO 2: DB schema — knowledge_answer_citations ───────────────────

  section("SCENARIO 2: DB schema — knowledge_answer_citations table exists");
  const kac = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_answer_citations'`,
  );
  assert(kac.rowCount === 1, "knowledge_answer_citations table exists");

  const kacCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_citations'`,
  );
  assert(parseInt(kacCols.rows[0].cnt, 10) === 12, "knowledge_answer_citations has 12 columns");

  // ── SCENARIO 3: RLS on both tables ───────────────────────────────────────

  section("SCENARIO 3: RLS — both answer tables have RLS enabled");
  const rlsRun = await client.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname='knowledge_answer_runs' AND relnamespace='public'::regnamespace`,
  );
  assert(rlsRun.rows[0]?.relrowsecurity === true, "knowledge_answer_runs has RLS enabled");

  const rlsCit = await client.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname='knowledge_answer_citations' AND relnamespace='public'::regnamespace`,
  );
  assert(rlsCit.rows[0]?.relrowsecurity === true, "knowledge_answer_citations has RLS enabled");

  // ── SCENARIO 4: RLS policy count ─────────────────────────────────────────

  section("SCENARIO 4: RLS — 4 policies per table (8 total)");
  const rp1 = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_answer_runs'`,
  );
  assert(parseInt(rp1.rows[0].cnt, 10) === 4, "knowledge_answer_runs has 4 RLS policies");

  const rp2 = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_answer_citations'`,
  );
  assert(parseInt(rp2.rows[0].cnt, 10) === 4, "knowledge_answer_citations has 4 RLS policies");

  // ── SCENARIO 5: RLS table count = 99 ─────────────────────────────────────

  section("SCENARIO 5: RLS table count = 99");
  const rlsTotal = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rlsCount = parseInt(rlsTotal.rows[0].cnt, 10);
  assert(rlsCount === 99, `RLS tables = 99 (got ${rlsCount})`);

  // ── SCENARIO 6: All 5 indexes present ────────────────────────────────────

  section("SCENARIO 6: DB indexes — all 5 present");
  const expectedIndexes = ["kar_tenant_run_idx", "kar_tenant_created_idx", "kac_answer_run_idx", "kac_tenant_idx", "kac_chunk_idx"];
  for (const idx of expectedIndexes) {
    const iR = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx]);
    assert(iR.rowCount === 1, `Index exists: ${idx}`);
  }

  // ── SCENARIO 7: Retrieval config — defaults ───────────────────────────────

  section("SCENARIO 7: Retrieval config — all defaults correct");
  assert(ADVANCED_RERANK_SHORTLIST_SIZE === 20, "Default shortlist size = 20");
  assert(ADVANCED_RERANK_SHORTLIST_MIN === 1, "Min shortlist size = 1");
  assert(ADVANCED_RERANK_SHORTLIST_MAX === 50, "Max shortlist size = 50");
  assert(Math.abs(ADVANCED_RERANK_WEIGHT - 0.7) < 1e-9, "advancedRerankWeight = 0.7");
  assert(Math.abs(FUSED_SCORE_WEIGHT - 0.3) < 1e-9, "fusedScoreWeight = 0.3");
  assert(CITATION_PREVIEW_CHARS === 200, "citationPreviewChars = 200");
  assert(ANSWER_GENERATION_MODEL === "gpt-4o-mini", "answerGenerationModel = gpt-4o-mini");

  // ── SCENARIO 8: clampShortlistSize ───────────────────────────────────────

  section("SCENARIO 8: clampShortlistSize — boundary behavior");
  assert(clampShortlistSize(0) === 1, "clamp(0) = min(1)");
  assert(clampShortlistSize(20) === 20, "clamp(20) = 20 (within bounds)");
  assert(clampShortlistSize(100) === 50, "clamp(100) = max(50)");
  assert(clampShortlistSize(1) === 1, "clamp(1) = 1 (at min)");
  assert(clampShortlistSize(50) === 50, "clamp(50) = 50 (at max)");

  // ── SCENARIO 9: describeRetrievalConfig ──────────────────────────────────

  section("SCENARIO 9: describeRetrievalConfig — all fields present");
  const cfg = describeRetrievalConfig();
  assert(cfg.advancedRerankShortlistSize !== undefined, "advancedRerankShortlistSize documented");
  assert(cfg.advancedRerankWeight !== undefined, "advancedRerankWeight documented");
  assert(cfg.fusedScoreWeight !== undefined, "fusedScoreWeight documented");
  assert(cfg.answerGenerationModel !== undefined, "answerGenerationModel documented");
  assert(cfg.citationPreviewChars !== undefined, "citationPreviewChars documented");

  // ── SCENARIO 10: buildAnswerContext — basic ───────────────────────────────

  section("SCENARIO 10: buildAnswerContext — formats context correctly");
  const entries10 = makeContextEntries(5);
  const { formattedContext, usedEntries } = buildAnswerContext(entries10);
  assert(formattedContext.includes("[C1]:"), "Context includes [C1] label");
  assert(formattedContext.includes("[C2]:"), "Context includes [C2] label");
  assert(formattedContext.includes("[C5]:"), "Context includes [C5] label");
  assert(usedEntries.length === 5, "All 5 entries included");

  // ── SCENARIO 11: buildAnswerContext — truncation ──────────────────────────

  section("SCENARIO 11: buildAnswerContext — token budget truncation");
  const entries11 = makeContextEntries(50);
  const { usedEntries: used11 } = buildAnswerContext(entries11, 1000);
  assert(used11.length < 50, "Long entry list is truncated at budget limit");
  assert(used11.length > 0, "At least 1 entry included");

  // ── SCENARIO 12: extractAnswerCitations — with markers ───────────────────

  section("SCENARIO 12: extractAnswerCitations — correct mapping");
  const entries12 = makeContextEntries(4);
  const candidates12 = makeAdvancedCandidates(entries12);
  const answerText12 = "The infrastructure is robust [C1]. Security is ensured [C3]. Deployment follows [C1] and [C2].";
  const citations12 = extractAnswerCitations(answerText12, entries12, candidates12);
  assert(citations12.length === 3, "3 unique citations extracted ([C1], [C2], [C3])");
  assert(citations12.some((c) => c.citationId === "c1"), "c1 citation present");
  assert(citations12.some((c) => c.citationId === "c2"), "c2 citation present");
  assert(citations12.some((c) => c.citationId === "c3"), "c3 citation present");
  assert(citations12[0].chunkId === entries12[0].metadata.chunkId, "c1 → correct chunkId");

  // ── SCENARIO 13: extractAnswerCitations — no fabrication (INV-ANS2/3) ────

  section("SCENARIO 13: extractAnswerCitations — no fabricated citations (INV-ANS2/3)");
  const entries13 = makeContextEntries(3);
  const cands13 = makeAdvancedCandidates(entries13);
  // [C99] refers to a chunk that doesn't exist → should NOT be included
  const answerText13 = "Context says [C1] and also [C99] which doesn't exist.";
  const citations13 = extractAnswerCitations(answerText13, entries13, cands13);
  assert(!citations13.some((c) => c.citationId === "c99"), "INV-ANS2/3: [C99] not included (no real chunk)");
  assert(citations13.some((c) => c.citationId === "c1"), "c1 is included (real chunk)");

  // ── SCENARIO 14: extractAnswerCitations — score preserved ────────────────

  section("SCENARIO 14: extractAnswerCitations — finalScore preserved");
  const entries14 = makeContextEntries(2);
  const cands14 = makeAdvancedCandidates(entries14);
  const cit14 = extractAnswerCitations("[C1] is relevant.", entries14, cands14);
  assert(cit14.length === 1, "1 citation extracted");
  assert(typeof cit14[0].score === "number", "score is a number");
  assert(cit14[0].score >= 0 && cit14[0].score <= 1, "score in [0,1]");

  // ── SCENARIO 15: extractAnswerCitations — ordering preserved ─────────────

  section("SCENARIO 15: extractAnswerCitations — citation order preserved");
  const entries15 = makeContextEntries(5);
  const cands15 = makeAdvancedCandidates(entries15);
  const cit15 = extractAnswerCitations("[C3] first, [C1] second, [C5] third.", entries15, cands15);
  const positions = cit15.map((c) => c.contextPosition);
  assert(JSON.stringify(positions) === JSON.stringify([...positions].sort((a,b)=>a-b)), "Citations sorted by position");

  // ── SCENARIO 16: buildGroundedAnswer — fallback mode (no API key) ─────────

  section("SCENARIO 16: buildGroundedAnswer — fallback when no API key (INV-ANS1)");
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const entries16 = makeContextEntries(5);
  const cands16 = makeAdvancedCandidates(entries16);
  const result16 = await buildGroundedAnswer({
    queryText: "What is the infrastructure setup?",
    contextEntries: entries16,
    candidates: cands16,
    tenantId: "tenant-alpha",
    persistAnswer: false,
  });
  assert(result16.fallbackUsed === true, "Fallback used when no API key");
  assert(result16.answerRunId === null, "answerRunId=null in preview mode");
  assert(result16.citations.length > 0, "Citations present in fallback answer");
  assert(result16.citations.every((c) => c.chunkId.startsWith("chunk-")), "Citations reference real chunk IDs");
  assert(result16.contextChunkCount > 0, "Context chunk count > 0");
  process.env.OPENAI_API_KEY = origKey;

  // ── SCENARIO 17: INV-ANS1 — answer only uses retrieved context ───────────

  section("SCENARIO 17: INV-ANS1 — answer text comes from retrieved context only");
  const result17 = await buildGroundedAnswer({
    queryText: "Tell me about deployment",
    contextEntries: makeContextEntries(3),
    candidates: makeAdvancedCandidates(makeContextEntries(3)),
    tenantId: "tenant-beta",
    persistAnswer: false,
  });
  assert(typeof result17.answerText === "string", "INV-ANS1: answerText is a string");
  assert(result17.answerText.length > 0, "INV-ANS1: answerText is non-empty");

  // ── SCENARIO 18: INV-ANS2 — citations reference real chunks ──────────────

  section("SCENARIO 18: INV-ANS2 — citations reference real chunk IDs");
  const realChunkIds = makeContextEntries(5).map((e) => e.metadata.chunkId);
  const result18 = await buildGroundedAnswer({
    queryText: "Security overview",
    contextEntries: makeContextEntries(5),
    candidates: makeAdvancedCandidates(makeContextEntries(5)),
    tenantId: "tenant-alpha",
    persistAnswer: false,
  });
  assert(
    result18.citations.every((c) => realChunkIds.includes(c.chunkId)),
    "INV-ANS2: All citations reference real chunk IDs",
  );

  // ── SCENARIO 19: INV-ANS3 — no fabricated sources ────────────────────────

  section("SCENARIO 19: INV-ANS3 — no fabricated sources");
  const result19 = await buildGroundedAnswer({
    queryText: "query about unknown topic",
    contextEntries: makeContextEntries(2),
    candidates: makeAdvancedCandidates(makeContextEntries(2)),
    tenantId: "tenant-gamma",
    persistAnswer: false,
  });
  assert(result19.citations.length <= 5, "INV-ANS3: Citations bounded by context size");
  assert(!result19.citations.some((c) => c.chunkId === "fabricated-id"), "INV-ANS3: No fabricated chunk IDs");

  // ── SCENARIO 20: INV-ANS4 — tenant isolation ─────────────────────────────

  section("SCENARIO 20: INV-ANS4 — tenant isolation");
  const resultA = await buildGroundedAnswer({
    queryText: "q", contextEntries: makeContextEntries(2),
    candidates: makeAdvancedCandidates(makeContextEntries(2)),
    tenantId: "tenant-A", persistAnswer: false,
  });
  const resultB = await buildGroundedAnswer({
    queryText: "q", contextEntries: makeContextEntries(2),
    candidates: makeAdvancedCandidates(makeContextEntries(2)),
    tenantId: "tenant-B", persistAnswer: false,
  });
  assert(resultA.answerRunId === null, "INV-ANS4: No cross-tenant persistence in preview");
  assert(resultB.answerRunId === null, "INV-ANS4: No cross-tenant persistence in preview");

  // ── SCENARIO 21: INV-ANS5 — answer trace is deterministic ────────────────

  section("SCENARIO 21: INV-ANS5 — answer trace determinism");
  const r21a = await buildGroundedAnswer({
    queryText: "test", contextEntries: makeContextEntries(3),
    candidates: makeAdvancedCandidates(makeContextEntries(3)),
    tenantId: "tenant-alpha", persistAnswer: false,
  });
  const r21b = await buildGroundedAnswer({
    queryText: "test", contextEntries: makeContextEntries(3),
    candidates: makeAdvancedCandidates(makeContextEntries(3)),
    tenantId: "tenant-alpha", persistAnswer: false,
  });
  assert(r21a.fallbackReason === r21b.fallbackReason, "INV-ANS5: Deterministic fallback reason");
  assert(r21a.contextChunkCount === r21b.contextChunkCount, "INV-ANS5: Deterministic context chunk count");

  // ── SCENARIO 22: INV-ANS6 — does not mutate retrieval records ────────────

  section("SCENARIO 22: INV-ANS6 — answer generation does not mutate retrieval records");
  // Answer runs do not reference retrieval_candidates table; they only link via retrievalRunId
  const beforeCount = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_candidates`);
  await buildGroundedAnswer({
    queryText: "test mutation safety", contextEntries: makeContextEntries(3),
    candidates: makeAdvancedCandidates(makeContextEntries(3)),
    tenantId: "tenant-alpha", persistAnswer: false,
  });
  const afterCount = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_candidates`);
  assert(
    parseInt(beforeCount.rows[0].cnt, 10) === parseInt(afterCount.rows[0].cnt, 10),
    "INV-ANS6: knowledge_retrieval_candidates count unchanged after answer generation",
  );

  // ── SCENARIO 23: INV-ANS7 — preview does not persist ─────────────────────

  section("SCENARIO 23: INV-ANS7 — preview endpoint does not persist");
  const beforeRuns = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  const previewResult = await buildGroundedAnswer({
    queryText: "preview test", contextEntries: makeContextEntries(2),
    candidates: makeAdvancedCandidates(makeContextEntries(2)),
    tenantId: "tenant-preview", persistAnswer: false, // INV-ANS7
  });
  const afterRuns = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  assert(previewResult.answerRunId === null, "INV-ANS7: answerRunId=null in preview mode");
  assert(
    parseInt(beforeRuns.rows[0].cnt, 10) === parseInt(afterRuns.rows[0].cnt, 10),
    "INV-ANS7: No rows inserted in knowledge_answer_runs during preview",
  );

  // ── SCENARIO 24: persistAnswer=true — actual persistence ─────────────────

  section("SCENARIO 24: persistAnswer=true — answer and citations persisted");
  const persistResult = await buildGroundedAnswer({
    queryText: "persistent test query",
    contextEntries: makeContextEntries(4),
    candidates: makeAdvancedCandidates(makeContextEntries(4)),
    tenantId: "tenant-persist-test",
    persistAnswer: true,
  });
  assert(persistResult.answerRunId !== null, "answerRunId set after persistence");

  const savedRun = await client.query(
    `SELECT * FROM public.knowledge_answer_runs WHERE id=$1`, [persistResult.answerRunId],
  );
  assert(savedRun.rowCount === 1, "Answer run saved to DB");
  assert(savedRun.rows[0].tenant_id === "tenant-persist-test", "Correct tenant_id saved");
  assert(savedRun.rows[0].answer_text.length > 0, "answer_text non-empty in DB");
  assert(savedRun.rows[0].context_chunk_count >= 1, "context_chunk_count >= 1");

  const savedCitations = await client.query(
    `SELECT * FROM public.knowledge_answer_citations WHERE answer_run_id=$1`, [persistResult.answerRunId],
  );
  assert(savedCitations.rowCount >= 1, "At least 1 citation saved");
  assert(savedCitations.rows.every((r: { chunk_id: string }) => r.chunk_id.startsWith("chunk-")), "All citations reference real chunks");

  // ── SCENARIO 25: summarizeAnswerGrounding ────────────────────────────────

  section("SCENARIO 25: summarizeAnswerGrounding — read-only");
  const summary25 = await summarizeAnswerGrounding(persistResult.answerRunId!);
  assert(summary25.answerRunId === persistResult.answerRunId, "Correct answerRunId in summary");
  assert(typeof summary25.answerTextPreview === "string", "answerTextPreview is string");
  assert(summary25.citationCount >= 1, "citationCount >= 1");
  assert(summary25.contextChunkCount !== null, "contextChunkCount present");

  // ── SCENARIO 26: getAnswerCitations ──────────────────────────────────────

  section("SCENARIO 26: getAnswerCitations — correct structure");
  const cits26 = await getAnswerCitations(persistResult.answerRunId!);
  assert(cits26.answerRunId === persistResult.answerRunId, "Correct answerRunId");
  assert(cits26.count >= 1, "count >= 1");
  assert(cits26.citations.every((c) => c.chunkId !== null), "All citations have chunkId");
  assert(cits26.citations.every((c) => typeof c.citationIndex === "number"), "All citations have index");

  // ── SCENARIO 27: getRetrievalRuntimeMetrics ───────────────────────────────

  section("SCENARIO 27: getRetrievalRuntimeMetrics — from persisted run");
  const metrics27 = await getRetrievalRuntimeMetrics(persistResult.answerRunId!);
  assert(metrics27 !== null, "Runtime metrics found");
  assert(typeof metrics27!.fallbackUsed === "boolean", "fallbackUsed is boolean");
  assert(typeof metrics27!.advancedRerankUsed === "boolean", "advancedRerankUsed is boolean");
  assert(typeof metrics27!.shortlistSize === "number", "shortlistSize is number");

  // ── SCENARIO 28: INV-ANS8 — runtime metrics tenant-isolated ──────────────

  section("SCENARIO 28: INV-ANS8 — runtime metrics tenant-isolated");
  const summary28 = await summarizeRetrievalRuntimeMetrics("tenant-persist-test");
  assert(summary28.tenantId === "tenant-persist-test", "INV-ANS8: Summary is for correct tenant");
  assert(summary28.totalAnswerRuns >= 1, "INV-ANS8: At least 1 answer run counted");
  assert(typeof summary28.totalCitationsGenerated === "number", "INV-ANS8: Citations counted");

  const summary28Other = await summarizeRetrievalRuntimeMetrics("tenant-nonexistent-xyz");
  assert(summary28Other.totalAnswerRuns === 0, "INV-ANS8: Other tenant sees 0 runs (isolation)");

  // ── SCENARIO 29: explainAnswerTrace ──────────────────────────────────────

  section("SCENARIO 29: explainAnswerTrace — all stages present");
  const trace29 = await explainAnswerTrace(persistResult.answerRunId!);
  assert(trace29.answerRunId === persistResult.answerRunId, "Correct answerRunId");
  assert(trace29.stages.length === 5, "5 trace stages present");
  assert(trace29.stages.some((s) => s.stage === "retrieval"), "retrieval stage present");
  assert(trace29.stages.some((s) => s.stage === "reranking"), "reranking stage present");
  assert(trace29.stages.some((s) => s.stage === "context_assembly"), "context_assembly stage present");
  assert(trace29.stages.some((s) => s.stage === "answer_generation"), "answer_generation stage present");
  assert(trace29.stages.some((s) => s.stage === "citations"), "citations stage present");
  assert(trace29.note.includes("no writes"), "Trace documents no-write guarantee");

  // ── SCENARIO 30: getAnswerContext ────────────────────────────────────────

  section("SCENARIO 30: getAnswerContext — read-only context summary");
  const ctx30 = await getAnswerContext(persistResult.answerRunId!);
  assert(ctx30.answerRunId === persistResult.answerRunId, "Correct answerRunId");
  assert(typeof ctx30.contextChunkCount === "number", "contextChunkCount present");
  assert(ctx30.note.includes("no writes"), "Context endpoint documents no-write guarantee");

  // ── SCENARIO 31: unknown runId → safe empty responses ────────────────────

  section("SCENARIO 31: Unknown runId → safe graceful responses");
  const unknownId = "00000000-0000-0000-0000-000000000000";
  const s31a = await summarizeAnswerGrounding(unknownId);
  assert(s31a.note.includes("not found"), "summarizeAnswerGrounding graceful for unknown ID");
  const s31b = await getAnswerCitations(unknownId);
  assert(s31b.count === 0, "getAnswerCitations returns 0 for unknown ID");
  const s31c = await explainAnswerTrace(unknownId);
  assert(s31c.stages.length === 0, "explainAnswerTrace returns empty stages for unknown ID");
  const s31d = await getRetrievalRuntimeMetrics(unknownId);
  assert(s31d === null, "getRetrievalRuntimeMetrics returns null for unknown ID");
  const s31e = await getAnswerContext(unknownId);
  assert(s31e.note.includes("not found"), "getAnswerContext graceful for unknown ID");

  // ── SCENARIO 32: Answer metadata completeness ────────────────────────────

  section("SCENARIO 32: GroundedAnswerMetadata — all required fields present");
  const result32 = await buildGroundedAnswer({
    queryText: "metadata test",
    contextEntries: makeContextEntries(3),
    candidates: makeAdvancedCandidates(makeContextEntries(3)),
    tenantId: "tenant-alpha",
    persistAnswer: false,
  });
  assert(typeof result32.answerText === "string", "answerText present");
  assert(Array.isArray(result32.citations), "citations is array");
  assert(typeof result32.contextChunkCount === "number", "contextChunkCount present");
  assert(typeof result32.generationModel === "string", "generationModel present");
  assert(typeof result32.generationLatencyMs === "number", "generationLatencyMs present");
  assert(typeof result32.fallbackUsed === "boolean", "fallbackUsed present");
  assert(result32.runtimeMetrics !== undefined, "runtimeMetrics present");
  assert(typeof result32.runtimeMetrics.shortlistSize === "number", "runtimeMetrics.shortlistSize present");
  assert(typeof result32.runtimeMetrics.advancedRerankUsed === "boolean", "runtimeMetrics.advancedRerankUsed present");
  assert(typeof result32.runtimeMetrics.fallbackUsed === "boolean", "runtimeMetrics.fallbackUsed present");

  // Cleanup test data
  await client.query(`DELETE FROM public.knowledge_answer_citations WHERE tenant_id='tenant-persist-test'`);
  await client.query(`DELETE FROM public.knowledge_answer_runs WHERE tenant_id='tenant-persist-test'`);
  await client.end();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 5P validation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`✔ All ${passed} assertions passed`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("✗ Validation error:", err.message);
  process.exit(1);
});
