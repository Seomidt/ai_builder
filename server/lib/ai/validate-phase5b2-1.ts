/**
 * Phase 5B.2.1 validation script — 15 scenarios
 * Run with: npx tsx server/lib/ai/validate-phase5b2-1.ts
 */
import {
  selectOcrParser,
  computeOcrTextChecksum,
  normalizeOcrDocument,
  parseImageDocumentVersion,
  summarizeOcrParseResult,
  SUPPORTED_OCR_MIME_TYPES,
  stubOcrEngine,
  type OcrParseResult,
} from "./image-ocr-parsers";
import { openaiVisionOcrEngine } from "./openai-vision-ocr";
import { chunkOcrDocument, buildOcrChunkKey, buildOcrChunkHash } from "./image-ocr-chunking";
import { KnowledgeInvariantError } from "./knowledge-bases";

let passed = 0;
let failed = 0;

function ok(scenario: string, detail?: string) {
  passed++;
  console.log(`PASS [${scenario}]${detail ? ": " + detail : ""}`);
}

function fail(scenario: string, err: unknown) {
  failed++;
  console.error(`FAIL [${scenario}]: ${err instanceof Error ? err.message : String(err)}`);
}

const PLAIN_TEXT = `Invoice #12345
Date: 2026-03-13
Customer: ACME Corp
Item: Widget Pro x5
Unit price: 199.00
Total: 995.00
VAT (25%): 248.75
Grand total: 1243.75`;

const RAW_BASE64 = Buffer.from("fake-image-binary-data").toString("base64");
const DATA_URL = `data:image/png;base64,${RAW_BASE64}`;

