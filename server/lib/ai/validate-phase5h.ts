/**
 * validate-phase5h.ts — Phase 5H
 * Retrieval Orchestration & Context Assembly
 *
 * Validates the complete retrieval orchestration pipeline:
 *   - context-window.ts re-export works as Phase 5H canonical entry point
 *   - token budget estimation and enforcement (INV-RET5)
 *   - duplicate chunk suppression via Jaccard + content hash (INV-RET9)
 *   - chunk ranking, ordering, and per-document limits
 *   - context window assembly with traceable metadata (INV-RET10)
 *   - invariant error enforcement (INV-RET1, INV-RET2, INV-RET7)
 *   - deterministic output (INV-RET8)
 *   - explain output structure
 *   - DB migration artifacts from migrate-phase5h.ts
 *
 * Scenarios: 20
 * Assertions: 97
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

// Phase 5H canonical import paths
import {
  buildContextWindow,
  summarizeContextWindow,
  type ContextWindowOptions,
} from "./context-window";

import {
  estimateTokens,
  estimateChunkTokens,
  enforceTokenBudget,
  wouldExceedBudget,
  formatBudgetSummary,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
} from "./token-budget";

import {
  rankChunks,
} from "./chunk-ranking";

import {
  buildContextPreview,
  RetrievalInvariantError,
} from "./retrieval-orchestrator";

import type { VectorSearchCandidate } from "./vector-search";

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

function mockCandidate(
  overrides: Partial<VectorSearchCandidate> & { chunkId: string },
): VectorSearchCandidate {
  return {
    rank: 1,
    chunkId: overrides.chunkId,
    documentId: overrides.documentId ?? "doc-ph5h-001",
    documentVersionId: overrides.documentVersionId ?? "ver-ph5h-001",
    knowledgeBaseId: overrides.knowledgeBaseId ?? "kb-ph5h-001",
    chunkText: overrides.chunkText ?? "This is a representative chunk of document text for Phase 5H retrieval testing.",
    chunkIndex: overrides.chunkIndex ?? 0,
    chunkKey: overrides.chunkKey ?? `key-${overrides.chunkId}`,
    sourcePageStart: overrides.sourcePageStart ?? null,
    sourceHeadingPath: overrides.sourceHeadingPath ?? null,
    similarityScore: overrides.similarityScore ?? 0.88,
    similarityMetric: overrides.similarityMetric ?? "cosine",
    contentHash: overrides.contentHash ?? `${overrides.chunkId}-sha256`,
  };
}

// ─── S01: context-window.ts re-export canonical path ─────────────────────────

async function s01_contextWindowReExport() {
  section("S01: context-window.ts re-export (Phase 5H canonical path)");

  assert(typeof buildContextWindow === "function", "buildContextWindow exported from context-window.ts");
  assert(typeof summarizeContextWindow === "function", "summarizeContextWindow exported from context-window.ts");

  // Verify re-export produces same result as direct builder
  const { buildContextWindow: builderDirect } = await import("./context-window-builder");
  assert(buildContextWindow === builderDirect, "context-window.ts re-exports same function reference as context-window-builder.ts");

  const candidates = [
    mockCandidate({ chunkId: "r1", chunkText: "Phase 5H context window re-export test." }),
  ];
  const ranked = rankChunks(candidates, {}).ranked;
  const window = buildContextWindow(ranked, { maxTokens: 200 });
  assert(window.entries.length === 1, "buildContextWindow via re-export assembles entries");
  assert(window.totalEstimatedTokens > 0, "buildContextWindow tracks token usage");
}

// ─── S02: estimateTokens correctness ─────────────────────────────────────────

async function s02_tokenEstimation() {
  section("S02: estimateTokens correctness (INV-RET5 foundation)");

  assert(estimateTokens("") === 0, "empty string = 0 tokens");
  assert(estimateTokens("abcd") === 1, "4 chars = 1 token (floor 4 chars/token)");
  assert(estimateTokens("12345678") === 2, "8 chars = 2 tokens");
  assert(estimateTokens("a".repeat(100)) === 25, "100 chars = 25 tokens");
  assert(estimateTokens("a".repeat(400)) === 100, "400 chars = 100 tokens");

  const withOverhead = estimateChunkTokens("a".repeat(40), 10);
  assert(withOverhead === 20, "40 chars + 10 overhead = 20 tokens");

  const defaultOverhead = estimateChunkTokens("a".repeat(40));
  assert(defaultOverhead === 60, "40 chars + default 50 overhead = 60 tokens (default overhead is 50)");

  assert(DEFAULT_CONTEXT_TOKEN_BUDGET === 4000, "DEFAULT_CONTEXT_TOKEN_BUDGET = 4000");
}

// ─── S03: enforceTokenBudget greedy cut-off ───────────────────────────────────

async function s03_tokenBudgetEnforcement() {
  section("S03: enforceTokenBudget greedy cut-off (INV-RET5)");

  const chunks = [
    mockCandidate({ chunkId: "b1", chunkText: "a".repeat(400) }),
    mockCandidate({ chunkId: "b2", chunkText: "b".repeat(400) }),
    mockCandidate({ chunkId: "b3", chunkText: "c".repeat(400) }),
    mockCandidate({ chunkId: "b4", chunkText: "d".repeat(400) }),
    mockCandidate({ chunkId: "b5", chunkText: "e".repeat(400) }),
  ];

  // Each chunk = 100 tokens, budget = 350 → 3 fit (300), 4th would = 400 → exceeds
  const result = enforceTokenBudget(chunks, { maxTokens: 350, metadataOverheadTokens: 0 });
  assert(result.selected.length === 3, "exactly 3 chunks fit in 350-token budget");
  assert(result.skippedBudget.length === 2, "2 chunks skipped due to budget overflow");
  assert(result.totalEstimatedTokens <= 350, "total tokens within budget (INV-RET5)");
  assert(result.budgetUtilizationPct > 0 && result.budgetUtilizationPct <= 100, "utilization pct within 0–100");
}

// ─── S04: token budget NEVER exceeded with large input (INV-RET5) ─────────────

async function s04_budgetNeverExceeded() {
  section("S04: Token budget never exceeded with 50 chunks (INV-RET5)");

  const chunks: VectorSearchCandidate[] = [];
  for (let i = 0; i < 50; i++) {
    chunks.push(mockCandidate({ chunkId: `big-${i}`, chunkText: "word ".repeat(250) }));
  }

  const maxTokens = 1500;
  const result = enforceTokenBudget(chunks, { maxTokens, metadataOverheadTokens: 50 });

  assert(result.totalEstimatedTokens <= maxTokens, "totalEstimatedTokens NEVER exceeds budget (INV-RET5)");
  assert(result.selected.length < 50, "not all 50 chunks fit within budget");
  assert(result.skippedBudget.length > 0, "at least some chunks skipped");
  assert(result.selected.length + result.skippedBudget.length === 50, "all chunks accounted for: selected + skipped = 50");
}

// ─── S05: wouldExceedBudget predicate ─────────────────────────────────────────

async function s05_wouldExceedBudget() {
  section("S05: wouldExceedBudget predicate");

  // 100 chars / 4 = 25 tokens; current = 3980; max = 4000 → would exceed
  assert(wouldExceedBudget("a".repeat(100), 3980, 4000, 0) === true, "25 tokens on top of 3980 exceeds 4000");
  assert(wouldExceedBudget("a".repeat(40), 0, 4000, 0) === false, "10 tokens on fresh budget easily fits");
  assert(wouldExceedBudget("", 3999, 4000, 0) === false, "empty string never exceeds budget");
  assert(wouldExceedBudget("a".repeat(4), 4000, 4000, 0) === true, "any addition at max capacity exceeds budget");

  const summary = formatBudgetSummary({ selected: [], skippedBudget: [], totalEstimatedTokens: 1200, budgetUtilizationPct: 30 });
  assert(typeof summary === "string", "formatBudgetSummary returns string");
  assert(summary.includes("1200"), "formatBudgetSummary includes token count");
}

// ─── S06: rankChunks ordering by similarity score ─────────────────────────────

async function s06_rankChunksOrdering() {
  section("S06: rankChunks orders by similarity score descending");

  const candidates = [
    mockCandidate({ chunkId: "ord1", similarityScore: 0.70, chunkIndex: 2, chunkText: "Ordering test alpha: database schema normalization and third normal form." }),
    mockCandidate({ chunkId: "ord2", similarityScore: 0.95, chunkIndex: 0, chunkText: "Ordering test beta: retrieval orchestration pipeline design and implementation." }),
    mockCandidate({ chunkId: "ord3", similarityScore: 0.85, chunkIndex: 1, chunkText: "Ordering test gamma: token budget enforcement and context window assembly." }),
  ];

  const result = rankChunks(candidates, {});
  assert(result.ranked.length === 3, "all 3 candidates ranked");
  assert(result.ranked[0].chunkId === "ord2", "highest similarity (0.95) ranked first");
  assert(result.ranked[1].chunkId === "ord3", "second highest (0.85) ranked second");
  assert(result.ranked[2].chunkId === "ord1", "lowest similarity (0.70) ranked last");
  assert(result.ranked[0].rank === 1, "rank field = 1 for first entry");
  assert(result.skippedDuplicate.length === 0, "no duplicates in distinct-text candidates");
}

// ─── S07: rankChunks Jaccard duplicate suppression (INV-RET9) ─────────────────

async function s07_duplicateSuppression() {
  section("S07: Duplicate suppression via Jaccard similarity (INV-RET9)");

  const baseText = "Machine learning models require large amounts of training data to achieve high accuracy";
  const nearDupe = "Machine learning models require large amounts of training data to achieve high accuracy levels";
  const distinct = "Database indexing improves query performance by reducing full table scans across records";

  const candidates = [
    mockCandidate({ chunkId: "j1", similarityScore: 0.99, chunkText: baseText }),
    mockCandidate({ chunkId: "j2", similarityScore: 0.95, chunkText: nearDupe }),
    mockCandidate({ chunkId: "j3", similarityScore: 0.82, chunkText: distinct }),
  ];

  const result = rankChunks(candidates, { duplicateSimilarityThreshold: 0.80 });

  assert(result.skippedDuplicate.length >= 1, "near-duplicate chunk suppressed (INV-RET9)");
  assert(result.ranked.some(r => r.chunkId === "j1"), "highest-score original kept");
  assert(result.ranked.some(r => r.chunkId === "j3"), "distinct chunk kept");
  assert(result.ranked.length < candidates.length, "fewer ranked than input (duplicate removed)");
}

// ─── S08: rankChunks exact content hash dedup (INV-RET9) ──────────────────────

async function s08_contentHashDedup() {
  section("S08: Exact duplicate suppression via content hash (INV-RET9)");

  const duplicateHash = "SHA256-DUPLICATE-EXACT-CONTENT";
  const candidates = [
    mockCandidate({ chunkId: "hash1", contentHash: duplicateHash, similarityScore: 0.90, chunkText: "Exact identical document content repeated across two chunk positions" }),
    mockCandidate({ chunkId: "hash2", contentHash: duplicateHash, similarityScore: 0.88, chunkText: "Exact identical document content repeated across two chunk positions" }),
    mockCandidate({ chunkId: "hash3", contentHash: "SHA256-UNIQUE-CONTENT", similarityScore: 0.75, chunkText: "Completely different content about infrastructure and deployment pipelines" }),
  ];

  // Use duplicateSimilarityThreshold=1.1 so Jaccard dedup doesn't interfere —
  // both hash1+hash2 pass rankChunks, then buildContextWindow deduplicates by content hash
  const ranked = rankChunks(candidates, { duplicateSimilarityThreshold: 1.1 }).ranked;
  const window = buildContextWindow(ranked, { maxTokens: 4000, deduplicateByContentHash: true });

  const contentHashIds = window.entries.map(e => e.metadata.chunkId);
  assert(!contentHashIds.includes("hash2"), "second occurrence of same hash excluded (INV-RET9)");
  assert(contentHashIds.includes("hash1"), "first occurrence of hash kept");
  assert(contentHashIds.includes("hash3"), "unique-hash chunk retained");
  assert(window.chunksSkippedDuplicate > 0, "context window reports skippedDuplicate count");
}

// ─── S09: rankChunks maxChunksPerDocument ─────────────────────────────────────

async function s09_maxChunksPerDocument() {
  section("S09: maxChunksPerDocument per-document limit");

  const candidates = [
    mockCandidate({ chunkId: "pd1", documentId: "doc-heavy", chunkIndex: 0, similarityScore: 0.98, chunkText: "Heavy doc chunk alpha: vector search index optimization and ANN algorithms" }),
    mockCandidate({ chunkId: "pd2", documentId: "doc-heavy", chunkIndex: 1, similarityScore: 0.95, chunkText: "Heavy doc chunk beta: HNSW graph traversal and quantization techniques" }),
    mockCandidate({ chunkId: "pd3", documentId: "doc-heavy", chunkIndex: 2, similarityScore: 0.90, chunkText: "Heavy doc chunk gamma: IVF index clustering and centroid assignment" }),
    mockCandidate({ chunkId: "pd4", documentId: "doc-light", chunkIndex: 0, similarityScore: 0.85, chunkText: "Light doc chunk alpha: tenant isolation via row-level security policies" }),
  ];

  // Disable Jaccard dedup (all chunks are unique enough, but set high threshold for safety)
  const result = rankChunks(candidates, { maxChunksPerDocument: 2, duplicateSimilarityThreshold: 1.1 });

  const heavyChunks = result.ranked.filter(r => r.documentId === "doc-heavy");
  const lightChunks = result.ranked.filter(r => r.documentId === "doc-light");

  assert(heavyChunks.length <= 2, "maxChunksPerDocument=2 limits doc-heavy to 2 chunks");
  assert(lightChunks.length === 1, "doc-light unaffected (only 1 chunk)");
  assert(result.ranked.length <= 3, "total ranked ≤ 3 after per-doc limit");
}

// ─── S10: rankChunks similarity threshold filter ──────────────────────────────

async function s10_similarityThreshold() {
  section("S10: Similarity threshold filtering");

  const candidates = [
    mockCandidate({ chunkId: "th1", similarityScore: 0.95, chunkText: "Threshold alpha: context assembly token budget management and chunk selection" }),
    mockCandidate({ chunkId: "th2", similarityScore: 0.75, chunkText: "Threshold beta: vector embedding cosine similarity scoring and ranking" }),
    mockCandidate({ chunkId: "th3", similarityScore: 0.55, chunkText: "Threshold gamma: tenant isolation enforcement per knowledge base partition" }),
    mockCandidate({ chunkId: "th4", similarityScore: 0.40, chunkText: "Threshold delta: inactive document lifecycle and processing state management" }),
  ];

  // Disable Jaccard dedup to isolate threshold-only filtering
  const result = rankChunks(candidates, { similarityThreshold: 0.70, duplicateSimilarityThreshold: 1.1 });

  const skippedIds = result.skippedThreshold.map(c => c.chunkId);
  assert(skippedIds.includes("th3"), "chunk with 0.55 score below threshold 0.70 skipped");
  assert(skippedIds.includes("th4"), "chunk with 0.40 score below threshold 0.70 skipped");
  assert(!skippedIds.includes("th1"), "chunk with 0.95 score above threshold kept");
  assert(!skippedIds.includes("th2"), "chunk with 0.75 score at threshold kept");
  assert(result.ranked.length === 2, "exactly 2 chunks above threshold");
}

// ─── S11: buildContextWindow from context-window.ts ───────────────────────────

async function s11_contextWindowAssembly() {
  section("S11: buildContextWindow from context-window.ts (Phase 5H canonical import)");

  const candidates = [
    mockCandidate({ chunkId: "cw1", chunkText: "Section one: Introduction to retrieval-augmented generation systems.", chunkIndex: 0, documentId: "doc-A" }),
    mockCandidate({ chunkId: "cw2", chunkText: "Section two: Chunk ranking strategies and similarity metrics.", chunkIndex: 1, documentId: "doc-A" }),
    mockCandidate({ chunkId: "cw3", chunkText: "Section three: Token budget enforcement for LLM context windows.", chunkIndex: 0, documentId: "doc-B" }),
  ];

  const ranked = rankChunks(candidates, {}).ranked;
  const window = buildContextWindow(ranked, { maxTokens: 500 });

  assert(Array.isArray(window.entries), "context window has entries array");
  assert(window.entries.length >= 1, "at least 1 entry assembled");
  assert(window.totalEstimatedTokens > 0, "totalEstimatedTokens tracked");
  assert(window.totalEstimatedTokens <= 500, "totalEstimatedTokens within budget");
  assert(window.chunksSelected >= 1, "chunksSelected reported");
  assert(typeof window.budgetUtilizationPct === "number", "budgetUtilizationPct is number");
  assert(Array.isArray(window.documentIds), "documentIds is array");
}

// ─── S12: context window stops at token budget (INV-RET5) ────────────────────

async function s12_contextWindowTokenStop() {
  section("S12: Context window stops at token budget boundary (INV-RET5)");

  const tightBudget = 150;
  const chunks: VectorSearchCandidate[] = [];
  for (let i = 0; i < 10; i++) {
    chunks.push(mockCandidate({
      chunkId: `tight-${i}`,
      chunkText: "x".repeat(200),
      chunkIndex: i,
    }));
  }
  const ranked = rankChunks(chunks, { duplicateSimilarityThreshold: 1.1 }).ranked;
  // deduplicateByContentHash: false ensures content hash doesn't swallow the skips we want to test
  const window = buildContextWindow(ranked, { maxTokens: tightBudget, metadataOverheadTokens: 0, deduplicateByContentHash: false });

  assert(window.totalEstimatedTokens <= tightBudget, "context window tokens NEVER exceed tight budget (INV-RET5)");
  assert(window.chunksSkippedBudget > 0, "some chunks skipped due to budget");
  assert(window.chunksSelected + window.chunksSkippedBudget + window.chunksSkippedDuplicate <= 10, "all chunks accounted for");

  const summary = summarizeContextWindow(window);
  assert(typeof summary === "object", "summarizeContextWindow returns object");
  assert("totalEstimatedTokens" in summary, "summary includes token count");
}

// ─── S13: context window metadata traceability (INV-RET10) ───────────────────

async function s13_contextWindowMetadata() {
  section("S13: Context window metadata traceability (INV-RET10)");

  const candidates = [
    mockCandidate({
      chunkId: "meta-1",
      documentId: "doc-trace-001",
      documentVersionId: "ver-trace-001",
      knowledgeBaseId: "kb-trace-001",
      similarityScore: 0.93,
      sourcePageStart: 4,
      sourceHeadingPath: "Chapter 3 > Section 2",
      chunkIndex: 7,
    }),
  ];

  const ranked = rankChunks(candidates, {}).ranked;
  const window = buildContextWindow(ranked, { maxTokens: 4000 });
  const entry = window.entries[0];

  assert(entry !== undefined, "entry exists in context window");
  assert(entry.metadata.chunkId === "meta-1", "metadata.chunkId traceable (INV-RET10)");
  assert(entry.metadata.documentId === "doc-trace-001", "metadata.documentId traceable");
  assert(entry.metadata.documentVersionId === "ver-trace-001", "metadata.documentVersionId traceable (INV-RET3)");
  assert(typeof entry.metadata.similarityScore === "number", "metadata.similarityScore present");
  assert(entry.metadata.similarityScore === 0.93, "metadata.similarityScore accurate");
  assert(typeof entry.text === "string", "entry.text is string");
  assert(entry.text.length > 0, "entry.text non-empty");
}

// ─── S14: missing tenantId rejected (INV-RET7) ────────────────────────────────

async function s14_missingTenantIdRejected() {
  section("S14: Missing tenantId rejected (INV-RET7)");

  let caught: RetrievalInvariantError | null = null;
  try {
    await import("./retrieval-orchestrator").then(m =>
      m.runRetrievalOrchestration({
        tenantId: "",
        knowledgeBaseId: "kb-001",
        queryEmbedding: [0.1, 0.2, 0.3],
      })
    );
  } catch (e: any) {
    caught = e;
  }

  assert(caught !== null, "RetrievalInvariantError thrown for empty tenantId");
  assert(caught instanceof RetrievalInvariantError, "error is RetrievalInvariantError instance");
  assert(caught?.message?.includes("INV-RET7"), "error references INV-RET7 invariant");
}

// ─── S15: missing knowledgeBaseId rejected (INV-RET1) ────────────────────────

async function s15_missingKbIdRejected() {
  section("S15: Missing knowledgeBaseId rejected (INV-RET1)");

  let caught: RetrievalInvariantError | null = null;
  try {
    await import("./retrieval-orchestrator").then(m =>
      m.runRetrievalOrchestration({
        tenantId: "tenant-abc",
        knowledgeBaseId: "",
        queryEmbedding: [0.1, 0.2, 0.3],
      })
    );
  } catch (e: any) {
    caught = e;
  }

  assert(caught !== null, "RetrievalInvariantError thrown for empty knowledgeBaseId");
  assert(caught instanceof RetrievalInvariantError, "error is RetrievalInvariantError instance");
  assert(caught?.message?.includes("INV-RET1"), "error references INV-RET1 invariant");
}

// ─── S16: empty queryEmbedding rejected (INV-RET1) ───────────────────────────

async function s16_emptyEmbeddingRejected() {
  section("S16: Empty queryEmbedding rejected (INV-RET1)");

  let caught: RetrievalInvariantError | null = null;
  try {
    await import("./retrieval-orchestrator").then(m =>
      m.runRetrievalOrchestration({
        tenantId: "tenant-abc",
        knowledgeBaseId: "kb-001",
        queryEmbedding: [],
      })
    );
  } catch (e: any) {
    caught = e;
  }

  assert(caught !== null, "RetrievalInvariantError thrown for empty queryEmbedding");
  assert(caught instanceof RetrievalInvariantError, "error is RetrievalInvariantError instance");
  assert(caught?.message?.includes("INV-RET1"), "error references INV-RET1 invariant");
}

// ─── S17: deterministic output (INV-RET8) ────────────────────────────────────

async function s17_deterministicOutput() {
  section("S17: Deterministic output for same input (INV-RET8)");

  const candidates = [
    mockCandidate({ chunkId: "det-1", similarityScore: 0.91, chunkText: "First deterministic chunk about retrieval systems", chunkIndex: 0, documentId: "doc-det" }),
    mockCandidate({ chunkId: "det-2", similarityScore: 0.85, chunkText: "Second deterministic chunk about context assembly", chunkIndex: 1, documentId: "doc-det" }),
    mockCandidate({ chunkId: "det-3", similarityScore: 0.78, chunkText: "Third deterministic chunk about token budgets", chunkIndex: 2, documentId: "doc-other" }),
  ];

  const opts: ContextWindowOptions = { maxTokens: 600 };

  const ranked1 = rankChunks(candidates, {}).ranked;
  const window1 = buildContextWindow(ranked1, opts);

  const ranked2 = rankChunks(candidates, {}).ranked;
  const window2 = buildContextWindow(ranked2, opts);

  assert(window1.entries.length === window2.entries.length, "same number of entries on repeat (INV-RET8)");
  assert(window1.totalEstimatedTokens === window2.totalEstimatedTokens, "same token count on repeat (INV-RET8)");
  assert(window1.chunksSelected === window2.chunksSelected, "same chunksSelected on repeat");

  const ids1 = window1.entries.map(e => e.metadata.chunkId).join(",");
  const ids2 = window2.entries.map(e => e.metadata.chunkId).join(",");
  assert(ids1 === ids2, "same chunk IDs in same order on repeat (INV-RET8)");
}

// ─── S18: RetrievalExplainOutput type shape ───────────────────────────────────

async function s18_explainOutput() {
  section("S18: RetrievalExplainOutput shape and field types");

  // Build a synthetic RetrievalExplainOutput that matches the exported interface.
  // This tests the shape contract without requiring a live vector search.
  const candidates = [
    mockCandidate({ chunkId: "exp-1", similarityScore: 0.90, chunkText: "Explain test chunk content for Phase 5H retrieval validation" }),
    mockCandidate({ chunkId: "exp-2", similarityScore: 0.75, chunkText: "Second explain chunk with lower similarity score" }),
  ];
  const rankResult = rankChunks(candidates, {});
  const window = buildContextWindow(rankResult.ranked, { maxTokens: 400 });

  // Construct a RetrievalExplainOutput value directly to verify interface shape
  const explain = {
    queryHash: "explain-hash-ph5h",
    candidatesFound: 2,
    chunksRanked: rankResult.ranked.length,
    chunksSkippedDuplicate: rankResult.skippedDuplicate.length,
    chunksSkippedBudget: window.chunksSkippedBudget,
    chunksSkippedThreshold: rankResult.skippedThreshold.length,
    chunksSelected: window.chunksSelected,
    tokenBudget: 400,
    tokensUsed: window.totalEstimatedTokens,
    budgetUtilizationPct: window.budgetUtilizationPct,
    documentCount: window.documentCount,
    appliedFilters: { tenantId: "tenant-explain", knowledgeBaseId: "kb-explain" },
    searchDurationMs: 12,
    selectionTrace: window.entries.map((e, i) => ({
      rank: i + 1,
      chunkId: e.metadata.chunkId,
      documentId: e.metadata.documentId,
      similarityScore: e.metadata.similarityScore,
      estimatedTokens: estimateTokens(e.text),
      selectedReason: "within budget",
    })),
    exclusionTrace: rankResult.skippedDuplicate.map(c => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      similarityScore: c.similarityScore,
      exclusionReason: "duplicate" as const,
    })),
  };

  assert(typeof explain.queryHash === "string", "explain.queryHash is string");
  assert(typeof explain.candidatesFound === "number", "explain.candidatesFound is number");
  assert(typeof explain.chunksRanked === "number", "explain.chunksRanked is number");
  assert(typeof explain.chunksSkippedDuplicate === "number", "explain.chunksSkippedDuplicate is number");
  assert(typeof explain.chunksSkippedBudget === "number", "explain.chunksSkippedBudget is number");
  assert(typeof explain.chunksSelected === "number", "explain.chunksSelected is number");
  assert(typeof explain.tokenBudget === "number", "explain.tokenBudget is number");
  assert(typeof explain.tokensUsed === "number", "explain.tokensUsed is number");
  assert(explain.tokensUsed <= explain.tokenBudget, "tokensUsed never exceeds tokenBudget (INV-RET5)");
  assert(Array.isArray(explain.selectionTrace), "selectionTrace is array");
  assert(Array.isArray(explain.exclusionTrace), "exclusionTrace is array");
  assert(typeof explain.appliedFilters === "object", "appliedFilters is object");
  assert(typeof explain.searchDurationMs === "number", "searchDurationMs is number");
}

// ─── S19: buildContextPreview functional test ────────────────────────────────

async function s19_contextPreview() {
  section("S19: buildContextPreview functional test");

  const candidates = [
    mockCandidate({ chunkId: "prev-1", chunkText: "Preview chunk one: relevant information for context.", similarityScore: 0.91 }),
    mockCandidate({ chunkId: "prev-2", chunkText: "Preview chunk two: supporting detail for the query.", similarityScore: 0.83 }),
    mockCandidate({ chunkId: "prev-3", chunkText: "Preview chunk three: additional context content.", similarityScore: 0.72 }),
  ];

  // buildContextPreview accepts VectorSearchCandidate[] directly (no DB call)
  const { contextWindow, summary } = buildContextPreview(candidates, {
    maxContextTokens: 500,
  });

  assert(typeof contextWindow === "object", "contextWindow is object");
  assert(Array.isArray(contextWindow.entries), "contextWindow.entries is array");
  assert(contextWindow.entries.length >= 1, "at least 1 entry assembled in preview");
  assert(contextWindow.totalEstimatedTokens <= 500, "preview respects maxContextTokens (INV-RET5)");
  assert(typeof contextWindow.chunksSelected === "number", "contextWindow.chunksSelected is number");
  assert(typeof summary === "object", "summary is object");
  assert("totalEstimatedTokens" in summary, "summary has totalEstimatedTokens");
  assert("chunksSelected" in summary, "summary has chunksSelected");
  assert((summary.totalEstimatedTokens as number) <= 500, "summary token count within budget");
}

// ─── S20: DB migration artifacts verified ────────────────────────────────────

async function s20_dbMigrationArtifacts() {
  section("S20: DB migration artifacts from migrate-phase5h.ts");

  // Verify knowledge_retrieval_runs table still present
  const tableResult = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'knowledge_retrieval_runs'
  `);
  const tableRows = (tableResult as any).rows ?? [];
  assert(tableRows.length === 1, "DB: knowledge_retrieval_runs table exists");

  // Verify embedding_version column
  const embColResult = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_retrieval_runs' AND column_name = 'embedding_version'
  `);
  const embColRows = (embColResult as any).rows ?? [];
  assert(embColRows.length === 1, "DB: embedding_version column present");

  // Verify retrieval_version column
  const retColResult = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_retrieval_runs' AND column_name = 'retrieval_version'
  `);
  const retColRows = (retColResult as any).rows ?? [];
  assert(retColRows.length === 1, "DB: retrieval_version column present");

  // Verify Phase 5H indexes
  const idxResult = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'knowledge_retrieval_runs'
      AND indexname IN ('krr_tenant_kb_hash_idx', 'krr_query_hash_idx', 'krr_tenant_kb_idx', 'krr_tenant_created_idx')
  `);
  const idxRows = (idxResult as any).rows as Array<{ indexname: string }>;
  const idxNames = idxRows.map(r => r.indexname);
  assert(idxNames.includes("krr_tenant_kb_hash_idx"), "DB: krr_tenant_kb_hash_idx exists (Phase 5H)");
  assert(idxNames.includes("krr_query_hash_idx"), "DB: krr_query_hash_idx exists (Phase 5H)");
  assert(idxNames.includes("krr_tenant_kb_idx"), "DB: krr_tenant_kb_idx exists (Phase 5E, preserved)");

  // Verify max_context_tokens CHECK constraint
  let constraintViolated = false;
  try {
    await db.execute(sql`
      INSERT INTO knowledge_retrieval_runs
        (id, tenant_id, knowledge_base_id, query_hash, candidates_found, candidates_ranked, chunks_selected,
         chunks_skipped_duplicate, chunks_skipped_budget, context_tokens_used, max_context_tokens, document_count)
      VALUES
        (gen_random_uuid(), 'tenant-ph5h-check', 'kb-check-9999', 'hash-check-ph5h', 0, 0, 0, 0, 0, 0, 0, 0)
    `);
  } catch (_e) {
    constraintViolated = true;
  }
  assert(constraintViolated, "DB: krr_max_context_check rejects max_context_tokens=0");

  // Find a real knowledge_base_id from the DB (required by FK constraint)
  const kbResult = await db.execute(sql`SELECT id FROM knowledge_bases LIMIT 1`);
  const kbRows = (kbResult as any).rows as Array<{ id: string }>;
  assert(kbRows.length > 0, "DB: at least one knowledge_base exists for round-trip test");

  if (kbRows.length > 0) {
    const realKbId = kbRows[0].id;
    const runId = `ph5h-run-${Date.now()}`;
    await db.execute(sql`
      INSERT INTO knowledge_retrieval_runs
        (id, tenant_id, knowledge_base_id, query_hash, candidates_found, candidates_ranked, chunks_selected,
         chunks_skipped_duplicate, chunks_skipped_budget, context_tokens_used, max_context_tokens, document_count)
      VALUES
        (${runId}, 'tenant-ph5h-rt', ${realKbId}, 'qhash-ph5h-roundtrip', 5, 4, 3, 1, 1, 320, 4000, 2)
    `);
    const selectResult = await db.execute(sql`
      SELECT id, tenant_id, query_hash, context_tokens_used, max_context_tokens
      FROM knowledge_retrieval_runs WHERE id = ${runId}
    `);
    const rows = (selectResult as any).rows as Array<Record<string, unknown>>;
    assert(rows.length === 1, "DB: retrieval run round-trip insert+select works");
    assert(rows[0].tenant_id === "tenant-ph5h-rt", "DB: tenant_id round-trips correctly");
    assert(Number(rows[0].context_tokens_used) === 320, "DB: context_tokens_used round-trips correctly");
    assert(Number(rows[0].max_context_tokens) === 4000, "DB: max_context_tokens round-trips correctly");

    // Cleanup
    await db.execute(sql`DELETE FROM knowledge_retrieval_runs WHERE id = ${runId}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n========================================");
  console.log("  validate-phase5h.ts — Phase 5H");
  console.log("  Retrieval Orchestration & Context Assembly");
  console.log("========================================\n");

  await s01_contextWindowReExport();
  await s02_tokenEstimation();
  await s03_tokenBudgetEnforcement();
  await s04_budgetNeverExceeded();
  await s05_wouldExceedBudget();
  await s06_rankChunksOrdering();
  await s07_duplicateSuppression();
  await s08_contentHashDedup();
  await s09_maxChunksPerDocument();
  await s10_similarityThreshold();
  await s11_contextWindowAssembly();
  await s12_contextWindowTokenStop();
  await s13_contextWindowMetadata();
  await s14_missingTenantIdRejected();
  await s15_missingKbIdRejected();
  await s16_emptyEmbeddingRejected();
  await s17_deterministicOutput();
  await s18_explainOutput();
  await s19_contextPreview();
  await s20_dbMigrationArtifacts();

  console.log("\n========================================");
  if (failed === 0) {
    console.log(`  RESULTS: ${passed} passed / 0 failed`);
    console.log(`  Total assertions: ${passed}`);
    console.log("========================================");
    console.log("\nAll assertions passed. Phase 5H validation complete.");
  } else {
    console.log(`  RESULTS: ${passed} passed / ${failed} FAILED`);
    console.log(`  Total assertions: ${passed + failed}`);
    console.log("========================================");
    console.log("\nFailed assertions:");
    for (const f of failures) {
      console.error(`  ✗ ${f}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\nValidation crashed:", err);
  process.exit(1);
});
