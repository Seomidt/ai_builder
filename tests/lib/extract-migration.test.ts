/**
 * extract-migration.test.ts — EXTRACT-MIGRATION Phase 10
 *
 * Unit tests for the zero-downtime jsonb→normalized columns migration.
 * All DB calls are intercepted via a hoisted vi.mock("pg") — no live DB required.
 *
 * Covers 10 migration requirements:
 *   1.  Dual-write emits both jsonb UPDATE and version row INSERT
 *   2.  Version row INSERT is idempotent (ON CONFLICT + timestamp guard)
 *   3.  Backfill processes historic jsonb-only rows
 *   4.  Backfill does not overwrite fresher normalized data
 *   5.  Shadow read logs MATCH / MISMATCH / JSONB_ONLY
 *   6.  Cutover reads from version row
 *   7.  Cutover falls back to jsonb when version row is empty
 *   8.  Hash-hit reuse works in every migration phase
 *   9.  Retention cleanup archives doc AND purges version row extracted_text
 *  10.  Rollback: disabling flags restores jsonb-only read path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock functions (must be declared before vi.mock factory executes) ─

const { mockQuery, mockConnect, mockEnd } = vi.hoisted(() => ({
  mockQuery:   vi.fn(),
  mockConnect: vi.fn(),
  mockEnd:     vi.fn(),
}));

// Mock the entire "pg" module so every `new pg.Client()` in the source returns
// our instrumented instance.
// IMPORTANT: Must use `class` (not arrow function) because JS requires
// a regular function / class to be used with `new`. Arrow functions are not
// constructors and will throw "is not a constructor" at runtime.
vi.mock("pg", () => ({
  default: {
    Client: class MockPgClient {
      connect = mockConnect;
      query   = mockQuery;
      end     = mockEnd;
    },
  },
}));

// ── Default mock behaviour reset before every test ────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
  // Default: query returns empty result so functions don't throw
  mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });

  // Clear all migration feature flags so each test controls its own state
  delete process.env.EXTRACT_DUAL_WRITE;
  delete process.env.EXTRACT_SHADOW_READ;
  delete process.env.EXTRACT_READ_CUTOVER;
});

// ── Helper builders ───────────────────────────────────────────────────────────

/**
 * Builds a DB row as the pg driver would return it for knowledge_documents.
 * `metadata` is a plain JS object (jsonb is auto-parsed by the pg driver).
 */
function makeDocRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const { vFields = {}, ...docOverrides } = overrides as Record<string, unknown>;
  return {
    id:              "doc-1",
    tenant_id:       "tenant-1",
    title:           "test.pdf",
    document_type:   "pdf",
    document_status: "ready",
    asset_scope:     "temporary_chat",
    asset_origin:    "chat_upload",
    chat_thread_id:  "thread-1",
    file_hash:       "abc123",
    is_pinned:       false,
    lifecycle_state: "active",
    created_at:      new Date("2025-01-01").toISOString(),
    updated_at:      new Date("2025-01-01").toISOString(),
    knowledge_base_id: null,
    retention_mode:    null,
    retention_expires_at: null,
    last_accessed_at: null,
    metadata: {
      r2Key:               "r2/doc-1.pdf",
      extractedText:       "Hello, world!",
      extractedTextStatus: "ready",
      extractedAt:         "2025-01-01T00:00:00.000Z",
      charCount:           13,
      extractionSource:    "r2_pdf_parse",
    },
    // version row columns (from LEFT JOIN)
    v_extracted_text:        null,
    v_extracted_text_status: null,
    v_extracted_at:          null,
    v_extraction_source:     null,
    ...(vFields as Record<string, unknown>),
    ...docOverrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dual-write emits both jsonb UPDATE and version row INSERT
// ─────────────────────────────────────────────────────────────────────────────

describe("1. Dual-write on fresh extraction", () => {
  it("issues exactly 2 queries: jsonb UPDATE then version INSERT", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { patchAssetTranscript } = await import("../../server/lib/knowledge/chat-assets.ts");
    await patchAssetTranscript({
      assetId:             "doc-1",
      tenantId:            "tenant-1",
      extractedText:       "Hello, world!",
      extractedTextStatus: "ready",
      charCount:           13,
      extractionSource:    "r2_pdf_parse",
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql1] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql1).toContain("UPDATE knowledge_documents");
    expect(sql1).toContain("extractedText");

    const [sql2] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql2).toContain("INSERT INTO knowledge_document_versions");
    expect(sql2).toContain("ON CONFLICT");
    expect(sql2).toContain("extracted_text");
  });

  it("passes extractionSource as a parameter to version INSERT", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { patchAssetTranscript } = await import("../../server/lib/knowledge/chat-assets.ts");
    await patchAssetTranscript({
      assetId:             "doc-2",
      tenantId:            "tenant-1",
      extractedText:       "audio transcript",
      extractedTextStatus: "ready",
      extractionSource:    "gemini_audio",
    });

    const params2 = mockQuery.mock.calls[1][1] as unknown[];
    expect(params2).toContain("gemini_audio");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Version row INSERT is idempotent (ON CONFLICT + timestamp guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("2. Idempotent version row upsert", () => {
  it("ON CONFLICT SQL contains the timestamp guard preventing stale overwrites", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { patchAssetTranscript } = await import("../../server/lib/knowledge/chat-assets.ts");
    await patchAssetTranscript({
      assetId:             "doc-3",
      tenantId:            "tenant-1",
      extractedText:       "newer text",
      extractedTextStatus: "ready",
    });

    const [sql2] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql2).toContain("WHERE knowledge_document_versions.extracted_at IS NULL");
    expect(sql2).toContain("OR EXCLUDED.extracted_at > knowledge_document_versions.extracted_at");
  });

  it("calling twice produces 4 DB queries — ON CONFLICT keeps it idempotent", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { patchAssetTranscript } = await import("../../server/lib/knowledge/chat-assets.ts");
    await patchAssetTranscript({ assetId: "doc-4", tenantId: "t-1", extractedText: "v1", extractedTextStatus: "ready" });
    await patchAssetTranscript({ assetId: "doc-4", tenantId: "t-1", extractedText: "v2", extractedTextStatus: "ready" });

    // 2 writes × 2 calls = 4
    expect(mockQuery).toHaveBeenCalledTimes(4);
    // Second call's version INSERT still uses ON CONFLICT
    const [sql4] = mockQuery.mock.calls[3] as [string, unknown[]];
    expect(sql4).toContain("ON CONFLICT (knowledge_document_id, version_number) DO UPDATE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Backfill processes historic jsonb-only rows
// ─────────────────────────────────────────────────────────────────────────────

describe("3. Backfill of historic jsonb-only rows", () => {
  it("upserts each candidate into knowledge_document_versions", async () => {
    const candidates = [
      {
        id: "old-1", tenant_id: "t-1",
        metadata: { extractedText: "old text", extractedTextStatus: "ready", extractedAt: "2024-01-01T00:00:00Z", charCount: 8, extractionSource: "r2_pdf_parse" },
      },
      {
        id: "old-2", tenant_id: "t-1",
        metadata: { extractedText: "another",  extractedTextStatus: "ready", extractedAt: "2024-01-02T00:00:00Z", charCount: 7, extractionSource: "gemini_audio" },
      },
    ];

    mockQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: candidates })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    const result = await runExtractBackfillBatch({ batchSize: 10 });

    expect(result.processed).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(0);

    const upsertCalls = mockQuery.mock.calls.slice(1) as [string, unknown[]][];
    for (const [sql] of upsertCalls) {
      expect(sql).toContain("INSERT INTO knowledge_document_versions");
    }
  });

  it("sets nextCursor to last candidate id for resumability", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "id-100", tenant_id: "t-1", metadata: { extractedText: "x", extractedTextStatus: "ready", extractedAt: "2024-01-01T00:00:00Z", charCount: 1, extractionSource: "direct" } }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    const result = await runExtractBackfillBatch({ batchSize: 1 });

    expect(result.nextCursor).toBe("id-100");
  });

  it("returns nextCursor=null when no candidates remain", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    const result = await runExtractBackfillBatch({ batchSize: 100 });

    expect(result.nextCursor).toBeNull();
    expect(result.processed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Backfill does not overwrite fresher normalized data
// ─────────────────────────────────────────────────────────────────────────────

describe("4. Backfill guard against overwriting newer data", () => {
  it("SELECT query excludes already-normalized rows via NOT EXISTS guard", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    await runExtractBackfillBatch({ batchSize: 100 });

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("extracted_text IS NOT NULL");
  });

  it("upsert SQL uses timestamp guard so stale backfill never overwrites fresh data", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "doc-x", tenant_id: "t-1", metadata: { extractedText: "stale", extractedTextStatus: "ready", extractedAt: "2023-01-01T00:00:00Z", charCount: 5, extractionSource: "backfill" } }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    await runExtractBackfillBatch({ batchSize: 10 });

    const [sql] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("WHERE knowledge_document_versions.extracted_at IS NULL");
    expect(sql).toContain("OR EXCLUDED.extracted_at > knowledge_document_versions.extracted_at");
  });

  it("dry-run: only issues SELECT — no INSERT queries fired", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "doc-y", tenant_id: "t-1", metadata: { extractedText: "text", extractedTextStatus: "ready", extractedAt: "2024-01-01T00:00:00Z", charCount: 4, extractionSource: "direct" } }] });

    const { runExtractBackfillBatch } = await import("../../server/lib/knowledge/extract-backfill.ts");
    const result = await runExtractBackfillBatch({ batchSize: 10, dryRun: true });

    // Only the SELECT query — no upsert issued
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result.dryRun).toBe(true);
    // Counts "would insert" for dry-run visibility
    expect(result.inserted).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Shadow read logs MATCH / MISMATCH / JSONB_ONLY
