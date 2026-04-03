/**
 * answer-cache-distributed.test.ts
 *
 * Unit tests for the distributed answer cache (PHASE 5Z.6).
 * Tests key derivation, TTL logic, tenant isolation, and graceful KV fallback.
 * KV HTTP calls are intercepted via global.fetch mock — no real network.
 */

import { test, describe, beforeEach } from "vitest";
import assert                          from "node:assert/strict";

import {
  buildCacheKey,
  hashQuery,
  getCachedAnswerDistributed,
  setCachedAnswerDistributed,
  invalidateCacheEntryDistributed,
  type AnswerCacheKey,
  type CachedAnswer,
} from "../../server/lib/media/answer-cache-distributed.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKey(overrides: Partial<AnswerCacheKey> = {}): AnswerCacheKey {
  return {
    tenantId:         "tenant-abc",
    queryHash:        "qhash123",
    refinementGenKey: "rgenkey1",
    docIds:           "doc1,doc2",
    mode:             "partial",
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<CachedAnswer> = {}): CachedAnswer {
  return {
    text:                 "Test svar",
    answerCompleteness:   "partial",
    coveragePercent:      40,
    refinementGeneration: 1,
    createdAt:            new Date().toISOString(),
    ...overrides,
  };
}

// ── buildCacheKey ─────────────────────────────────────────────────────────────

describe("buildCacheKey", () => {
  test("returns consistent key for same inputs", () => {
    const k1 = buildCacheKey(makeKey());
    const k2 = buildCacheKey(makeKey());
    assert.equal(k1, k2);
  });

  test("different tenantId → different key", () => {
    const k1 = buildCacheKey(makeKey({ tenantId: "tenant-A" }));
    const k2 = buildCacheKey(makeKey({ tenantId: "tenant-B" }));
    assert.notEqual(k1, k2);
  });

  test("different queryHash → different key", () => {
    const k1 = buildCacheKey(makeKey({ queryHash: "hash-X" }));
    const k2 = buildCacheKey(makeKey({ queryHash: "hash-Y" }));
    assert.notEqual(k1, k2);
  });

  test("different refinementGenKey → different key", () => {
    const k1 = buildCacheKey(makeKey({ refinementGenKey: "gen1" }));
    const k2 = buildCacheKey(makeKey({ refinementGenKey: "gen2" }));
    assert.notEqual(k1, k2);
  });

  test("partial vs complete → different key (mode isolation)", () => {
    const k1 = buildCacheKey(makeKey({ mode: "partial" }));
    const k2 = buildCacheKey(makeKey({ mode: "complete" }));
    assert.notEqual(k1, k2);
  });

  test("key starts with 'acache:' prefix", () => {
    const k = buildCacheKey(makeKey());
    assert.ok(k.startsWith("acache:"));
  });

  test("key is deterministic with sorted docIds", () => {
    const k1 = buildCacheKey(makeKey({ docIds: "doc1,doc2" }));
    const k2 = buildCacheKey(makeKey({ docIds: "doc1,doc2" }));
    assert.equal(k1, k2);
  });
});

// ── hashQuery ─────────────────────────────────────────────────────────────────

describe("hashQuery", () => {
  test("same query → same hash", () => {
    assert.equal(hashQuery("hvad er moms"), hashQuery("hvad er moms"));
  });

  test("case-insensitive normalisation", () => {
    assert.equal(hashQuery("Hvad Er MOMS"), hashQuery("hvad er moms"));
  });

  test("whitespace normalisation", () => {
    assert.equal(hashQuery("hvad  er   moms"), hashQuery("hvad er moms"));
  });

  test("different query → different hash", () => {
    assert.notEqual(hashQuery("hvad er moms"), hashQuery("hvad er skat"));
  });

  test("returns 16-char hex string", () => {
    const h = hashQuery("test query");
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]+$/);
  });
});

// ── KV miss (no REPLIT_DB_URL) ────────────────────────────────────────────────

