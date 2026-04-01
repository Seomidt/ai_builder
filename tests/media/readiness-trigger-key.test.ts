/**
 * Phase 5Z.3 — Tests: Readiness Trigger Key
 *
 * Validates that the trigger key generator:
 *  - Produces the same key for the same readiness state
 *  - Produces a new key when coverage bucket changes
 *  - Produces a new key when document status changes
 *  - Produces a new key when firstRetrievalReadyAt changes (null → timestamp)
 *  - Never uses sensitive fields in the key
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateTriggerKey,
  coverageBucket,
  isReadinessImproved,
  shouldSuppressTrigger,
  type TriggerKeyInputs,
} from "../../server/lib/media/readiness-trigger-key.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeInputs(overrides: Partial<TriggerKeyInputs> = {}): TriggerKeyInputs {
  return {
    documentId:            "doc-123",
    documentStatus:        "processing",
    coveragePercent:       0,
    firstRetrievalReadyAt: null,
    retrievalChunksActive: 0,
    ...overrides,
  };
}

// ── Coverage bucket tests ──────────────────────────────────────────────────────

describe("coverageBucket()", () => {
  it("0% → bucket 0", () => { assert.equal(coverageBucket(0), 0); });
  it("15% → bucket 0",  () => { assert.equal(coverageBucket(15), 0); });
  it("24% → bucket 0",  () => { assert.equal(coverageBucket(24), 0); });
  it("25% → bucket 25", () => { assert.equal(coverageBucket(25), 25); });
  it("49% → bucket 25", () => { assert.equal(coverageBucket(49), 25); });
  it("50% → bucket 50", () => { assert.equal(coverageBucket(50), 50); });
  it("74% → bucket 50", () => { assert.equal(coverageBucket(74), 50); });
  it("75% → bucket 75", () => { assert.equal(coverageBucket(75), 75); });
  it("99% → bucket 75", () => { assert.equal(coverageBucket(99), 75); });
  it("100% → bucket 100", () => { assert.equal(coverageBucket(100), 100); });
});

// ── Trigger key determinism ────────────────────────────────────────────────────

describe("generateTriggerKey() — determinism", () => {
  it("same inputs → same key", () => {
    const inputs = makeInputs({ documentStatus: "processing", coveragePercent: 40, retrievalChunksActive: 5 });
    const k1 = generateTriggerKey(inputs);
    const k2 = generateTriggerKey(inputs);
    assert.equal(k1.key, k2.key, "Same inputs must produce same key");
  });

  it("key is 12 hex chars", () => {
    const { key } = generateTriggerKey(makeInputs());
    assert.match(key, /^[0-9a-f]{12}$/, "Key must be 12 lowercase hex chars");
  });

  it("key is not the documentId itself (opaque)", () => {
    const { key } = generateTriggerKey(makeInputs({ documentId: "doc-secret" }));
    assert.equal(key.includes("doc-secret"), false, "Key must not expose documentId");
  });
});

// ── Coverage bucket crossing creates new key ───────────────────────────────────

describe("generateTriggerKey() — coverage bucket transitions", () => {
  it("within same bucket (0% and 20%) → same key", () => {
    const k1 = generateTriggerKey(makeInputs({ coveragePercent: 0,  retrievalChunksActive: 0 }));
    const k2 = generateTriggerKey(makeInputs({ coveragePercent: 20, retrievalChunksActive: 3 }));
    // Both are in bucket 0 and both have 0 vs >0 chunks → chunk change creates diff key
    // Actually chunks change → new key expected since hasChunks changes
    assert.notEqual(k1.key, k2.key, "0→20% with chunk change should differ");
  });

  it("within same bucket (25% and 40%) with same chunks → same key", () => {
    const k1 = generateTriggerKey(makeInputs({ coveragePercent: 25, retrievalChunksActive: 5 }));
    const k2 = generateTriggerKey(makeInputs({ coveragePercent: 40, retrievalChunksActive: 5 }));
    assert.equal(k1.key, k2.key, "25% and 40% are in same bucket (25), same chunks → same key");
  });

  it("crossing 25% bucket boundary → new key", () => {
    const k1 = generateTriggerKey(makeInputs({ coveragePercent: 24, retrievalChunksActive: 3 }));
    const k2 = generateTriggerKey(makeInputs({ coveragePercent: 25, retrievalChunksActive: 3 }));
    assert.notEqual(k1.key, k2.key, "Bucket 0→25 boundary must produce new key");
  });

  it("crossing 50% bucket boundary → new key", () => {
    const k1 = generateTriggerKey(makeInputs({ coveragePercent: 49, retrievalChunksActive: 10 }));
    const k2 = generateTriggerKey(makeInputs({ coveragePercent: 50, retrievalChunksActive: 10 }));
    assert.notEqual(k1.key, k2.key, "Bucket 25→50 boundary must produce new key");
  });

  it("100% coverage → unique key from 99%", () => {
    const k1 = generateTriggerKey(makeInputs({ coveragePercent: 99, retrievalChunksActive: 20 }));
    const k2 = generateTriggerKey(makeInputs({ coveragePercent: 100, retrievalChunksActive: 20 }));
    assert.notEqual(k1.key, k2.key, "99→100% bucket crossing must produce new key");
  });
});

// ── Status transitions create new key ─────────────────────────────────────────

describe("generateTriggerKey() — status transitions", () => {
  it("processing → completed → new key", () => {
    const k1 = generateTriggerKey(makeInputs({ documentStatus: "processing",  coveragePercent: 100, retrievalChunksActive: 20 }));
    const k2 = generateTriggerKey(makeInputs({ documentStatus: "completed",   coveragePercent: 100, retrievalChunksActive: 20 }));
    assert.notEqual(k1.key, k2.key, "Status change must produce new key");
  });

  it("processing → partially_ready → new key", () => {
    const k1 = generateTriggerKey(makeInputs({ documentStatus: "processing" }));
    const k2 = generateTriggerKey(makeInputs({ documentStatus: "partially_ready" }));
    assert.notEqual(k1.key, k2.key, "Status change to partially_ready must produce new key");
  });
});

// ── First retrieval ready creates new key ─────────────────────────────────────

describe("generateTriggerKey() — firstRetrievalReadyAt transitions", () => {
  it("null → timestamp creates new key (most important transition)", () => {
    const k1 = generateTriggerKey(makeInputs({ firstRetrievalReadyAt: null,                       retrievalChunksActive: 0 }));
    const k2 = generateTriggerKey(makeInputs({ firstRetrievalReadyAt: "2024-01-01T10:00:00.000Z", retrievalChunksActive: 5 }));
    assert.notEqual(k1.key, k2.key, "null → timestamp must produce new key — first partial-ready moment");
  });

  it("same timestamp → same key (reconnect safety)", () => {
    const ts = "2024-01-01T10:00:00.000Z";
    const k1  = generateTriggerKey(makeInputs({ firstRetrievalReadyAt: ts, coveragePercent: 30, retrievalChunksActive: 5 }));
    const k2  = generateTriggerKey(makeInputs({ firstRetrievalReadyAt: ts, coveragePercent: 30, retrievalChunksActive: 5 }));
    assert.equal(k1.key, k2.key, "Reconnect with same state must produce same key — no duplicate triggers");
  });
});

// ── Multi-tenant isolation ─────────────────────────────────────────────────────

describe("generateTriggerKey() — tenant isolation (different documentIds)", () => {
  it("different documentIds with same state → different keys", () => {
    const k1 = generateTriggerKey(makeInputs({ documentId: "doc-tenant-a", coveragePercent: 50, retrievalChunksActive: 10 }));
    const k2 = generateTriggerKey(makeInputs({ documentId: "doc-tenant-b", coveragePercent: 50, retrievalChunksActive: 10 }));
    assert.notEqual(k1.key, k2.key, "Different documentIds must produce different keys (tenant isolation)");
  });
});

// ── Metadata fields ────────────────────────────────────────────────────────────

describe("generateTriggerKey() — metadata", () => {
  it("result includes coverageBucket", () => {
    const r = generateTriggerKey(makeInputs({ coveragePercent: 60, retrievalChunksActive: 10 }));
    assert.equal(r.coverageBucket, 50, "60% should be in bucket 50");
  });

  it("result includes hasChunks=false when chunks=0", () => {
    const r = generateTriggerKey(makeInputs({ retrievalChunksActive: 0 }));
    assert.equal(r.hasChunks, false);
  });

  it("result includes hasChunks=true when chunks>0", () => {
    const r = generateTriggerKey(makeInputs({ retrievalChunksActive: 5 }));
    assert.equal(r.hasChunks, true);
  });

  it("result includes firstRetrievalReadyAt from inputs", () => {
    const ts = "2024-01-01T12:00:00.000Z";
    const r  = generateTriggerKey(makeInputs({ firstRetrievalReadyAt: ts }));
    assert.equal(r.firstRetrievalReadyAt, ts);
  });

  it("description is a non-empty string", () => {
    const r = generateTriggerKey(makeInputs({ coveragePercent: 40, retrievalChunksActive: 5 }));
    assert.ok(r.description.length > 0, "description must be non-empty");
  });
});

// ── Comparison helpers ─────────────────────────────────────────────────────────

describe("isReadinessImproved() / shouldSuppressTrigger()", () => {
  it("different keys → isReadinessImproved=true", () => {
    assert.equal(isReadinessImproved("abc123", "def456"), true);
  });

  it("same keys → isReadinessImproved=false", () => {
    assert.equal(isReadinessImproved("abc123", "abc123"), false);
  });

  it("same key as previous → shouldSuppressTrigger=true (idempotent)", () => {
    assert.equal(shouldSuppressTrigger("abc123", "abc123"), true);
  });

  it("null previous → shouldSuppressTrigger=false (first trigger always allowed)", () => {
    assert.equal(shouldSuppressTrigger(null, "abc123"), false);
  });

  it("different key → shouldSuppressTrigger=false (new generation)", () => {
    assert.equal(shouldSuppressTrigger("abc123", "def456"), false);
  });
});
