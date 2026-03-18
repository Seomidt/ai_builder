/**
 * Phase 5B.4 Validation — Email / HTML / Imported Content Ingestion
 * 16 validation scenarios covering all Tasks 1–16 from phase declaration.
 */

import { db } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import {
  chunkImportedContent,
  buildImportChunkKey,
  buildImportChunkHash,
  normalizeImportChunkText,
  summarizeImportChunks,
} from "./import-content-chunking";
import {
  parseImportedDocumentVersion,
  normalizeImportedDocument,
  summarizeImportParseResult,
  selectImportContentParser,
  SUPPORTED_HTML_MIME_TYPES,
  SUPPORTED_EMAIL_MIME_TYPES,
  SUPPORTED_TEXT_IMPORT_MIME_TYPES,
  SUPPORTED_IMPORT_MIME_TYPES,
  htmlImportParser,
  emailImportParser,
  textImportParser,
  type ImportParseResult,
} from "./import-content-parsers";

// ─── Test infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedSubstring: string, label: string): Promise<void> {
  try {
    await fn();
    console.error(`  ✗ FAIL: ${label} — expected async throw, but did not throw`);
    failed++;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${label} — expected "${expectedSubstring}" in "${msg}"`);
      failed++;
    }
  }
}

// ─── S1: DB columns for kdv ──────────────────────────────────────────────────

async function s1_dbColumns() {
  console.log("\nS1 — DB: kdv import parse columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_document_versions'
      AND column_name IN (
        'import_content_type','import_parse_status','import_parse_started_at',
        'import_parse_completed_at','import_parser_name','import_parser_version',
        'import_text_checksum','import_message_count','import_section_count',
        'import_link_count','import_failure_reason','source_language_code'
      )
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 12, "All 12 kdv import columns present", `found: ${cols.length}`);
}

// ─── S2: DB columns for kc ───────────────────────────────────────────────────

async function s2_kcColumns() {
  console.log("\nS2 — DB: kc import chunk columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
      AND column_name IN (
        'email_chunk','html_chunk','import_chunk_strategy','import_chunk_version',
        'message_index','thread_position','section_label','source_url',
        'sender_label','sent_at','quoted_content_included'
      )
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 11, "All 11 kc import chunk columns present", `found: ${cols.length}`);
}

// ─── S3: DB columns for kpj ──────────────────────────────────────────────────

async function s3_kpjColumns() {
  console.log("\nS3 — DB: kpj import processor columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_processing_jobs'
      AND column_name IN ('import_processor_name','import_processor_version')
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 2, "Both kpj import processor columns present", `found: ${cols.length}`);
}

// ─── S4: DB job_type CHECK includes import types ─────────────────────────────

async function s4_jobTypeCheck() {
  console.log("\nS4 — DB: job_type CHECK includes import_parse + import_chunk");
  const result = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) as def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'knowledge_processing_jobs' AND c.conname = 'kpj_job_type_check'
  `);
  const def = ((result.rows[0] as Record<string, string>)?.def ?? "");
  assert(def.includes("import_parse"), "job_type CHECK includes import_parse", def.slice(0, 80));
  assert(def.includes("import_chunk"), "job_type CHECK includes import_chunk", def.slice(0, 80));
}

// ─── S5: SUPPORTED mime type sets ────────────────────────────────────────────

function s5_mimeTypes() {
  console.log("\nS5 — Supported mime type sets");
  assert(SUPPORTED_HTML_MIME_TYPES.has("text/html"), "text/html in SUPPORTED_HTML_MIME_TYPES");
  assert(SUPPORTED_EMAIL_MIME_TYPES.has("message/rfc822"), "message/rfc822 in SUPPORTED_EMAIL_MIME_TYPES");
  assert(SUPPORTED_TEXT_IMPORT_MIME_TYPES.has("text/plain"), "text/plain in SUPPORTED_TEXT_IMPORT_MIME_TYPES");
  assert(SUPPORTED_IMPORT_MIME_TYPES.size >= 4, "SUPPORTED_IMPORT_MIME_TYPES has >= 4 types");
}

// ─── S6: HTML parser produces sections ───────────────────────────────────────