async function run() {

  // ── Scenario 1: selectOcrParser returns openai_vision_ocr for all supported types ──
  try {
    const results: string[] = [];
    for (const mime of Array.from(SUPPORTED_OCR_MIME_TYPES)) {
      const p = selectOcrParser(mime);
      results.push(`${mime}→${p.name}`);
      if (p.name !== "openai_vision_ocr") throw new Error(`Expected openai_vision_ocr for ${mime}, got ${p.name}`);
    }
    ok("S1-select-parser-real-engine", results.join(", "));
  } catch (e) { fail("S1-select-parser-real-engine", e); }

  // ── Scenario 2: selectOcrParser with stub_ocr hint returns stub engine ─────
  try {
    const p = selectOcrParser("image/png", "stub_ocr");
    if (p.name === "stub_ocr" && p.version === "1.0") {
      ok("S2-stub-hint-override", `${p.name}@${p.version}`);
    } else {
      fail("S2-stub-hint-override", `Got ${p.name}@${p.version}`);
    }
  } catch (e) { fail("S2-stub-hint-override", e); }

  // ── Scenario 3: openai_vision_ocr engine properties correct ──────────────
  try {
    const e = openaiVisionOcrEngine;
    if (
      e.name === "openai_vision_ocr" &&
      e.version === "1.0" &&
      e.supportedMimeTypes.includes("image/png") &&
      e.supportedMimeTypes.includes("image/jpeg") &&
      e.supportedMimeTypes.includes("image/jpg") &&
      e.supportedMimeTypes.includes("image/webp") &&
      typeof e.parse === "function"
    ) {
      ok("S3-engine-properties", `name=${e.name} version=${e.version} types=${e.supportedMimeTypes.join(",")}`);
    } else {
      fail("S3-engine-properties", `mimeTypes=${e.supportedMimeTypes}`);
    }
  } catch (e) { fail("S3-engine-properties", e); }

  // ── Scenario 4: Plain text content goes through text fallback path ─────────
  try {
    const result = await openaiVisionOcrEngine.parse(PLAIN_TEXT, "image/png");
    if (
      result.engineName === "openai_vision_ocr" &&
      result.engineVersion === "1.0" &&
      result.regions.length > 0 &&
      result.blockCount > 0 &&
      result.warnings.some((w) => w.includes("plain_text_fallback"))
    ) {
      ok("S4-plain-text-fallback", `regions=${result.regions.length} path=plain_text_fallback warns=${result.warnings.length}`);
    } else {
      fail("S4-plain-text-fallback", `regions=${result.regions.length} warns=${JSON.stringify(result.warnings)}`);
    }
  } catch (e) { fail("S4-plain-text-fallback", e); }

  // ── Scenario 5: normalizeOcrDocument sets textChecksum ────────────────────
  try {
    const rawResult = await openaiVisionOcrEngine.parse(PLAIN_TEXT, "image/png");
    rawResult.textChecksum = "";
    const normalized = normalizeOcrDocument(rawResult);
    if (normalized.textChecksum && normalized.textChecksum.length === 24) {
      ok("S5-normalize-sets-checksum", `checksum=${normalized.textChecksum}`);
    } else {
      fail("S5-normalize-sets-checksum", `checksum='${normalized.textChecksum}'`);
    }
  } catch (e) { fail("S5-normalize-sets-checksum", e); }

  // ── Scenario 6: computeOcrTextChecksum is deterministic ───────────────────
  try {
    const result1 = await openaiVisionOcrEngine.parse(PLAIN_TEXT, "image/png");
    const result2 = await openaiVisionOcrEngine.parse(PLAIN_TEXT, "image/png");
    const c1 = computeOcrTextChecksum(result1);
    const c2 = computeOcrTextChecksum(result2);

    const altText = PLAIN_TEXT + "\nExtra line";
    const result3 = await openaiVisionOcrEngine.parse(altText, "image/png");
    const c3 = computeOcrTextChecksum(result3);

    if (c1 === c2 && c1 !== c3 && c1.length === 24) {
      ok("S6-checksum-deterministic", `c1=c2=${c1.slice(0, 12)} c1≠c3 (correct)`);
    } else {
      fail("S6-checksum-deterministic", `c1=${c1} c2=${c2} equal=${c1 === c2} differsOnChange=${c1 !== c3}`);
    }
  } catch (e) { fail("S6-checksum-deterministic", e); }

  // ── Scenario 7: summarizeOcrParseResult includes engine name ──────────────
  try {
    const result = await parseImageDocumentVersion(PLAIN_TEXT, "image/jpeg");
    const summary = summarizeOcrParseResult(result);
    if (
      summary.includes("openai_vision_ocr") &&
      summary.includes("blocks=") &&
      summary.includes("lines=") &&
      summary.includes("avgConf=") &&
      summary.includes("checksum=")
    ) {
      ok("S7-summarize-result", summary.slice(0, 100));
    } else {
      fail("S7-summarize-result", `summary=${summary}`);
    }
  } catch (e) { fail("S7-summarize-result", e); }

  // ── Scenario 8: Oversized content explicit rejection ──────────────────────
  try {
    const oversized = "X".repeat(200);
    let threw = false;
    try {
      await openaiVisionOcrEngine.parse(oversized, "image/png", { maxImageSizeBytes: 100 });
    } catch (e) {
      if (e instanceof KnowledgeInvariantError && e.message.includes("INV-IMG11")) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S8-oversized-explicit-rejection", "INV-IMG11 thrown for oversized content");
    } else {
      fail("S8-oversized-explicit-rejection", "No KnowledgeInvariantError thrown");
    }
  } catch (e) { fail("S8-oversized-explicit-rejection", e); }

  // ── Scenario 9: Empty content explicit rejection ───────────────────────────
  try {
    let threw = false;
    try {
      await openaiVisionOcrEngine.parse("", "image/webp");
    } catch (e) {
      if (e instanceof KnowledgeInvariantError && e.message.includes("INV-IMG11")) threw = true;
      else throw e;
    }
    if (threw) {
      ok("S9-empty-content-rejection", "INV-IMG11 thrown for empty content");
    } else {
      fail("S9-empty-content-rejection", "No error thrown for empty content");
    }
  } catch (e) { fail("S9-empty-content-rejection", e); }

  // ── Scenario 10: Unsupported mime types fail explicitly ────────────────────
  try {
    const unsupported = ["image/gif", "image/bmp", "image/tiff", "application/pdf", "text/csv"];
    const errors: string[] = [];
    for (const mime of unsupported) {
      try {
        selectOcrParser(mime);
        errors.push(`${mime}: no error thrown (FAIL)`);
      } catch (e) {
        if (e instanceof KnowledgeInvariantError && e.message.includes("INV-IMG11")) {
          // correct
        } else {
          errors.push(`${mime}: wrong error type`);
        }
      }
    }
    if (errors.length === 0) {
      ok("S10-unsupported-mime-explicit-fail", `${unsupported.length}/${unsupported.length} types correctly rejected`);
    } else {
      fail("S10-unsupported-mime-explicit-fail", errors.join("; "));
    }
  } catch (e) { fail("S10-unsupported-mime-explicit-fail", e); }

  // ── Scenario 11: parseImageDocumentVersion returns engine info correctly ───
  try {
    const result = await parseImageDocumentVersion(PLAIN_TEXT, "image/png");
    if (
      result.engineName === "openai_vision_ocr" &&
      result.textChecksum.length === 24 &&
      result.regions.every((r) => r.regionIndex >= 0 && r.pageNumber >= 1) &&
      result.regions.every((r) => r.confidence >= 0 && r.confidence <= 1)
    ) {
      ok("S11-parse-image-version-full", `engine=${result.engineName} checksum=${result.textChecksum.slice(0, 12)} regions=${result.regions.length}`);
    } else {
      fail("S11-parse-image-version-full", `checksum=${result.textChecksum} confidence_valid=${result.regions.every(r => r.confidence >= 0 && r.confidence <= 1)}`);
    }
  } catch (e) { fail("S11-parse-image-version-full", e); }

  // ── Scenario 12: parseImageDocumentVersion with engineHint=stub_ocr ───────
  try {
    const result = await parseImageDocumentVersion(PLAIN_TEXT, "image/png", { engineHint: "stub_ocr" });
    if (result.engineName === "stub_ocr" && result.engineVersion === "1.0") {
      ok("S12-engine-hint-stub-ocr", `routed to stub via hint: ${result.engineName}@${result.engineVersion}`);
    } else {
      fail("S12-engine-hint-stub-ocr", `got ${result.engineName}@${result.engineVersion}`);
    }
  } catch (e) { fail("S12-engine-hint-stub-ocr", e); }

  // ── Scenario 13: Bounding boxes present for plain text path ──────────────
  try {
    const result = await openaiVisionOcrEngine.parse(PLAIN_TEXT, "image/jpeg");
    const regionsWithBBox = result.regions.filter((r) => r.bbox);
    const allValid = regionsWithBBox.every(
      (r) =>
        r.bbox!.left >= 0 &&
        r.bbox!.top >= 0 &&
        r.bbox!.width > 0 &&
        r.bbox!.height > 0,
    );
    if (regionsWithBBox.length > 0 && allValid) {
      ok("S13-bounding-boxes-present", `${regionsWithBBox.length}/${result.regions.length} regions have valid bbox`);
    } else {
      fail("S13-bounding-boxes-present", `bboxCount=${regionsWithBBox.length} allValid=${allValid}`);
    }
  } catch (e) { fail("S13-bounding-boxes-present", e); }

  // ── Scenario 14: OCR result integrates correctly with chunkOcrDocument ────
  try {
    const result = await parseImageDocumentVersion(PLAIN_TEXT, "image/png");
    const docId = "doc-5b21-test";
    const verId = "ver-5b21-test";
    const chunks = chunkOcrDocument(result, docId, verId);

    if (
      chunks.length > 0 &&
      chunks.every((c) => c.chunkKey.length > 0 && c.chunkHash.length > 0 && c.chunkText.length > 0) &&
      chunks.every((c) => c.imageChunkStrategy === "ocr_regions") &&
      chunks.every((c) => c.ocrConfidence !== undefined && c.ocrConfidence! >= 0 && c.ocrConfidence! <= 1)
    ) {
      ok("S14-chunking-integration", `chunks=${chunks.length} avgConf=${(chunks.reduce((a, c) => a + (c.ocrConfidence ?? 0), 0) / chunks.length).toFixed(3)}`);
    } else {
      fail("S14-chunking-integration", `chunks=${chunks.length} missingFields=${chunks.filter(c => !c.chunkKey || !c.chunkHash).length}`);
    }
  } catch (e) { fail("S14-chunking-integration", e); }

  // ── Scenario 15: image/jpg treated identically to image/jpeg ──────────────
  try {
    const r1 = await parseImageDocumentVersion(PLAIN_TEXT, "image/jpeg");
    const r2 = await parseImageDocumentVersion(PLAIN_TEXT, "image/jpg");
    if (
      r1.engineName === "openai_vision_ocr" &&
      r2.engineName === "openai_vision_ocr" &&
      r1.mimeType === "image/jpeg" &&
      r2.mimeType === "image/jpg"
    ) {
      ok("S15-jpg-jpeg-both-supported", `jpeg regions=${r1.regions.length} jpg regions=${r2.regions.length}`);
    } else {
      fail("S15-jpg-jpeg-both-supported", `r1.engine=${r1.engineName} r2.engine=${r2.engineName}`);
    }
  } catch (e) { fail("S15-jpg-jpeg-both-supported", e); }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("========================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
