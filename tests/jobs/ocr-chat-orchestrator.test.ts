/**
 * tests/jobs/ocr-chat-orchestrator.test.ts — PHASE 5Z.7 T008
 *
 * Comprehensive tests for the OCR Chat Orchestrator.
 * All DB operations are mocked via vi.mock("pg") — no live connection needed.
 *
 * Coverage:
 *  1. computeOcrChatTriggerKey  — determinism, bucket arithmetic, cross-tenant isolation
 *  2. triggerOcrChat            — INV-OCO3 (zero-char guard), SSE emission, idempotency,
 *                                 DB-error resilience (INV-OCO4)
 *  3. pushOcrSseError           — error event reaches registered SSE listeners, fallback payload
 *  4. registerOcrSseListener    — isolation between taskIds, multi-listener, cleanup
 */

import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

// ── Hoist pg mock so the factory closure can reference shared spy objects ─────
//
// vi.hoisted() runs its factory BEFORE vi.mock() factories, making the returned
// values available inside the vi.mock() factory closure without TDZ issues.

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  query:   vi.fn<[string, unknown[]?], Promise<{ rows: Array<{ id: string }> }>>()
             .mockResolvedValue({ rows: [{ id: "mock-req-id" }] }),
  end:     vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("pg", () => ({
  // Must use a regular function (not arrow) so `new Client()` works as a constructor.
  // A constructor returning a non-primitive uses that value as the result of `new`.
  Client: vi.fn(function MockPgClient() { return pgMocks; }),
}));

// resolveDbUrl() requires DATABASE_URL — set a dummy value for all tests
process.env.DATABASE_URL = "postgresql://mock:5432/mock";

import {
  computeOcrChatTriggerKey,
  triggerOcrChat,
  pushOcrSseError,
  registerOcrSseListener,
} from "../../server/lib/jobs/ocr-chat-orchestrator.ts";

// ── Reset pg mock history before each test ────────────────────────────────────

