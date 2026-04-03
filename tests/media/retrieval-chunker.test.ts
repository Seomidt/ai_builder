/**
 * Phase 5Z.1 — Tests: Token-Aware Retrieval Chunker
 *
 * Tests: INV-CHK1 (determinism), INV-CHK2 (maxTokens), INV-CHK3 (minTokens),
 *        INV-CHK4 (provenance), INV-CHK5 (empty content guard),
 *        overlap policy, paragraph boundaries.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chunkText,
  estimateTokens,
  buildChunkKey,
  DEFAULT_CHUNKING_POLICY,
  type ChunkingPolicy,
} from "../../server/lib/media/retrieval-chunker.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeParagraphs(n: number, wordsPerPara: number): string {
  const word = "word";
  const para = Array.from({ length: wordsPerPara }, () => word).join(" ");
  return Array.from({ length: n }, () => para).join("\n\n");
}

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("estimates ~1 token per 4 chars", () => {
    // 40 chars → ceil(40/4) = 10 tokens
    assert.equal(estimateTokens("a".repeat(40)), 10);
  });

  it("rounds up partial tokens", () => {
    // 5 chars → ceil(5/4) = 2
    assert.equal(estimateTokens("hello"), 2);
  });
});

// ── buildChunkKey ─────────────────────────────────────────────────────────────

describe("buildChunkKey (retrieval-chunker)", () => {
  it("is deterministic for same inputs", () => {
    const params = { documentVersionId: "v1", chunkIndex: 3, strategy: "token_aware_paragraph", version: "5z1.0" };
    assert.equal(buildChunkKey(params), buildChunkKey(params));
  });

  it("changes when chunkIndex changes", () => {
    const base = { documentVersionId: "v1", strategy: "s", version: "1" };
    assert.notEqual(buildChunkKey({ ...base, chunkIndex: 0 }), buildChunkKey({ ...base, chunkIndex: 1 }));
  });

  it("changes when documentVersionId changes", () => {
    const base = { chunkIndex: 0, strategy: "s", version: "1" };
    assert.notEqual(buildChunkKey({ ...base, documentVersionId: "v1" }), buildChunkKey({ ...base, documentVersionId: "v2" }));
  });
});

// ── chunkText — INV-CHK5 ──────────────────────────────────────────────────────

describe("chunkText — empty content guard (INV-CHK5)", () => {
  it("throws on empty string", () => {
    assert.throws(() => chunkText(""), /INV-CHK5/);
  });

  it("throws on whitespace-only string", () => {
    assert.throws(() => chunkText("   \n\n  "), /INV-CHK5/);
  });
});

// ── chunkText — INV-CHK1 (determinism) ───────────────────────────────────────

describe("chunkText — determinism (INV-CHK1)", () => {
  it("produces identical chunks for the same input", () => {
    const content = makeParagraphs(10, 80);
    const run1    = chunkText(content);
    const run2    = chunkText(content);

    assert.equal(run1.length, run2.length);
    for (let i = 0; i < run1.length; i++) {
      assert.equal(run1[i].text,          run2[i].text);
      assert.equal(run1[i].chunkIndex,    run2[i].chunkIndex);
      assert.equal(run1[i].characterStart, run2[i].characterStart);
      assert.equal(run1[i].characterEnd,   run2[i].characterEnd);
    }
  });

  it("produces different chunks for different content", () => {
    const a = makeParagraphs(4, 80);
    const b = makeParagraphs(4, 80) + " extra";
    const ra = chunkText(a);
    const rb = chunkText(b);
    // At minimum the last chunk should differ
    const lastA = ra[ra.length - 1].text;
    const lastB = rb[rb.length - 1].text;
    assert.notEqual(lastA, lastB);
  });
});

// ── chunkText — INV-CHK2 (maxTokens) ─────────────────────────────────────────

describe("chunkText — max token cap (INV-CHK2)", () => {
  it("no chunk exceeds maxTokens (with 20% tolerance for dense text)", () => {
    // targetTokens must be <= maxTokens to avoid overlap-prefix violations.
    // Overlap = targetTokens * overlapFraction = 80 * 0.15 ≈ 12 tokens.
    // Max chunk with overlap = 100 + 12 = 112 tokens, within 120 (20 % tolerance).
    const policy: ChunkingPolicy = {
      ...DEFAULT_CHUNKING_POLICY,
      targetTokens: 80,
      maxTokens:    100,
    };
    // 10 paragraphs × 40 words × ~5 chars → forces multiple chunks at targetTokens=80
    const content = makeParagraphs(10, 40);
    const spans   = chunkText(content, policy);

    for (const span of spans) {
      // Allow 20% tolerance per the warning in the chunker
      assert.ok(
        span.tokenEstimate <= policy.maxTokens * 1.2,
        `Chunk ${span.chunkIndex} has ${span.tokenEstimate} tokens, max allowed is ${policy.maxTokens * 1.2}`,
      );
    }
  });
});

// ── chunkText — chunk ordering and provenance (INV-CHK4) ─────────────────────

describe("chunkText — provenance (INV-CHK4)", () => {
  it("chunk indices are sequential starting from 0", () => {
    const content = makeParagraphs(8, 60);
    const spans   = chunkText(content);
    for (let i = 0; i < spans.length; i++) {
      assert.equal(spans[i].chunkIndex, i);
    }
  });

  it("characterStart < characterEnd for every chunk", () => {
    const content = makeParagraphs(6, 60);
    const spans   = chunkText(content);
    for (const span of spans) {
      assert.ok(
        span.characterStart < span.characterEnd,
        `Chunk ${span.chunkIndex}: start=${span.characterStart} >= end=${span.characterEnd}`,
      );
    }
  });

  it("characterStart of first chunk is 0 or positive", () => {
    const spans = chunkText("Hello world. This is a test.");
    assert.ok(spans[0].characterStart >= 0);
  });

  it("tokenEstimate is positive for every chunk", () => {
    const content = makeParagraphs(4, 60);
    const spans   = chunkText(content);
    for (const span of spans) {
      assert.ok(span.tokenEstimate > 0, `Chunk ${span.chunkIndex} has tokenEstimate=${span.tokenEstimate}`);
    }
  });

  it("overlapCharacters is 0 for first chunk", () => {
    const content = makeParagraphs(4, 60);
    const spans   = chunkText(content);
    assert.equal(spans[0].overlapCharacters, 0);
  });
});

// ── chunkText — overlap ───────────────────────────────────────────────────────

describe("chunkText — overlap", () => {
  it("subsequent chunks have positive overlapCharacters when content warrants it", () => {
    const policy: ChunkingPolicy = {
      ...DEFAULT_CHUNKING_POLICY,
      targetTokens:    50,
      maxTokens:       80,
      overlapFraction: 0.2,
    };
    // Enough content to produce ≥2 chunks
    const content = makeParagraphs(6, 40);
    const spans   = chunkText(content, policy);

    if (spans.length > 1) {
      // At least one subsequent chunk should have overlap
      const hasOverlap = spans.slice(1).some((s) => s.overlapCharacters > 0);
      assert.ok(hasOverlap, "Expected at least one subsequent chunk to have overlap");
    }
  });
});

// ── chunkText — small document ────────────────────────────────────────────────

describe("chunkText — small documents", () => {
  it("returns single chunk for tiny content", () => {
    const spans = chunkText("Hello world. This is a short sentence.");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].chunkIndex, 0);
  });

  it("chunk text matches the original content (single chunk)", () => {
    const text  = "Hello world. This is a short sentence.";
    const spans = chunkText(text);
    // The single chunk text should contain the original text
    assert.ok(spans[0].text.includes("Hello world"));
  });
});

// ── chunkText — INV-CHK3 (minTokens — tiny fragment merging) ─────────────────

describe("chunkText — tiny fragment merging (INV-CHK3)", () => {
  it("does not produce a standalone chunk below minTokens as final chunk when prior chunks exist", () => {
    // Create content where the last paragraph is very small
    const bulkParagraphs = makeParagraphs(5, 60);
    const tinyTrail      = "Hi."; // ~1 token
    const content        = bulkParagraphs + "\n\n" + tinyTrail;

    const policy: ChunkingPolicy = {
      ...DEFAULT_CHUNKING_POLICY,
      targetTokens: 50,
      maxTokens:    80,
      minTokens:    10,
    };

    const spans = chunkText(content, policy);

    // The tiny trailer should be merged into the previous chunk, not standalone
    for (const span of spans) {
      // If this is not the only chunk, it should meet minTokens
      if (spans.length > 1) {
        assert.ok(
          span.tokenEstimate >= policy.minTokens,
          `Chunk ${span.chunkIndex} has ${span.tokenEstimate} tokens, below minTokens=${policy.minTokens}`,
        );
      }
    }
  });
});
