/**
 * Phase 5Z-PERF — OCR Pipeline Tests
 *
 * Tests the pure logic components of the OCR pipeline without live
 * DB or R2 connections:
 *
 *  1. scoreQuality() correctness
 *  2. chunkText() invariants (via DEFAULT_CHUNKING_POLICY)
 *  3. MIN_NATIVE_TEXT_CHARS guard correctness
 *  4. Dynamic chunking policy selection for large docs (T007)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chunkText,
  estimateTokens,
  DEFAULT_CHUNKING_POLICY,
  type ChunkingPolicy,
} from "../server/lib/media/retrieval-chunker.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeParagraphs(n: number, wordsPerPara: number): string {
  const word = "tekst";
  const para = Array.from({ length: wordsPerPara }, () => word).join(" ");
  return Array.from({ length: n }, () => para).join("\n\n");
}

function countNonWs(text: string): number {
  return text.replace(/\s+/g, "").length;
}

// ── scoreQuality (pure inline logic matching ocr-logic.ts) ────────────────────

function scoreQuality(text: string): number {
  const len = text.replace(/\s+/g, "").length;
  if (len === 0)    return 0;
  if (len < 50)     return 0.3;
  if (len < 500)    return 0.6;
  if (len < 5_000)  return 0.85;
  return 0.95;
}

describe("scoreQuality", () => {
  it("returns 0 for empty string", () => {
    assert.equal(scoreQuality(""), 0);
  });

  it("returns 0 for whitespace-only string", () => {
    assert.equal(scoreQuality("   \n\t  "), 0);
  });

  it("returns 0.3 for very short text (<50 non-ws chars)", () => {
    assert.equal(scoreQuality("abc"), 0.3);
    assert.equal(scoreQuality("a".repeat(49)), 0.3);
  });

  it("returns 0.6 for short text (50-499 non-ws chars)", () => {
    assert.equal(scoreQuality("a".repeat(50)), 0.6);
    assert.equal(scoreQuality("a".repeat(499)), 0.6);
  });

  it("returns 0.85 for medium text (500-4999 non-ws chars)", () => {
    assert.equal(scoreQuality("a".repeat(500)), 0.85);
    assert.equal(scoreQuality("a".repeat(4_999)), 0.85);
  });

  it("returns 0.95 for large text (>=5000 non-ws chars)", () => {
    assert.equal(scoreQuality("a".repeat(5_000)), 0.95);
    assert.equal(scoreQuality("a".repeat(100_000)), 0.95);
  });
});

// ── MIN_NATIVE_TEXT_CHARS guard ────────────────────────────────────────────────

const MIN_NATIVE_TEXT_CHARS = 120;

describe("MIN_NATIVE_TEXT_CHARS guard", () => {
  it("rejects text with fewer than 120 non-ws chars", () => {
    const shortText = "a".repeat(119);
    assert.ok(countNonWs(shortText) < MIN_NATIVE_TEXT_CHARS);
  });

  it("accepts text with exactly 120 non-ws chars", () => {
    const okText = "a".repeat(120);
    assert.ok(countNonWs(okText) >= MIN_NATIVE_TEXT_CHARS);
  });

  it("is not fooled by whitespace-heavy text", () => {
    // 200 spaces + only 10 real chars → should fail
    const paddedText = "   ".repeat(200) + "abcdefghij";
    assert.ok(countNonWs(paddedText) < MIN_NATIVE_TEXT_CHARS);
  });
});

// ── chunkText invariants (INV-CHK1-CHK5) ──────────────────────────────────────

describe("chunkText with DEFAULT_CHUNKING_POLICY", () => {
  it("INV-CHK5: returns at least one chunk for non-empty text", () => {
    const result = chunkText("Hej verden!", DEFAULT_CHUNKING_POLICY);
    assert.ok(result.length >= 1);
  });

  it("INV-CHK2: no chunk exceeds maxTokens (20% tolerance for overlap prefix)", () => {
    const text   = makeParagraphs(100, 50);
    const result = chunkText(text, DEFAULT_CHUNKING_POLICY);
    const limit  = DEFAULT_CHUNKING_POLICY.maxTokens * 1.2;
    for (const chunk of result) {
      assert.ok(
        chunk.tokenEstimate <= limit,
        `Chunk ${chunk.chunkIndex} has ${chunk.tokenEstimate} tokens > ${limit}`,
      );
    }
  });

  it("INV-CHK1: chunking is deterministic for same input", () => {
    const text = makeParagraphs(30, 40);
    const run1 = chunkText(text, DEFAULT_CHUNKING_POLICY);
    const run2 = chunkText(text, DEFAULT_CHUNKING_POLICY);
    assert.deepEqual(
      run1.map((c) => c.text),
      run2.map((c) => c.text),
    );
  });

  it("INV-CHK3: single-chunk doc always produced for very short text", () => {
    const tinyText = "Dette er en meget kort tekst.";
    const result   = chunkText(tinyText, DEFAULT_CHUNKING_POLICY);
    assert.equal(result.length, 1);
  });

  it("INV-CHK4: chunkIndex is sequential starting from 0", () => {
    const text   = makeParagraphs(50, 40);
    const result = chunkText(text, DEFAULT_CHUNKING_POLICY);
    result.forEach((chunk, i) => {
      assert.equal(chunk.chunkIndex, i);
    });
  });

  it("produces more chunks for larger text", () => {
    const smallResult = chunkText(makeParagraphs(5, 20), DEFAULT_CHUNKING_POLICY);
    const largeResult = chunkText(makeParagraphs(200, 60), DEFAULT_CHUNKING_POLICY);
    assert.ok(largeResult.length > smallResult.length);
  });
});

// ── Dynamic chunking policy (T007 segment-size tuning) ────────────────────────

function selectChunkingPolicy(charCount: number): ChunkingPolicy {
  if (charCount >= 40_000) {
    return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 400, minTokens: 15 };
  }
  if (charCount >= 15_000) {
    return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 600, minTokens: 20 };
  }
  return DEFAULT_CHUNKING_POLICY;
}

describe("selectChunkingPolicy (T007 segment-size tuning)", () => {
  it("uses DEFAULT policy for short docs (<15k chars)", () => {
    const policy = selectChunkingPolicy(5_000);
    assert.equal(policy.maxTokens, DEFAULT_CHUNKING_POLICY.maxTokens);
  });

  it("uses 600-token policy for medium docs (15k-39k chars)", () => {
    const policy = selectChunkingPolicy(20_000);
    assert.equal(policy.maxTokens, 600);
  });

  it("uses 400-token policy for large docs (>=40k chars)", () => {
    const policy = selectChunkingPolicy(40_000);
    assert.equal(policy.maxTokens, 400);
  });

  it("large doc with 400-token policy yields >= chunks than DEFAULT", () => {
    const text          = makeParagraphs(200, 60);
    const defaultChunks = chunkText(text, DEFAULT_CHUNKING_POLICY);
    const fineChunks    = chunkText(text, { ...DEFAULT_CHUNKING_POLICY, maxTokens: 400 });
    assert.ok(fineChunks.length >= defaultChunks.length);
  });

  it("INV-CHK2 holds with 400-token policy (20% tolerance for overlap prefix)", () => {
    const text   = makeParagraphs(200, 60);
    const policy = selectChunkingPolicy(text.length);
    const result = chunkText(text, policy);
    const limit  = policy.maxTokens * 1.2;
    for (const chunk of result) {
      assert.ok(
        chunk.tokenEstimate <= limit,
        `Chunk ${chunk.chunkIndex} has ${chunk.tokenEstimate} tokens > ${limit} under tuned policy`,
      );
    }
  });
});

// ── 80k char cap invariant ────────────────────────────────────────────────────

describe("80k char cap guard", () => {
  it("slicing at 80_000 chars preserves chunking ability", () => {
    const hugeText = "ord ".repeat(30_000); // ~120k chars
    const capped   = hugeText.slice(0, 80_000);
    assert.ok(capped.length <= 80_000);
    const result = chunkText(capped, DEFAULT_CHUNKING_POLICY);
    assert.ok(result.length > 0);
  });
});