// ─────────────────────────────────────────────────────────────────────────────

describe("5. Shadow read comparison logging", () => {
  it("logs EXTRACT_READ_MATCH when lengths and statuses agree", async () => {
    // EXTRACT_SHADOW_READ defaults to ON (value != "false")
    delete process.env.EXTRACT_SHADOW_READ;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...makeDocRow(), v_extracted_text: "Hello, world!", v_extracted_text_status: "ready", v_extracted_at: "2025-01-01T00:00:00.000Z", v_extraction_source: "r2_pdf_parse" }],
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("EXTRACT_READ_MATCH"));
    consoleSpy.mockRestore();
  });

  it("logs EXTRACT_READ_MISMATCH when text lengths differ", async () => {
    delete process.env.EXTRACT_SHADOW_READ;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...makeDocRow(), v_extracted_text: "Different text entirely!", v_extracted_text_status: "ready", v_extracted_at: "2025-01-01T00:00:00.000Z", v_extraction_source: "r2_pdf_parse" }],
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("EXTRACT_READ_MISMATCH"));
    warnSpy.mockRestore();
  });

  it("logs EXTRACT_READ_JSONB_ONLY when version row has no extracted_text", async () => {
    delete process.env.EXTRACT_SHADOW_READ;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeDocRow()], // v_extracted_text defaults to null
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("EXTRACT_READ_JSONB_ONLY"));
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cutover reads from version row
// ─────────────────────────────────────────────────────────────────────────────