beforeEach(() => {
  pgMocks.connect.mockClear();
  pgMocks.query.mockClear();
  pgMocks.end.mockClear();
  // Default: DB insert succeeds → new request created
  pgMocks.query.mockResolvedValue({ rows: [{ id: "default-req-id" }] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. computeOcrChatTriggerKey — pure function, no DB
// ─────────────────────────────────────────────────────────────────────────────

describe("computeOcrChatTriggerKey", () => {
  const T = "tenant-t08";
  const J = "job-t08";

  it("returns a 32-char lowercase hex string", () => {
    const key = computeOcrChatTriggerKey(T, J, 1500, "partial_ready", "running");
    assert.match(key, /^[0-9a-f]{32}$/, "must be 32 hex chars");
  });

  it("is deterministic — identical inputs → identical key", () => {
    const a = computeOcrChatTriggerKey(T, J, 1500, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 1500, "partial_ready", "running");
    assert.equal(a, b);
  });

  it("charCounts [1000–1499] share bucket 1000 → same key", () => {
    const a = computeOcrChatTriggerKey(T, J, 1000, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 1499, "partial_ready", "running");
    assert.equal(a, b, "same 500-bucket must produce same key");
  });

  it("charCount 1499 (bucket 1000) vs 1500 (bucket 1500) → different keys", () => {
    const a = computeOcrChatTriggerKey(T, J, 1499, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 1500, "partial_ready", "running");
    assert.notEqual(a, b, "bucket boundary must produce different key");
  });

  it("charCounts [0–499] all map to bucket 0 → same key", () => {
    const a = computeOcrChatTriggerKey(T, J, 0,   "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 499, "partial_ready", "running");
    assert.equal(a, b);
  });

  it("charCount=0 → valid 32-char key (bucket-0 edge case)", () => {
    const key = computeOcrChatTriggerKey(T, J, 0, "partial_ready", "running");
    assert.match(key, /^[0-9a-f]{32}$/);
  });

  it("stage change produces different key", () => {
    const a = computeOcrChatTriggerKey(T, J, 1000, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 1000, "completed",     "completed");
    assert.notEqual(a, b);
  });

  it("status change produces different key (same stage)", () => {
    const a = computeOcrChatTriggerKey(T, J, 1000, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, J, 1000, "partial_ready", "completed");
    assert.notEqual(a, b);
  });

  it("INV-OCO2: different tenants → different keys for identical OCR state", () => {
    const a = computeOcrChatTriggerKey("tenant-A", J, 1000, "partial_ready", "running");
    const b = computeOcrChatTriggerKey("tenant-B", J, 1000, "partial_ready", "running");
    assert.notEqual(a, b, "tenant isolation: different tenants must not share trigger keys");
  });

  it("different jobIds → different keys for same tenant", () => {
    const a = computeOcrChatTriggerKey(T, "job-1", 1000, "partial_ready", "running");
    const b = computeOcrChatTriggerKey(T, "job-2", 1000, "partial_ready", "running");
    assert.notEqual(a, b);
  });

  it("bucket boundaries: keyAt differs from keyBelow for all standard boundaries", () => {
    for (const boundary of [500, 1000, 5000, 10_000, 50_000]) {
      const atBoundary = computeOcrChatTriggerKey(T, J, boundary,     "partial_ready", "running");
      const below      = computeOcrChatTriggerKey(T, J, boundary - 1, "partial_ready", "running");
      assert.notEqual(atBoundary, below, `boundary ${boundary}: must differ from boundary-1`);
    }
  });

  it("large charCount (50 000 vs 50 499) share bucket; 50 500 crosses into next", () => {
    const a = computeOcrChatTriggerKey(T, J, 50_000, "completed", "completed");
    const b = computeOcrChatTriggerKey(T, J, 50_499, "completed", "completed");
    assert.equal(a, b, "50000–50499 must share bucket");

    const c = computeOcrChatTriggerKey(T, J, 50_500, "completed", "completed");
    assert.notEqual(a, c, "50500 crosses into next bucket");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. triggerOcrChat — INV-OCO3: zero-char guard (no DB call)
// ─────────────────────────────────────────────────────────────────────────────

describe("triggerOcrChat — INV-OCO3: zero-char guard", () => {
  it("charCount=0 → triggered=false with no DB connection", async () => {
    const result = await triggerOcrChat({
      jobId: "job-zero", tenantId: "t1", charCount: 0,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    assert.equal(result.triggered, false);
    assert.match(result.reason, /charCount=0/);
    assert.equal(result.requestId, null);
    assert.equal(pgMocks.connect.mock.calls.length, 0, "DB must not be touched for charCount=0");
  });

  it("charCount=0 → triggerKey is empty string", async () => {
    const result = await triggerOcrChat({
      jobId: "job-zero-key", tenantId: "t1", charCount: 0,
      stage: "partial_ready", status: "running", mode: "partial",
    });
    assert.equal(result.triggerKey, "");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. triggerOcrChat — successful new trigger → SSE events emitted
// ─────────────────────────────────────────────────────────────────────────────

describe("triggerOcrChat — SSE events on new trigger", () => {
  it("pushes partial_ready and answer_triggered SSE events for mode=partial", async () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-sse-1", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "req-abc" }] }) // insertAnswerRequestIfNew
      .mockResolvedValueOnce({ rows: [] });                  // stampOcrTaskTrigger

    const result = await triggerOcrChat({
      jobId: "job-sse-1", tenantId: "tenant-x", charCount: 2000,
      stage: "partial_ready", status: "running", mode: "partial",
      triggerReason: "multi_page_p1_threshold",
      ocrText: "First page content",
    });

    off();

    assert.equal(result.triggered,  true,     "must report triggered=true");
    assert.equal(result.requestId,  "req-abc", "must return new requestId");

    const types = received.map((e) => e.type);
    assert.ok(types.includes("partial_ready"),    "must emit partial_ready SSE");
    assert.ok(types.includes("answer_triggered"), "must emit answer_triggered SSE");
  });

  it("partial_ready SSE event contains taskId, charCount, and triggerKey", async () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-sse-fields", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "req-fields" }] })
      .mockResolvedValueOnce({ rows: [] });

    await triggerOcrChat({
      jobId: "job-sse-fields", tenantId: "t2", charCount: 3000,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    off();

    const ev = received.find((e) => e.type === "partial_ready");
    assert.ok(ev, "partial_ready event must exist");
    assert.equal(ev!.data.taskId,    "job-sse-fields");
    assert.equal(ev!.data.charCount, 3000);
    assert.ok(
      typeof ev!.data.triggerKey === "string" && (ev!.data.triggerKey as string).length > 0,
      "triggerKey must be a non-empty string",
    );
  });

  it("ocrText is included in partial_ready SSE event when provided", async () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-sse-text", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "req-text" }] })
      .mockResolvedValueOnce({ rows: [] });

    const sampleText = "Sample OCR text content from page 1";
    await triggerOcrChat({
      jobId: "job-sse-text", tenantId: "t3", charCount: 1500,
      stage: "partial_ready", status: "running", mode: "partial",
      ocrText: sampleText,
    });

    off();

    const ev = received.find((e) => e.type === "partial_ready");
    assert.equal(ev?.data.ocrText, sampleText, "ocrText must be forwarded in SSE event");
  });

  it("mode=complete emits 'completed' SSE (not 'partial_ready')", async () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-sse-done", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "req-done" }] })
      .mockResolvedValueOnce({ rows: [] });

    await triggerOcrChat({
      jobId: "job-sse-done", tenantId: "t4", charCount: 10_000,
      stage: "completed", status: "completed", mode: "complete",
    });

    off();

    const types = received.map((e) => e.type);
    assert.ok(types.includes("completed"),        "mode=complete must emit 'completed' SSE");
    assert.ok(types.includes("answer_triggered"), "must always emit answer_triggered");
    assert.ok(!types.includes("partial_ready"),   "must NOT emit partial_ready for mode=complete");
  });

  it("answer_triggered SSE event contains mode, stage, status, charCount", async () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-sse-ati", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "req-ati" }] })
      .mockResolvedValueOnce({ rows: [] });

    await triggerOcrChat({
      jobId: "job-sse-ati", tenantId: "t5", charCount: 5000,
      stage: "partial_ready", status: "running", mode: "partial",
      triggerReason: "single_page_threshold",
    });

    off();

    const ev = received.find((e) => e.type === "answer_triggered");
    assert.ok(ev, "answer_triggered event must exist");
    assert.equal(ev!.data.mode,          "partial");
    assert.equal(ev!.data.stage,         "partial_ready");
    assert.equal(ev!.data.status,        "running");
    assert.equal(ev!.data.charCount,     5000);
    assert.equal(ev!.data.triggerReason, "single_page_threshold");
    assert.ok(typeof ev!.data.triggeredAt === "string", "triggeredAt must be an ISO string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. triggerOcrChat — idempotency: duplicate trigger key → no-op (INV-OCO1)
// ─────────────────────────────────────────────────────────────────────────────

describe("triggerOcrChat — INV-OCO1: idempotency", () => {
  it("DB returns empty rows (ON CONFLICT DO NOTHING) → triggered=false, no SSE", async () => {
    // Simulate: trigger key already exists — INSERT returns no rows
    pgMocks.query.mockResolvedValueOnce({ rows: [] });

    const received: unknown[] = [];
    const off = registerOcrSseListener("job-idem-1", (e) => received.push(e));

    const result = await triggerOcrChat({
      jobId: "job-idem-1", tenantId: "t6", charCount: 1500,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    off();

    assert.equal(result.triggered, false, "duplicate trigger must be suppressed");
    assert.equal(result.reason,    "duplicate_trigger_suppressed");
    assert.equal(result.requestId, null);
    assert.equal(received.length,  0, "no SSE events on duplicate trigger");
  });

  it("simulates two calls with same state: second is no-op", async () => {
    // First call: insert succeeds
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "first" }] }) // insertAnswerRequestIfNew
      .mockResolvedValueOnce({ rows: [] });                // stampOcrTaskTrigger

    // Second call: conflict → empty rows
    pgMocks.query.mockResolvedValueOnce({ rows: [] });

    const r1 = await triggerOcrChat({
      jobId: "job-idem-2", tenantId: "t7", charCount: 1000,
      stage: "partial_ready", status: "running", mode: "partial",
    });
    const r2 = await triggerOcrChat({
      jobId: "job-idem-2", tenantId: "t7", charCount: 1000,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    assert.equal(r1.triggered, true,  "first trigger must fire");
    assert.equal(r2.triggered, false, "second call with same state must be suppressed");
  });

  it("new OCR state (different charCount bucket) is a fresh trigger after first", async () => {
    // First call: partial 1000 chars
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "r1" }] })
      .mockResolvedValueOnce({ rows: [] });

    // Second call: 2000 chars — different bucket → different triggerKey → new insert
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: "r2" }] })
      .mockResolvedValueOnce({ rows: [] });

    const r1 = await triggerOcrChat({
      jobId: "job-idem-3", tenantId: "t8", charCount: 1000,
      stage: "partial_ready", status: "running", mode: "partial",
    });
    const r2 = await triggerOcrChat({
      jobId: "job-idem-3", tenantId: "t8", charCount: 2000,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    assert.equal(r1.triggered, true, "first trigger (1000 chars) must fire");
    assert.equal(r2.triggered, true, "second trigger (2000 chars, new bucket) must also fire");
    assert.notEqual(r1.triggerKey, r2.triggerKey, "different states must produce different trigger keys");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. triggerOcrChat — INV-OCO4: DB errors are non-fatal
// ─────────────────────────────────────────────────────────────────────────────

describe("triggerOcrChat — INV-OCO4: DB errors are non-fatal", () => {
  it("DB connect failure → triggered=false with db_error reason, does not throw", async () => {
    pgMocks.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await triggerOcrChat({
      jobId: "job-dberr-1", tenantId: "t9", charCount: 2000,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    assert.equal(result.triggered, false);
    assert.match(result.reason, /db_error/, "reason must indicate db_error");
    assert.equal(result.requestId, null);
  });

  it("DB query throws → triggered=false, no SSE events pushed", async () => {
    pgMocks.connect.mockResolvedValueOnce(undefined);
    pgMocks.query.mockRejectedValueOnce(new Error("relation does not exist"));

    const received: unknown[] = [];
    const off = registerOcrSseListener("job-dberr-2", (e) => received.push(e));

    const result = await triggerOcrChat({
      jobId: "job-dberr-2", tenantId: "t10", charCount: 3000,
      stage: "partial_ready", status: "running", mode: "partial",
    });

    off();

    assert.equal(result.triggered, false);
    assert.equal(received.length, 0, "no SSE events must be emitted when DB fails");
  });

  it("triggerOcrChat never throws regardless of DB state", async () => {
    pgMocks.connect.mockRejectedValueOnce(new Error("timeout"));

    await assert.doesNotReject(
      triggerOcrChat({
        jobId: "job-dberr-3", tenantId: "t11", charCount: 1500,
        stage: "partial_ready", status: "running", mode: "partial",
      }),
      "triggerOcrChat must never throw — it must always resolve",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. pushOcrSseError — error events reach registered listeners
// ─────────────────────────────────────────────────────────────────────────────

describe("pushOcrSseError", () => {
  it("pushes a single error event to a registered listener", () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-err-1", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pushOcrSseError("job-err-1", "OCR engine failed");
    off();

    assert.equal(received.length, 1, "exactly one event");
    assert.equal(received[0]!.type,          "error");
    assert.equal(received[0]!.data.message,  "OCR engine failed");
  });

  it("includes fallback payload when provided", () => {
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = registerOcrSseListener("job-err-fb", (evt) =>
      received.push(evt as { type: string; data: Record<string, unknown> }),
    );

    pushOcrSseError("job-err-fb", "Unreadable PDF", {
      questionText: "What is the total amount?",
      filename:     "invoice.pdf",
    });
    off();

    const ev = received[0]!;
    assert.equal(ev.type,              "error");
    assert.equal(ev.data.fallback,     true,                        "fallback must be true");
    assert.equal(ev.data.questionText, "What is the total amount?", "questionText must pass through");
    assert.equal(ev.data.filename,     "invoice.pdf",               "filename must pass through");
  });

  it("no event received after listener unregisters", () => {
    const received: unknown[] = [];
    const off = registerOcrSseListener("job-err-off", (e) => received.push(e));
    off(); // unregister before push

    pushOcrSseError("job-err-off", "late error");
    assert.equal(received.length, 0, "unregistered listener must not receive events");
  });

  it("push to unknown taskId is a no-op (no throw)", () => {
    assert.doesNotThrow(() => {
      pushOcrSseError("nonexistent-task-9999", "error for nobody");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. registerOcrSseListener — isolation and cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("registerOcrSseListener — isolation and cleanup", () => {
  it("listener on task-A does NOT receive events pushed to task-B", () => {
    const logA: unknown[] = [];
    const logB: unknown[] = [];
    const offA = registerOcrSseListener("iso-A", (e) => logA.push(e));
    const offB = registerOcrSseListener("iso-B", (e) => logB.push(e));

    pushOcrSseError("iso-A", "event for A only");

    offA();
    offB();

    assert.equal(logA.length, 1, "task-A listener receives exactly one event");
    assert.equal(logB.length, 0, "task-B listener must NOT receive task-A event");
  });

  it("multiple listeners on same taskId each receive the event independently", () => {
    const log1: unknown[] = [];
    const log2: unknown[] = [];
    const off1 = registerOcrSseListener("multi-task", (e) => log1.push(e));
    const off2 = registerOcrSseListener("multi-task", (e) => log2.push(e));

    pushOcrSseError("multi-task", "shared error");

    off1();
    off2();

    assert.equal(log1.length, 1, "listener 1 must receive event");
    assert.equal(log2.length, 1, "listener 2 must receive event");
  });

  it("unregister removes only the unregistered listener, sibling stays active", () => {
    const log1: unknown[] = [];
    const log2: unknown[] = [];
    const off1 = registerOcrSseListener("partial-off", (e) => log1.push(e));
    const off2 = registerOcrSseListener("partial-off", (e) => log2.push(e));

    off1(); // remove listener 1 only
    pushOcrSseError("partial-off", "event after partial unregister");

    off2();

    assert.equal(log1.length, 0, "unregistered listener 1 must not receive event");
    assert.equal(log2.length, 1, "still-registered listener 2 must receive event");
  });

  it("events before and after unregister are counted correctly", () => {
    const log: unknown[] = [];
    const off = registerOcrSseListener("before-after", (e) => log.push(e));

    pushOcrSseError("before-after", "before unregister");
    off();
    pushOcrSseError("before-after", "after unregister");

    assert.equal(log.length, 1, "only pre-unregister event must be received");
  });

  it("unregistering the last listener on a taskId is safe (no throw on subsequent push)", () => {
    const off = registerOcrSseListener("ephemeral", () => {});
    off(); // last listener removed — Map entry should be cleaned up

    assert.doesNotThrow(() => {
      pushOcrSseError("ephemeral", "ghost push to cleaned-up taskId");
    });
  });

  it("returns a callable function (unregister handle)", () => {
    const off = registerOcrSseListener("handle-type", () => {});
    assert.equal(typeof off, "function", "registerOcrSseListener must return a function");
    off();
  });
});
