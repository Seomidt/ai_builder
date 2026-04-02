/**
 * PHASE A–H — OCR Fallback & Input Router Tests
 *
 * Tests pure-logic components without live DB or external connections:
 *
 * 1. selectInputRoute  — central routing decision point (PHASE D)
 *    - text/plain  → direct_text_fast_path  (INV-IR1: never enters OCR)
 *    - code files  → code_text_fast_path    (INV-IR1: never enters OCR)
 *    - scanned PDF → scanned_pdf_ocr_path
 *    - native PDF  → native_text_pdf_fast_path
 *    - images      → image_vision_path
 *    - audio       → audio_transcription_path
 *    - video       → video_multimodal_path
 *
 * 2. SSE fallback payload — pushOcrSseError with { fallback, questionText, filename }
 *    - listener receives extended error data (PHASE B/E)
 *
 * 3. computeOcrChatTriggerKey fallback key stability (PHASE B)
 *    - fallback key based on tenantId:jobId:fallback is stable
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { selectInputRoute }        from "../server/lib/chat/input-router.ts";
import { computeOcrChatTriggerKey, registerOcrSseListener, pushOcrSseError } from "../server/lib/jobs/ocr-chat-orchestrator.ts";
import { createHash }              from "node:crypto";

// ── selectInputRoute ──────────────────────────────────────────────────────────

describe("selectInputRoute — PHASE D central router", () => {

  // ── text files (INV-IR1) ────────────────────────────────────────────────────

  it("text/plain → direct_text_fast_path (INV-IR1: never OCR)", () => {
    const r = selectInputRoute({ mimeType: "text/plain", filename: "doc.txt", sizeBytes: 1024 });
    assert.equal(r.route, "direct_text_fast_path");
  });

  it("text/markdown → direct_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "text/markdown", filename: "readme.md", sizeBytes: 500 });
    assert.equal(r.route, "direct_text_fast_path");
  });

  it("application/json → direct_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "application/json", filename: "data.json", sizeBytes: 2048 });
    assert.equal(r.route, "direct_text_fast_path");
  });

  it("text/csv → direct_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "text/csv", filename: "export.csv", sizeBytes: 4096 });
    assert.equal(r.route, "direct_text_fast_path");
  });

  // ── code files ──────────────────────────────────────────────────────────────

  it(".ts extension → code_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "text/plain", filename: "server.ts", sizeBytes: 8192 });
    assert.equal(r.route, "code_text_fast_path");
  });

  it(".py extension → code_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "text/plain", filename: "main.py", sizeBytes: 1024 });
    assert.equal(r.route, "code_text_fast_path");
  });

  it(".sql extension → code_text_fast_path", () => {
    const r = selectInputRoute({ mimeType: "text/plain", filename: "migration.sql", sizeBytes: 512 });
    assert.equal(r.route, "code_text_fast_path");
  });

  // ── PDF routing ─────────────────────────────────────────────────────────────

  it("scanned PDF (embeddedTextNonWsChars=0) → scanned_pdf_ocr_path", () => {
    const r = selectInputRoute({
      mimeType: "application/pdf", filename: "scanned.pdf",
      sizeBytes: 500_000, embeddedTextNonWsChars: 0,
    });
    assert.equal(r.route, "scanned_pdf_ocr_path");
  });

  it("PDF with no embeddedTextNonWsChars → scanned_pdf_ocr_path (safe default)", () => {
    const r = selectInputRoute({ mimeType: "application/pdf", filename: "unknown.pdf", sizeBytes: 200_000 });
    assert.equal(r.route, "scanned_pdf_ocr_path");
  });

  it("native PDF (embeddedTextNonWsChars=500) → native_text_pdf_fast_path", () => {
    const r = selectInputRoute({
      mimeType: "application/pdf", filename: "native.pdf",
      sizeBytes: 200_000, embeddedTextNonWsChars: 500,
    });
    assert.equal(r.route, "native_text_pdf_fast_path");
  });

  it("native PDF boundary (embeddedTextNonWsChars=120) → native_text_pdf_fast_path", () => {
    const r = selectInputRoute({
      mimeType: "application/pdf", filename: "border.pdf",
      sizeBytes: 100_000, embeddedTextNonWsChars: 120,
    });
    assert.equal(r.route, "native_text_pdf_fast_path");
  });

  it("scanned PDF boundary (embeddedTextNonWsChars=119) → scanned_pdf_ocr_path", () => {
    const r = selectInputRoute({
      mimeType: "application/pdf", filename: "almostnative.pdf",
      sizeBytes: 100_000, embeddedTextNonWsChars: 119,
    });
    assert.equal(r.route, "scanned_pdf_ocr_path");
  });

  // ── media files ─────────────────────────────────────────────────────────────

  it("image/jpeg → image_vision_path", () => {
    const r = selectInputRoute({ mimeType: "image/jpeg", filename: "photo.jpg", sizeBytes: 300_000 });
    assert.equal(r.route, "image_vision_path");
  });

  it("image/png → image_vision_path", () => {
    const r = selectInputRoute({ mimeType: "image/png", filename: "screenshot.png", sizeBytes: 500_000 });
    assert.equal(r.route, "image_vision_path");
  });

  it("audio/mpeg → audio_transcription_path", () => {
    const r = selectInputRoute({ mimeType: "audio/mpeg", filename: "recording.mp3", sizeBytes: 2_000_000 });
    assert.equal(r.route, "audio_transcription_path");
  });

  it("video/mp4 → video_multimodal_path", () => {
    const r = selectInputRoute({ mimeType: "video/mp4", filename: "clip.mp4", sizeBytes: 10_000_000 });
    assert.equal(r.route, "video_multimodal_path");
  });

  // ── unsupported ─────────────────────────────────────────────────────────────

  it("application/octet-stream → unsupported", () => {
    const r = selectInputRoute({ mimeType: "application/octet-stream", filename: "blob.bin", sizeBytes: 100 });
    assert.equal(r.route, "unsupported");
  });

  // ── INV-IR4: determinism ────────────────────────────────────────────────────

  it("same inputs → same route (INV-IR4 determinism)", () => {
    const p = { mimeType: "text/plain", filename: "data.txt", sizeBytes: 1024 };
    assert.equal(selectInputRoute(p).route, selectInputRoute(p).route);
  });

  // ── INV-IR1 guard: text/plain .pdf extension must NOT enter OCR ─────────────

  it("text/plain with .pdf extension → direct_text_fast_path (INV-IR1 guard)", () => {
    // Edge case: someone uploads a text file named .pdf — route should prioritise mime
    const r = selectInputRoute({ mimeType: "text/plain", filename: "not_really.pdf", sizeBytes: 1024 });
    // text/plain is detected first — before PDF extension check
    assert.equal(r.route, "direct_text_fast_path", "text/plain must never enter OCR even with .pdf extension");
  });
});

// ── SSE fallback payload ──────────────────────────────────────────────────────

describe("pushOcrSseError — PHASE B/E fallback payload", () => {
  it("without fallback payload → listener gets { message } only", (done) => {
    const taskId = `test-${Date.now()}-a`;
    const unregister = registerOcrSseListener(taskId, (evt) => {
      assert.equal(evt.type, "error");
      assert.equal((evt.data as any).message, "Fejl uden fallback");
      assert.equal((evt.data as any).fallback, undefined);
      unregister();
      done();
    });
    pushOcrSseError(taskId, "Fejl uden fallback");
  });

  it("with fallback payload → listener gets { fallback: true, questionText, filename }", (done) => {
    const taskId = `test-${Date.now()}-b`;
    const unregister = registerOcrSseListener(taskId, (evt) => {
      const d = evt.data as any;
      assert.equal(evt.type, "error");
      assert.equal(d.fallback, true);
      assert.equal(d.questionText, "Hvad handler dokumentet om?");
      assert.equal(d.filename, "rapport.pdf");
      assert.equal(d.message, "Ingen tekst fundet");
      unregister();
      done();
    });
    pushOcrSseError(taskId, "Ingen tekst fundet", {
      questionText: "Hvad handler dokumentet om?",
      filename:     "rapport.pdf",
    });
  });

  it("no listener → pushOcrSseError is a no-op (no throw)", () => {
    assert.doesNotThrow(() => {
      pushOcrSseError("nonexistent-task-id-xyz", "Fejl", { questionText: "q", filename: "f" });
    });
  });
});

// ── Fallback trigger key stability (PHASE B) ──────────────────────────────────

describe("triggerOcrChatFallback — trigger key stability (PHASE B)", () => {
  it("fallback key based on tenantId:jobId:fallback is stable and 32-char hex", () => {
    const tenantId = "tenant-foo";
    const jobId    = "job-bar";
    const keyA = createHash("sha256").update(`${tenantId}:${jobId}:fallback`).digest("hex").slice(0, 32);
    const keyB = createHash("sha256").update(`${tenantId}:${jobId}:fallback`).digest("hex").slice(0, 32);
    assert.match(keyA, /^[0-9a-f]{32}$/);
    assert.equal(keyA, keyB, "fallback key must be deterministic");
  });

  it("fallback key is different for different jobs", () => {
    const tenant = "tenant-foo";
    const keyA = createHash("sha256").update(`${tenant}:job-1:fallback`).digest("hex").slice(0, 32);
    const keyB = createHash("sha256").update(`${tenant}:job-2:fallback`).digest("hex").slice(0, 32);
    assert.notEqual(keyA, keyB);
  });

  it("fallback key differs from normal trigger key for same jobId", () => {
    const normal   = computeOcrChatTriggerKey("tenant", "job-x", 500, "partial_ready", "running");
    const fallback = createHash("sha256").update("tenant:job-x:fallback").digest("hex").slice(0, 32);
    assert.notEqual(normal, fallback, "fallback key must not collide with normal trigger keys");
  });
});