describe("6. Cutover: read from normalized version row", () => {
  it("returns version row text (not jsonb) when EXTRACT_READ_CUTOVER=true", async () => {
    process.env.EXTRACT_READ_CUTOVER = "true";
    process.env.EXTRACT_SHADOW_READ  = "false";

    const versionText = "normalized text from version row";
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        ...makeDocRow({ metadata: { r2Key: "r2/doc.pdf", extractedText: "jsonb text — should be ignored", extractedTextStatus: "ready" } }),
        v_extracted_text:        versionText,
        v_extracted_text_status: "ready",
        v_extracted_at:          "2025-01-02T00:00:00.000Z",
        v_extraction_source:     "r2_pdf_parse",
      }],
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(asset?.extractedText).toBe(versionText);
    expect(asset?.extractedTextStatus).toBe("ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cutover falls back to jsonb when version row is empty
// ─────────────────────────────────────────────────────────────────────────────

describe("7. Cutover fallback to jsonb", () => {
  it("returns jsonb text when version row has no extracted_text", async () => {
    process.env.EXTRACT_READ_CUTOVER = "true";
    process.env.EXTRACT_SHADOW_READ  = "false";

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeDocRow()], // v_extracted_text stays null
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(asset?.extractedText).toBe("Hello, world!");
    expect(asset?.extractedTextStatus).toBe("ready");
  });

  it("logs EXTRACT_FALLBACK when falling back from cutover to jsonb", async () => {
    process.env.EXTRACT_READ_CUTOVER = "true";
    process.env.EXTRACT_SHADOW_READ  = "false";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [makeDocRow()] });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("EXTRACT_FALLBACK"));
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Hash-hit reuse works in every migration phase
// ─────────────────────────────────────────────────────────────────────────────

describe("8. Hash-hit reuse during and after migration", () => {
  it("returns non-null asset with extractedText (pre-cutover / jsonb path)", async () => {
    delete process.env.EXTRACT_READ_CUTOVER;
    process.env.EXTRACT_SHADOW_READ = "false";

    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [makeDocRow()] });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(asset).not.toBeNull();
    expect(asset?.extractedText).toBe("Hello, world!");
    expect(asset?.documentStatus).toBe("ready");
  });

  it("returns version row text for HASH_HIT when EXTRACT_READ_CUTOVER=true", async () => {
    process.env.EXTRACT_READ_CUTOVER = "true";
    process.env.EXTRACT_SHADOW_READ  = "false";

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        ...makeDocRow(),
        v_extracted_text:        "normalized for reuse",
        v_extracted_text_status: "ready",
        v_extracted_at:          "2025-01-03T00:00:00.000Z",
        v_extraction_source:     "r2_pdf_parse",
      }],
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    expect(asset?.extractedText).toBe("normalized for reuse");
  });

  it("returns null for unknown file hash (no reuse)", async () => {
    process.env.EXTRACT_SHADOW_READ = "false";
    // mockQuery already returns { rowCount: 0, rows: [] } by default

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "unknown_hash" });

    expect(asset).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Retention cleanup archives doc AND purges version row extracted_text
// ─────────────────────────────────────────────────────────────────────────────

describe("9. Retention cleanup compatibility", () => {
  it("issues archival UPDATE and version purge UPDATE for each expired row", async () => {
    const expiredRow = {
      id:                  "doc-r",
      tenant_id:           "t-1",
      title:               "old.pdf",
      r2_key:              null,           // no R2 key → skip R2 delete
      asset_scope:         "temporary_chat",
      document_type:       "pdf",
      retention_mode:      "session",
      retention_expires_at: new Date("2020-01-01").toISOString(),
    };

    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [expiredRow] })  // SELECT expired
      .mockResolvedValue({ rowCount: 1, rows: [] });                // all subsequent UPDATEs + audit

    const { runRetentionCleanupBatch } = await import("../../server/lib/knowledge/retention-cleanup.ts");
    await runRetentionCleanupBatch({ batchSize: 10, dryRun: false });

    const allSql = (mockQuery.mock.calls as [string, unknown[]][]).map(([s]) => s);

    const hasArchival    = allSql.some(s => s.includes("lifecycle_state = 'archived'"));
    const hasVersionPurge = allSql.some(s =>
      s.includes("UPDATE knowledge_document_versions") &&
      s.includes("extracted_text        = NULL"),
    );

    expect(hasArchival).toBe(true);
    expect(hasVersionPurge).toBe(true);
  });

  it("dry-run: does not issue UPDATE queries", async () => {
    const expiredRow = {
      id: "doc-dry", tenant_id: "t-1", title: "dry.pdf",
      r2_key: null, asset_scope: "temporary_chat",
      document_type: "pdf", retention_mode: "session",
      retention_expires_at: new Date("2020-01-01").toISOString(),
    };

    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [expiredRow] });

    const { runRetentionCleanupBatch } = await import("../../server/lib/knowledge/retention-cleanup.ts");
    const result = await runRetentionCleanupBatch({ batchSize: 10, dryRun: true });

    // Only SELECT — no UPDATE queries
    const allSql = (mockQuery.mock.calls as [string, unknown[]][]).map(([s]) => s);
    expect(allSql.every(s => !s.includes("UPDATE knowledge_documents"))).toBe(true);
    expect(result.dbArchived).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Rollback: disabling flags restores jsonb-only read path
// ─────────────────────────────────────────────────────────────────────────────

describe("10. Rollback to jsonb-only read", () => {
  it("without EXTRACT_READ_CUTOVER, always returns jsonb text even when version row exists", async () => {
    delete process.env.EXTRACT_READ_CUTOVER;
    process.env.EXTRACT_SHADOW_READ = "false";

    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        ...makeDocRow(),
        v_extracted_text:        "normalized — should be ignored",
        v_extracted_text_status: "ready",
        v_extracted_at:          "2025-01-01T00:00:00.000Z",
        v_extraction_source:     "r2_pdf_parse",
      }],
    });

    const { findAssetByFileHash } = await import("../../server/lib/knowledge/chat-assets.ts");
    const asset = await findAssetByFileHash({ tenantId: "t-1", fileHash: "abc123" });

    // Must return jsonb-sourced text — not the normalized row
    expect(asset?.extractedText).toBe("Hello, world!");
  });

  it("EXTRACT_DUAL_WRITE=false: only the jsonb UPDATE is issued, no version INSERT", async () => {
    process.env.EXTRACT_DUAL_WRITE = "false";
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { patchAssetTranscript } = await import("../../server/lib/knowledge/chat-assets.ts");
    await patchAssetTranscript({
      assetId:             "doc-rb",
      tenantId:            "t-1",
      extractedText:       "text",
      extractedTextStatus: "ready",
    });

    // Exactly 1 query: the jsonb UPDATE
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE knowledge_documents");
    expect(sql).not.toContain("INSERT INTO knowledge_document_versions");
  });
});
