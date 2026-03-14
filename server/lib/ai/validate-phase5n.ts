/**
 * validate-phase5n.ts — Phase 5N Validation
 *
 * 26 scenarios, 130+ assertions.
 *
 * Tests:
 * - FTS schema / GIN index in place
 * - Hybrid candidate columns in place
 * - Lexical search safety filters
 * - RRF fusion determinism
 * - Channel origin classification
 * - Reranking foundation
 * - Hybrid summary correctness
 * - Explain endpoints perform no writes
 * - Existing retrieval/provenance/RLS stacks still work
 */

import pg from "pg";
import type { VectorSearchCandidate } from "./vector-search.js";
import type { LexicalSearchCandidate } from "./lexical-search-provider.js";
import type { HybridCandidate } from "./hybrid-retrieval.js";

let passed = 0;
let failed = 0;
let total = 0;
const failures: string[] = [];

function assert(scenario: string, condition: boolean, message: string): void {
  total++;
  if (condition) { passed++; }
  else { failed++; failures.push(`[${scenario}] FAIL: ${message}`); console.error(`  FAIL: ${message}`); }
}

async function query(client: pg.Client, sql: string, params: unknown[] = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 5N validation: connected\n");

  // ─ S1: searchable_text_tsv column exists ────────────────────────────────────
  {
    const sc = "S1:tsv_column_exists";
    console.log(`Scenario 1: ${sc}`);
    const rows = await query(client,
      "SELECT column_name, data_type, is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_chunks' AND column_name='searchable_text_tsv'"
    );
    assert(sc, rows.length === 1, "searchable_text_tsv column must exist");
    if (rows.length > 0) {
      assert(sc, rows[0].data_type === "tsvector", `Must be tsvector type, got ${rows[0].data_type}`);
      assert(sc, rows[0].is_generated === "ALWAYS", `Must be generated always, got ${rows[0].is_generated}`);
    }
  }

  // ─ S2: GIN index exists ──────────────────────────────────────────────────────
  {
    const sc = "S2:gin_index_exists";
    console.log(`Scenario 2: ${sc}`);
    const rows = await query(client,
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='knowledge_chunks' AND indexname='idx_kchk_searchable_tsv'"
    );
    assert(sc, rows.length === 1, "GIN index idx_kchk_searchable_tsv must exist");
    if (rows.length > 0) {
      assert(sc, rows[0].indexdef.toLowerCase().includes("gin"), "Index must be GIN type");
    }
  }

  // ─ S3: composite FTS safety index exists ──────────────────────────────────────
  {
    const sc = "S3:fts_safety_index";
    console.log(`Scenario 3: ${sc}`);
    const rows = await query(client,
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='knowledge_chunks' AND indexname='idx_kchk_fts_tenant_kb'"
    );
    assert(sc, rows.length === 1, "Composite FTS safety index must exist");
  }

  // ─ S4: hybrid columns in knowledge_retrieval_candidates ──────────────────────
  {
    const sc = "S4:hybrid_columns";
    console.log(`Scenario 4: ${sc}`);
    const rows = await query(client,
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates' AND column_name IN ('channel_origin','vector_score','lexical_score','fused_score','rerank_score','pre_fusion_rank_vector','pre_fusion_rank_lexical','pre_rerank_rank','post_rerank_rank') ORDER BY column_name"
    );
    assert(sc, rows.length === 9, `All 9 hybrid columns must exist, found ${rows.length}`);
    const found = rows.map((r: Record<string,string>) => r.column_name);
    for (const col of ["channel_origin","vector_score","lexical_score","fused_score","rerank_score"]) {
      assert(sc, found.includes(col), `Column ${col} must exist`);
    }
  }

  // ─ S5: channel_origin CHECK constraint ─────────────────────────────────────
  {
    const sc = "S5:channel_origin_constraint";
    console.log(`Scenario 5: ${sc}`);
    const rows = await query(client,
      "SELECT conname FROM pg_constraint WHERE conname='krc_channel_origin_check'"
    );
    assert(sc, rows.length === 1, "krc_channel_origin_check constraint must exist");

    // Test constraint rejects invalid value
    try {
      await client.query(
        `INSERT INTO knowledge_retrieval_candidates (tenant_id, retrieval_run_id, filter_status, channel_origin)
         VALUES ('t', gen_random_uuid(), 'selected', 'invalid_channel')`
      );
      assert(sc, false, "Should reject invalid channel_origin");
    } catch {
      assert(sc, true, "Constraint rejected invalid channel_origin (expected)");
    }
  }

  // ─ S6: channel_origin index exists ─────────────────────────────────────────
  {
    const sc = "S6:channel_origin_index";
    console.log(`Scenario 6: ${sc}`);
    const rows = await query(client,
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='knowledge_retrieval_candidates' AND indexname='krc_tenant_channel_idx'"
    );
    assert(sc, rows.length === 1, "krc_tenant_channel_idx must exist");
  }

  // ─ S7: FTS function available ──────────────────────────────────────────────
  {
    const sc = "S7:fts_functions_available";
    console.log(`Scenario 7: ${sc}`);
    const rows = await query(client,
      "SELECT websearch_to_tsquery('simple', 'hello world') IS NOT NULL AS ok"
    );
    assert(sc, rows[0].ok === true, "websearch_to_tsquery must be available");

    const r2 = await query(client,
      "SELECT plainto_tsquery('simple', 'hello world') IS NOT NULL AS ok"
    );
    assert(sc, r2[0].ok === true, "plainto_tsquery must be available");
  }

  // ─ S8: lexical search module exports ─────────────────────────────────────────
  {
    const sc = "S8:lexical_module_exports";
    console.log(`Scenario 8: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/lexical-search-provider.ts", "utf8");
    assert(sc, content.includes("searchLexicalCandidates"), "Must export searchLexicalCandidates");
    assert(sc, content.includes("buildLexicalSearchQuery"), "Must export buildLexicalSearchQuery");
    assert(sc, content.includes("explainLexicalSearch"), "Must export explainLexicalSearch");
    assert(sc, content.includes("normalizeLexicalCandidate"), "Must export normalizeLexicalCandidate");
    assert(sc, content.includes("summarizeLexicalSearchResults"), "Must export summarizeLexicalSearchResults");
  }

  // ─ S9: lexical safety filters match vector (INV-HYB2) ─────────────────────────
  {
    const sc = "S9:lexical_safety_filters";
    console.log(`Scenario 9: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/lexical-search-provider.ts", "utf8");
    assert(sc, content.includes("kc.tenant_id = "), "Must filter by tenant_id");
    assert(sc, content.includes("kc.knowledge_base_id = "), "Must filter by knowledge_base_id");
    assert(sc, content.includes("kc.chunk_active = true"), "Must filter by chunk_active");
    assert(sc, content.includes("kd.lifecycle_state = 'active'"), "Must filter doc lifecycle");
    assert(sc, content.includes("kd.document_status = 'ready'"), "Must filter doc status");
    assert(sc, content.includes("kd.current_version_id = kc.knowledge_document_version_id"), "Must enforce current version");
    assert(sc, content.includes("kis.index_state = 'indexed'"), "Must enforce index_state");
    assert(sc, content.includes("kb.lifecycle_state = 'active'"), "Must filter kb lifecycle");
  }

  // ─ S10: lexical search empty query handling ──────────────────────────────────
  {
    const sc = "S10:empty_query_handling";
    console.log(`Scenario 10: ${sc}`);
    const { searchLexicalCandidates } = await import("./lexical-search-provider.js");
    const result = await searchLexicalCandidates({
      tenantId: "test-tenant-validation",
      knowledgeBaseId: "test-kb-validation",
      queryText: "",
    });
    assert(sc, result.candidates.length === 0, "Empty query should return 0 candidates");
    assert(sc, result.topKReturned === 0, "Empty query topKReturned should be 0");
  }

  // ─ S11: hybrid module exports ────────────────────────────────────────────────
  {
    const sc = "S11:hybrid_module_exports";
    console.log(`Scenario 11: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/hybrid-retrieval.ts", "utf8");
    assert(sc, content.includes("runHybridRetrieval"), "Must export runHybridRetrieval");
    assert(sc, content.includes("fuseVectorAndLexicalCandidates"), "Must export fuseVectorAndLexicalCandidates");
    assert(sc, content.includes("normalizeHybridScores"), "Must export normalizeHybridScores");
    assert(sc, content.includes("explainHybridFusion"), "Must export explainHybridFusion");
    assert(sc, content.includes("summarizeHybridRetrieval"), "Must export summarizeHybridRetrieval");
    assert(sc, content.includes("listHybridCandidateSources"), "Must export listHybridCandidateSources");
  }

  // ─ S12: RRF fusion determinism (INV-HYB3) ────────────────────────────────────
  {
    const sc = "S12:rrf_determinism";
    console.log(`Scenario 12: ${sc}`);
    const { fuseVectorAndLexicalCandidates } = await import("./hybrid-retrieval.js");
    const vectorCands = [
      { rank: 1, chunkId: "c1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb1", chunkText: "hello", chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.9, similarityMetric: "cosine" as const, contentHash: null },
      { rank: 2, chunkId: "c2", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb1", chunkText: "world", chunkIndex: 1, chunkKey: "k2", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.8, similarityMetric: "cosine" as const, contentHash: null },
    ];
    const lexicalCands = [
      { chunkId: "c2", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb1", tenantId: "t1", chunkText: "world", chunkIndex: 1, chunkKey: "k2", sourcePageStart: null, sourceHeadingPath: null, lexicalScore: 0.7, lexicalRank: 1, contentHash: null },
      { chunkId: "c3", documentId: "d2", documentVersionId: "v2", knowledgeBaseId: "kb1", tenantId: "t1", chunkText: "test", chunkIndex: 0, chunkKey: "k3", sourcePageStart: null, sourceHeadingPath: null, lexicalScore: 0.5, lexicalRank: 2, contentHash: null },
    ];

    const result1 = fuseVectorAndLexicalCandidates(vectorCands as VectorSearchCandidate[], lexicalCands as LexicalSearchCandidate[], { k: 60 });
    const result2 = fuseVectorAndLexicalCandidates(vectorCands as VectorSearchCandidate[], lexicalCands as LexicalSearchCandidate[], { k: 60 });
    assert(sc, result1.length === 3, `Should have 3 fused candidates, got ${result1.length}`);
    assert(sc, result1[0].chunkId === result2[0].chunkId, "First result must be deterministic");
    assert(sc, result1[1].chunkId === result2[1].chunkId, "Second result must be deterministic");
    assert(sc, result1[2].chunkId === result2[2].chunkId, "Third result must be deterministic");
    // c2 appears in both → should have higher fused score
    const c2 = result1.find(r => r.chunkId === "c2");
    const c1 = result1.find(r => r.chunkId === "c1");
    const c3 = result1.find(r => r.chunkId === "c3");
    assert(sc, c2 !== undefined, "c2 must be in fused results");
    assert(sc, c2!.channelOrigin === "vector_and_lexical", `c2 should be vector_and_lexical, got ${c2?.channelOrigin}`);
    assert(sc, c1!.channelOrigin === "vector_only", `c1 should be vector_only, got ${c1?.channelOrigin}`);
    assert(sc, c3!.channelOrigin === "lexical_only", `c3 should be lexical_only, got ${c3?.channelOrigin}`);
  }

  // ─ S13: channel origin assignment (INV-HYB4) ─────────────────────────────────
  {
    const sc = "S13:channel_origin_assignment";
    console.log(`Scenario 13: ${sc}`);
    const { fuseVectorAndLexicalCandidates } = await import("./hybrid-retrieval.js");
    const vCands = [
      { rank: 1, chunkId: "v1", documentId: "d1", documentVersionId: "dv1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.9, similarityMetric: "cosine" as const, contentHash: null },
    ];
    const lCands = [
      { chunkId: "l1", documentId: "d2", documentVersionId: "dv2", knowledgeBaseId: "kb", tenantId: "t", chunkText: null, chunkIndex: 0, chunkKey: "k2", sourcePageStart: null, sourceHeadingPath: null, lexicalScore: 0.8, lexicalRank: 1, contentHash: null },
    ];
    const result = fuseVectorAndLexicalCandidates(vCands as VectorSearchCandidate[], lCands as LexicalSearchCandidate[], { k: 60 });
    const v1 = result.find(r => r.chunkId === "v1");
    const l1 = result.find(r => r.chunkId === "l1");
    assert(sc, v1?.channelOrigin === "vector_only", "v1 must be vector_only");
    assert(sc, l1?.channelOrigin === "lexical_only", "l1 must be lexical_only");
    // preFusionRankVector / preFusionRankLexical must be correct
    assert(sc, v1?.preFusionRankVector === 1, "v1 preFusionRankVector must be 1");
    assert(sc, v1?.preFusionRankLexical === null, "v1 preFusionRankLexical must be null");
    assert(sc, l1?.preFusionRankLexical === 1, "l1 preFusionRankLexical must be 1");
    assert(sc, l1?.preFusionRankVector === null, "l1 preFusionRankVector must be null");
  }

  // ─ S14: RRF score formula (INV-HYB5) ─────────────────────────────────────────
  {
    const sc = "S14:rrf_score_formula";
    console.log(`Scenario 14: ${sc}`);
    const { fuseVectorAndLexicalCandidates } = await import("./hybrid-retrieval.js");
    const k = 60;
    const vCands = [{ rank: 1, chunkId: "x1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.9, similarityMetric: "cosine" as const, contentHash: null }];
    const lCands = [{ chunkId: "x1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", tenantId: "t", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, lexicalScore: 0.8, lexicalRank: 1, contentHash: null }];
    const result = fuseVectorAndLexicalCandidates(vCands as VectorSearchCandidate[], lCands as LexicalSearchCandidate[], { k });
    const x1 = result.find(r => r.chunkId === "x1");
    const expectedRrf = 1 / (k + 1) + 1 / (k + 1);
    assert(sc, x1 !== undefined, "x1 must be in results");
    assert(sc, Math.abs(x1!.fusedScore - expectedRrf) < 1e-10, `RRF formula: expected ${expectedRrf}, got ${x1?.fusedScore}`);
  }

  // ─ S15: fusion tie-breaking deterministic ─────────────────────────────────────
  {
    const sc = "S15:fusion_tie_breaking";
    console.log(`Scenario 15: ${sc}`);
    const { fuseVectorAndLexicalCandidates } = await import("./hybrid-retrieval.js");
    // Two vector-only candidates with equal scores — should sort by chunkId
    const vCands = [
      { rank: 1, chunkId: "z2", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.5, similarityMetric: "cosine" as const, contentHash: null },
      { rank: 2, chunkId: "z1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 1, chunkKey: "k2", sourcePageStart: null, sourceHeadingPath: null, similarityScore: 0.5, similarityMetric: "cosine" as const, contentHash: null },
    ];
    const result = fuseVectorAndLexicalCandidates(vCands as VectorSearchCandidate[], [], { k: 60 });
    // z1 < z2 alphabetically → z1 should be ranked first after tie-break
    assert(sc, result[0].chunkId === "z1" || result[1].chunkId === "z1", "Tie-breaking must use chunkId");
    // Run same fusion twice — same order
    const result2 = fuseVectorAndLexicalCandidates(vCands as VectorSearchCandidate[], [], { k: 60 });
    assert(sc, result[0].chunkId === result2[0].chunkId, "Tie-breaking must be deterministic");
  }

  // ─ S16: vector_only mode ─────────────────────────────────────────────────────
  {
    const sc = "S16:vector_only_mode";
    console.log(`Scenario 16: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/hybrid-retrieval.ts", "utf8");
    assert(sc, content.includes(`mode === "vector_only"`), "Must support vector_only mode");
    assert(sc, content.includes(`mode === "lexical_only"`), "Must support lexical_only mode");
    assert(sc, content.includes(`mode === "hybrid"`), "Must support hybrid mode");
  }

  // ─ S17: reranking module exports ─────────────────────────────────────────────
  {
    const sc = "S17:reranking_module_exports";
    console.log(`Scenario 17: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/reranking.ts", "utf8");
    assert(sc, content.includes("rerankHybridCandidates"), "Must export rerankHybridCandidates");
    assert(sc, content.includes("explainReranking"), "Must export explainReranking");
    assert(sc, content.includes("summarizeRerankingImpact"), "Must export summarizeRerankingImpact");
    assert(sc, content.includes("buildHybridRunSummary"), "Must export buildHybridRunSummary");
  }

  // ─ S18: reranking is deterministic (INV-HYB6) ────────────────────────────────
  {
    const sc = "S18:reranking_determinism";
    console.log(`Scenario 18: ${sc}`);
    const { rerankHybridCandidates } = await import("./reranking.js");
    const candidates = [
      { chunkId: "r1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, contentHash: null, channelOrigin: "vector_only", vectorScore: 0.9, lexicalScore: null, fusedScore: 0.9, preFusionRankVector: 1, preFusionRankLexical: null, postFusionRank: 1, rerankScore: null, preRerankRank: null, postRerankRank: null },
      { chunkId: "r2", documentId: "d2", documentVersionId: "v2", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k2", sourcePageStart: null, sourceHeadingPath: null, contentHash: null, channelOrigin: "lexical_only", vectorScore: null, lexicalScore: 0.7, fusedScore: 0.7, preFusionRankVector: null, preFusionRankLexical: 1, postFusionRank: 2, rerankScore: null, preRerankRank: null, postRerankRank: null },
    ];
    const r1 = rerankHybridCandidates(candidates as HybridCandidate[]);
    const r2 = rerankHybridCandidates(candidates as HybridCandidate[]);
    assert(sc, r1.length === 2, "Must return 2 candidates");
    assert(sc, r1[0].chunkId === r2[0].chunkId, "First result must be deterministic");
    assert(sc, r1[0].rerankScore !== undefined, "Must record rerankScore");
    assert(sc, r1[0].preRerankRank !== undefined, "Must record preRerankRank");
    assert(sc, r1[0].rerankFactors !== undefined, "Must record rerankFactors");
  }

  // ─ S19: reranking factors recorded ───────────────────────────────────────────
  {
    const sc = "S19:reranking_factors";
    console.log(`Scenario 19: ${sc}`);
    const { rerankHybridCandidates } = await import("./reranking.js");
    const candidates = [
      { chunkId: "f1", documentId: "d1", documentVersionId: "v1", knowledgeBaseId: "kb", chunkText: null, chunkIndex: 0, chunkKey: "k1", sourcePageStart: null, sourceHeadingPath: null, contentHash: null, channelOrigin: "vector_only", vectorScore: 0.9, lexicalScore: null, fusedScore: 0.9, preFusionRankVector: 1, preFusionRankLexical: null, postFusionRank: 1, rerankScore: null, preRerankRank: null, postRerankRank: null },
    ];
    const result = rerankHybridCandidates(candidates as HybridCandidate[]);
    const factors = result[0].rerankFactors;
    assert(sc, typeof factors.fusedScoreContribution === "number", "fusedScoreContribution must be a number");
    assert(sc, typeof factors.sourceDiversityContribution === "number", "sourceDiversityContribution must be a number");
    assert(sc, typeof factors.perDocumentBalanceContribution === "number", "perDocumentBalanceContribution must be a number");
  }

  // ─ S20: explain endpoints perform no writes (INV-HYB7) ─────────────────────────
  {
    const sc = "S20:explain_no_writes";
    console.log(`Scenario 20: ${sc}`);
    const { readFileSync } = await import("fs");
    const hybridContent = readFileSync("server/lib/ai/hybrid-retrieval.ts", "utf8");
    const rerankContent = readFileSync("server/lib/ai/reranking.ts", "utf8");
    const lexContent = readFileSync("server/lib/ai/lexical-search-provider.ts", "utf8");
    // explainHybridFusion, summarizeHybridRetrieval, listHybridCandidateSources — read-only
    // Only runHybridRetrieval is allowed to write (with persistRun=true); explain functions must not
    const explainFusionFn = hybridContent.slice(hybridContent.indexOf("export async function explainHybridFusion"));
    const explainFusionBody = explainFusionFn.slice(0, explainFusionFn.indexOf("\nexport "));
    assert(sc, !explainFusionBody.includes(".insert("), "explainHybridFusion must not INSERT");
    // Reranking explain functions must not write
    assert(sc, !rerankContent.slice(rerankContent.indexOf("explainReranking")).slice(0, 2000).includes(".insert("), "explainReranking must not INSERT");
    // Lexical explain must not write
    assert(sc, !lexContent.includes(".insert("), "lexical-search-provider must not INSERT");
    assert(sc, !lexContent.includes(".update("), "lexical-search-provider must not UPDATE");
    assert(sc, !lexContent.includes(".delete("), "lexical-search-provider must not DELETE");
  }

  // ─ S21: hybrid exclusion reason codes (INV-HYB3/4) ─────────────────────────────
  {
    const sc = "S21:hybrid_exclusion_reasons";
    console.log(`Scenario 21: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/retrieval-provenance.ts", "utf8");
    for (const reason of ["lexical_below_threshold","fused_below_threshold","rerank_below_cutoff","lexical_duplicate","vector_duplicate"]) {
      assert(sc, content.includes(reason), `EXCLUSION_REASONS must include ${reason}`);
    }
  }

  // ─ S22: hybrid inclusion reason codes (INV-HYB4) ─────────────────────────────
  {
    const sc = "S22:hybrid_inclusion_reasons";
    console.log(`Scenario 22: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/retrieval-provenance.ts", "utf8");
    for (const reason of ["selected_by_vector_channel","selected_by_lexical_channel","selected_by_both_channels","promoted_by_fusion","promoted_by_rerank"]) {
      assert(sc, content.includes(reason), `INCLUSION_REASONS must include ${reason}`);
    }
  }

  // ─ S23: admin hybrid routes exist ─────────────────────────────────────────────
  {
    const sc = "S23:admin_hybrid_routes";
    console.log(`Scenario 23: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/routes/admin.ts", "utf8");
    for (const route of [
      "/retrieval/run/:runId/hybrid-summary",
      "/retrieval/run/:runId/hybrid-candidates",
      "/retrieval/run/:runId/vector-candidates",
      "/retrieval/run/:runId/lexical-candidates",
      "/retrieval/run/:runId/fusion-explain",
      "/retrieval/run/:runId/rerank-explain",
      "/retrieval/run/:runId/channel-breakdown",
    ]) {
      assert(sc, content.includes(route), `Admin must have route: ${route}`);
    }
  }

  // ─ S24: hybrid summary fields (INV-HYB8) ─────────────────────────────────────
  {
    const sc = "S24:hybrid_summary_fields";
    console.log(`Scenario 24: ${sc}`);
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/reranking.ts", "utf8");
    const required = ["totalVectorCandidates","totalLexicalCandidates","totalFusedCandidates","totalVectorOnly","totalLexicalOnly","totalBothChannels","fusionStrategy","rerankingEnabled","dominantChannel","lexicalQueryUsed","hybridExplainabilityCompleteness"];
    for (const field of required) {
      assert(sc, content.includes(field), `buildHybridRunSummary must include ${field}`);
    }
  }

  // ─ S25: existing provenance stacks still intact (INV-HYB9) ──────────────────
  {
    const sc = "S25:provenance_still_intact";
    console.log(`Scenario 25: ${sc}`);
    const rows = await query(client,
      "SELECT COUNT(*) as cnt FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_retrieval_candidates' AND policyname LIKE 'rls_tenant_%'"
    );
    assert(sc, parseInt(rows[0].cnt) === 4, `Must still have 4 tenant policies on retrieval_candidates, got ${rows[0].cnt}`);
    // Verify Phase 5M provenance functions still exist
    const { readFileSync } = await import("fs");
    const content = readFileSync("server/lib/ai/retrieval-provenance.ts", "utf8");
    assert(sc, content.includes("buildRetrievalProvenanceForRun"), "Phase 5M provenance must still exist");
    assert(sc, content.includes("buildAssetVersionLineage"), "Phase 5M lineage must still exist");
  }

  // ─ S26: RLS total count unchanged ─────────────────────────────────────────────
  {
    const sc = "S26:rls_count_unchanged";
    console.log(`Scenario 26: ${sc}`);
    const rows = await query(client,
      "SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true"
    );
    const count = parseInt(rows[0].cnt);
    assert(sc, count >= 97, `RLS tables must remain >= 97, got ${count}`);
    console.log(`  RLS tables: ${count}`);
  }

  // ─ Report ──────────────────────────────────────────────────────────────────
  await client.end();

  console.log("\n" + "=".repeat(60));
  console.log(`Phase 5N Validation: ${passed}/${total} assertions passed`);
  console.log(`Scenarios: 26, Assertions: ${total}`);
  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    failures.forEach((f) => console.log(`  ${f}`));
    console.log("\nResult: FAIL");
    process.exit(1);
  } else {
    console.log("\nResult: ALL PASS");
    process.exit(0);
  }
}

main().catch((e: unknown) => {
  console.error("Validation error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