async function s6_htmlParser() {
  console.log("\nS6 — HTML parser: parse HTML with headings");
  const html = `
    <html>
      <body>
        <h1>Introduction</h1>
        <p>Welcome to our <a href="https://example.com">platform</a>.</p>
        <h2>Features</h2>
        <p>We support many features including AI-powered search.</p>
        <h2>Pricing</h2>
        <p>Contact us for pricing details.</p>
      </body>
    </html>
  `;
  const result = await parseImportedDocumentVersion(html, "text/html");
  assert(result.contentType === "html", "contentType=html");
  assert(result.parserName === "html_import_parser", "parserName=html_import_parser");
  assert(result.sectionCount >= 2, `sectionCount >= 2 (got ${result.sectionCount})`);
  assert(result.linkCount >= 1, `linkCount >= 1 (got ${result.linkCount})`);
  assert(result.textChecksum.length > 0, "textChecksum set");
  assert(result.messages.length === 0, "messages empty for HTML");
}

// ─── S7: Email parser produces messages ──────────────────────────────────────

async function s7_emailParser() {
  console.log("\nS7 — Email parser: parse RFC 822 email with headers");
  const email = `From: alice@example.com
To: bob@example.com
Subject: Project update
Date: Mon, 10 Mar 2025 09:00:00 +0000

Hi Bob,

Here is the latest update on the project. Things are progressing well.

Best,
Alice`;

  const result = await parseImportedDocumentVersion(email, "message/rfc822");
  assert(result.contentType === "email", "contentType=email");
  assert(result.parserName === "email_import_parser", "parserName=email_import_parser");
  assert(result.messageCount >= 1, `messageCount >= 1 (got ${result.messageCount})`);
  assert(result.messages.length >= 1, "messages.length >= 1");
  assert(result.messages[0].from?.includes("alice") ?? false, "from header extracted");
  assert(result.messages[0].subject?.includes("update") ?? false, "subject header extracted");
  assert(result.textChecksum.length > 0, "textChecksum set");
}

// ─── S8: Plain text import parser ────────────────────────────────────────────

async function s8_textImportParser() {
  console.log("\nS8 — Plain text import parser: parse paragraphs");
  const text = `First paragraph of imported text.

Second paragraph with more content here.

Third paragraph completes the document.`;

  const result = await parseImportedDocumentVersion(text, "text/plain");
  assert(result.contentType === "imported_text", "contentType=imported_text");
  assert(result.parserName === "text_import_parser", "parserName=text_import_parser");
  assert(result.sectionCount === 3, `sectionCount=3 (got ${result.sectionCount})`);
  assert(result.normalizedText.length > 0, "normalizedText non-empty");
}

// ─── S9: Unsupported mime type fails explicitly (INV-IMP11) ──────────────────

async function s9_unsupportedMimeRejected() {
  console.log("\nS9 — Unsupported mime type rejected explicitly (INV-IMP11)");
  await assertThrowsAsync(
    () => parseImportedDocumentVersion("some content", "application/pdf"),
    "INV-IMP11",
    "application/pdf triggers INV-IMP11",
  );
  await assertThrowsAsync(
    () => parseImportedDocumentVersion("some content", "audio/mpeg"),
    "INV-IMP11",
    "audio/mpeg triggers INV-IMP11",
  );
}

// ─── S10: Empty content fails explicitly ─────────────────────────────────────

async function s10_emptyContentRejected() {
  console.log("\nS10 — Empty content rejected explicitly (INV-IMP11)");
  await assertThrowsAsync(
    () => parseImportedDocumentVersion("", "text/html"),
    "INV-IMP11",
    "empty HTML triggers INV-IMP11",
  );
  await assertThrowsAsync(
    () => parseImportedDocumentVersion("   ", "message/rfc822"),
    "INV-IMP11",
    "whitespace-only email triggers INV-IMP11",
  );
}

// ─── S11: HTML chunking produces deterministic chunks ────────────────────────

async function s11_htmlChunking() {
  console.log("\nS11 — HTML chunking: html_sections strategy produces deterministic chunks");
  const html = `<h1>Section One</h1><p>Content for section one.</p><h2>Section Two</h2><p>Content for section two.</p>`;
  const result = await parseImportedDocumentVersion(html, "text/html");
  const chunks = chunkImportedContent(result, "doc-html", "ver-html", { strategy: "html_sections", version: "1.0" });

  assert(chunks.length >= 1, `chunks.length >= 1 (got ${chunks.length})`);
  assert(chunks[0].htmlChunk === true, "htmlChunk=true");
  assert(chunks[0].emailChunk === false, "emailChunk=false");
  assert(chunks[0].chunkKey.length === 32, "chunkKey is 32-char hex");
  assert(chunks[0].chunkHash.length === 32, "chunkHash is 32-char hex");
  assert(chunks[0].importChunkStrategy === "html_sections", "strategy=html_sections");
}

// ─── S12: Email chunking produces message-level chunks ───────────────────────