describe("getCachedAnswerDistributed — KV unavailable", () => {
  beforeEach(() => {
    delete process.env.REPLIT_DB_URL;
  });

  test("returns miss when REPLIT_DB_URL is unset", async () => {
    const result = await getCachedAnswerDistributed(makeKey());
    assert.equal(result.hit, false);
    assert.equal(result.answer, null);
    assert.equal(result.source, "miss");
  });
});

describe("setCachedAnswerDistributed — KV unavailable", () => {
  beforeEach(() => {
    delete process.env.REPLIT_DB_URL;
  });

  test("does not throw when REPLIT_DB_URL is unset", async () => {
    await assert.doesNotReject(() => setCachedAnswerDistributed(makeKey(), makeAnswer()));
  });
});

// ── KV mock (fetch stubbing) ──────────────────────────────────────────────────

describe("getCachedAnswerDistributed — with KV mock", () => {
  const FAKE_URL = "https://kv.replit.com/v0/fake-token";
  let _store: Map<string, string>;
  let _origFetch: typeof fetch;

  beforeEach(() => {
    process.env.REPLIT_DB_URL = FAKE_URL;
    _store = new Map();
    _origFetch = global.fetch;
    (global as any).fetch = async (url: string, opts?: RequestInit) => {
      const u = new URL(url);
      const key = decodeURIComponent(u.pathname.split("/").pop() ?? "");
      if (opts?.method === "POST") {
        const body = opts.body as URLSearchParams;
        for (const [k, v] of body.entries()) {
          _store.set(k, v);
        }
        return new Response("", { status: 200 });
      }
      if (opts?.method === "DELETE") {
        _store.delete(key);
        return new Response("", { status: 200 });
      }
      // GET
      const val = _store.get(key);
      if (!val) return new Response("", { status: 404 });
      return new Response(val, { status: 200 });
    };
  });

  test("miss when key not in store", async () => {
    const res = await getCachedAnswerDistributed(makeKey());
    assert.equal(res.hit, false);
    assert.equal(res.source, "miss");
  });

  test("hit after set", async () => {
    const ans = makeAnswer();
    await setCachedAnswerDistributed(makeKey(), ans);
    const res = await getCachedAnswerDistributed(makeKey());
    assert.equal(res.hit, true);
    assert.equal(res.source, "kv");
    assert.equal(res.answer?.text, "Test svar");
  });

  test("expired entry returns miss", async () => {
    const entry = {
      answer: makeAnswer(),
      expiresAt: Date.now() - 1000,  // already expired
    };
    const k = buildCacheKey(makeKey());
    _store.set(k, encodeURIComponent(JSON.stringify(entry)));
    const res = await getCachedAnswerDistributed(makeKey());
    assert.equal(res.hit, false);
    assert.equal(res.source, "miss");
  });

  test("tenant isolation — different tenants miss each other", async () => {
    await setCachedAnswerDistributed(makeKey({ tenantId: "tenant-A" }), makeAnswer());
    const res = await getCachedAnswerDistributed(makeKey({ tenantId: "tenant-B" }));
    assert.equal(res.hit, false);
  });

  test("partial and complete are separate (mode isolation)", async () => {
    await setCachedAnswerDistributed(makeKey({ mode: "partial" }), makeAnswer({ answerCompleteness: "partial" }));
    const res = await getCachedAnswerDistributed(makeKey({ mode: "complete" }));
    assert.equal(res.hit, false);
  });

  test("invalidate removes entry", async () => {
    await setCachedAnswerDistributed(makeKey(), makeAnswer());
    await invalidateCacheEntryDistributed(makeKey());
    const res = await getCachedAnswerDistributed(makeKey());
    assert.equal(res.hit, false);
  });

  test("fetch failure returns miss without throwing", async () => {
    (global as any).fetch = async () => { throw new Error("network error"); };
    const res = await getCachedAnswerDistributed(makeKey());
    assert.equal(res.hit, false);
    assert.equal(res.source, "miss");
  });
});