async function s12_emailChunking() {
  console.log("\nS12 — Email chunking: email_messages strategy preserves message context");
  const emailThread = `From: alice@example.com
To: bob@example.com
Subject: Thread start
Date: Mon, 10 Mar 2025 09:00:00 +0000

Hi Bob, starting the thread.

---

From: bob@example.com
To: alice@example.com
Subject: Re: Thread start
Date: Mon, 10 Mar 2025 10:00:00 +0000

Hi Alice, got your message.`;

  const result = await parseImportedDocumentVersion(emailThread, "message/rfc822");
  const chunks = chunkImportedContent(result, "doc-email", "ver-email", { strategy: "email_messages", version: "1.0" });

  assert(chunks.length >= 1, `chunks.length >= 1 (got ${chunks.length})`);
  assert(chunks[0].emailChunk === true, "emailChunk=true");
  assert(chunks[0].htmlChunk === false, "htmlChunk=false");
  assert(chunks[0].importChunkStrategy === "email_messages", "strategy=email_messages");
  assert(typeof chunks[0].messageIndex === "number", "messageIndex set");
}

// ─── S13: buildImportChunkKey determinism (INV-IMP10) ────────────────────────

function s13_chunkKeyDeterminism() {
  console.log("\nS13 — buildImportChunkKey is deterministic (INV-IMP10)");
  const k1 = buildImportChunkKey("doc-A", "ver-A", 0, "html_sections", "1.0");
  const k2 = buildImportChunkKey("doc-A", "ver-A", 0, "html_sections", "1.0");
  const k3 = buildImportChunkKey("doc-B", "ver-A", 0, "html_sections", "1.0");
  assert(k1 === k2, "Same inputs produce same key");
  assert(k1 !== k3, "Different documentId produces different key");
  assert(k1.length === 32, "chunkKey is 32-char hex");
}

// ─── S14: normalizeImportChunkText collapses whitespace ──────────────────────

function s14_normalizeChunkText() {
  console.log("\nS14 — normalizeImportChunkText collapses whitespace");
  const raw = "  Hello\n  world  \r\nfoo   bar  ";
  const normalized = normalizeImportChunkText(raw);
  assert(normalized === "Hello world foo bar", "Normalized correctly", `got "${normalized}"`);
}

// ─── S15: normalizeImportedDocument recomputes checksum ──────────────────────

async function s15_normalizeDocument() {
  console.log("\nS15 — normalizeImportedDocument sorts and recomputes checksum");
  const text = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.";
  const result = await parseImportedDocumentVersion(text, "text/plain");
  const normalized = normalizeImportedDocument(result);
  assert(typeof normalized === "object" && normalized !== null, "normalizeImportedDocument returns object");
  assert(normalized.textChecksum.length > 0, "textChecksum present after normalize");
  assert(normalized.sections.length === result.sections.length, "section count preserved");
}

// ─── S16: summarizeImportParseResult and summarizeImportChunks format ─────────

async function s16_summaries() {
  console.log("\nS16 — summarizeImportParseResult + summarizeImportChunks output format");
  const html = `<h1>Test</h1><p>Test content here for summary validation.</p>`;
  const result = await parseImportedDocumentVersion(html, "text/html");
  const parseSummary = summarizeImportParseResult(result);
  assert(typeof parseSummary === "string" && parseSummary.length > 0, "parse summary is non-empty string");
  assert(parseSummary.includes("parser="), "parse summary includes 'parser='");
  assert(parseSummary.includes("contentType="), "parse summary includes 'contentType='");

  const chunks = chunkImportedContent(result, "doc-sum", "ver-sum");
  const chunkSummary = summarizeImportChunks(chunks);
  assert(typeof chunkSummary === "string" && chunkSummary.length > 0, "chunk summary is non-empty string");
  assert(chunkSummary.includes("chunks="), "chunk summary includes 'chunks='");
  assert(chunkSummary.includes("strategy="), "chunk summary includes 'strategy='");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5B.4 Validation: Email / HTML / Imported Content Ingestion ===");

  await s1_dbColumns();
  await s2_kcColumns();
  await s3_kpjColumns();
  await s4_jobTypeCheck();
  s5_mimeTypes();
  await s6_htmlParser();
  await s7_emailParser();
  await s8_textImportParser();
  await s9_unsupportedMimeRejected();
  await s10_emptyContentRejected();
  await s11_htmlChunking();
  await s12_emailChunking();
  s13_chunkKeyDeterminism();
  s14_normalizeChunkText();
  await s15_normalizeDocument();
  await s16_summaries();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.error("VALIDATION FAILED");
    process.exit(1);
  } else {
    console.log("ALL VALIDATION PASSED ✓");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Validation runner error:", err);
  process.exit(1);
});
