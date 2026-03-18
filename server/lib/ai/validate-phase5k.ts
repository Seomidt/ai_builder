/**
 * validate-phase5k.ts — Phase 5K Validation Suite
 *
 * Tests real multimodal processors: OCR, caption, transcription,
 * video metadata, frame sampling. 20 scenarios, 90+ assertions.
 *
 * Run: npx tsx server/lib/ai/validate-phase5k.ts
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { eq, and } from "drizzle-orm";
import {
  knowledgeBases,
  knowledgeAssets,
  knowledgeAssetVersions,
  assetStorageObjects,
  knowledgeAssetProcessingJobs,
} from "@shared/schema";
import {
  loadAssetBinaryForProcessing,
  assertSupportedMimeType,
  normalizeExtractedText,
  normalizeCaptionText,
  normalizeTranscriptText,
  summarizeProcessorFailure,
  safeEnqueueDownstreamJob,
  explainProcessingEnvironmentCapabilities,
  ExplicitProcessorFailure,
  STORAGE_LOCAL_BASE,
  SUPPORTED_MIME_TYPES,
} from "./multimodal-processing-utils";
import {
  loadAllProcessors,
  listRegisteredProcessors,
  hasProcessor,
} from "../../services/asset-processing/asset_processor_registry";
import {
  ASSET_PIPELINES,
  getPipelineForAssetType,
  getNextJobType,
} from "../../services/asset-processing/asset_processing_pipeline";

// ─── Assertion helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let scenarioCount = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`    ✓ ${msg}`);
  } else {
    failed++;
    console.log(`    ✗ FAIL: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
}

function assertIncludes(arr: string[], val: string, msg: string): void {
  assert(arr.includes(val), `${msg} (array: ${JSON.stringify(arr)})`);
}

function assertType(val: unknown, type: string, msg: string): void {
  assert(typeof val === type, `${msg} (type: ${typeof val})`);
}

function scenario(name: string, num: number): void {
  scenarioCount++;
  console.log(`\n[S${String(num).padStart(2, "0")}] ${name}`);
}

// ─── Test data setup ──────────────────────────────────────────────────────────

const TEST_TENANT_ID = "test-5k-tenant-" + Date.now().toString(36);
const TEST_BUCKET = "test-5k-bucket";

type SqlRow = Record<string, unknown>;

async function setupTestTenant(): Promise<void> {
  // Create a minimal test tenant row (using knowledge_bases table)
  await db.insert(knowledgeBases).values({
    tenantId: TEST_TENANT_ID,
    name: "Phase 5K Test KB",
    slug: "phase-5k-test-" + Date.now().toString(36),
    description: "Validation test KB for Phase 5K",
    visibility: "private",
    lifecycleState: "active",
  });
}

async function createTestAsset(assetType: string, title: string): Promise<string> {
  const [asset] = await db.insert(knowledgeAssets).values({
    tenantId: TEST_TENANT_ID,
    knowledgeBaseId: (
      await db.select().from(knowledgeBases).where(eq(knowledgeBases.tenantId, TEST_TENANT_ID)).limit(1)
    )[0].id,
    assetType,
    sourceType: "upload",
    title,
    processingState: "pending",
  }).returning();
  return asset.id;
}

async function createTestVersion(assetId: string, mimeType: string, storageObjectId: string | null): Promise<string> {
  const [version] = await db.insert(knowledgeAssetVersions).values({
    tenantId: TEST_TENANT_ID,
    assetId,
    versionNumber: 1,
    ingestStatus: "ingested",
    mimeType,
    storageObjectId,
    isActive: true,
    metadata: {},
  }).returning();
  return version.id;
}

async function createTestStorageObject(
  mimeType: string,
  bucketName: string,
  objectKey: string,
  storageProvider: string = "local",
): Promise<string> {
  const [obj] = await db.insert(assetStorageObjects).values({
    tenantId: TEST_TENANT_ID,
    storageProvider,
    bucketName,
    objectKey,
    mimeType,
    sizeBytes: 1024,
    storageClass: "hot",
    checksumSha256: "test-checksum-5k",
  }).returning();
  return obj.id;
}

function createTinyJpeg(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Minimal valid JPEG (1x1 pixel, white) — raw bytes
  const jpegBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd2, 0x8a, 0x28, 0x03, 0xff, 0xd9,
  ]);
  fs.writeFileSync(filePath, jpegBytes);
}

function createTestMp4(filePath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Generate minimal test MP4 using ffmpeg
    const cmd = `ffmpeg -f lavfi -i "color=red:size=160x120:rate=5" -t 3 -c:v libx264 -pix_fmt yuv420p "${filePath}" -y 2>&1`;
    child_process.execSync(cmd, { timeout: 30000, encoding: "utf8" });
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  try {
    await db.delete(knowledgeAssetProcessingJobs).where(eq(knowledgeAssetProcessingJobs.tenantId, TEST_TENANT_ID));
    await db.delete(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.tenantId, TEST_TENANT_ID));
    await db.delete(assetStorageObjects).where(eq(assetStorageObjects.tenantId, TEST_TENANT_ID));
    await db.delete(knowledgeAssets).where(eq(knowledgeAssets.tenantId, TEST_TENANT_ID));
    await db.delete(knowledgeBases).where(eq(knowledgeBases.tenantId, TEST_TENANT_ID));
  } catch (e) {
    console.warn("Cleanup warning:", (e as Error).message);
  }

  // Clean up local test files
  try {
    const testDir = path.join(STORAGE_LOCAL_BASE, TEST_BUCKET);
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── Main validation ──────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Phase 5K Validation Suite ===\n");

  // Setup
  fs.mkdirSync(STORAGE_LOCAL_BASE, { recursive: true });
  await cleanup(); // clean any leftover state first
  await setupTestTenant();

  // Load processors
  await loadAllProcessors();

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Environment capability detection structure", 1);
  const caps = explainProcessingEnvironmentCapabilities();
  assert(typeof caps === "object" && caps !== null, "capabilities is an object");
  assert("openai" in caps, "capabilities.openai exists");
  assert("ffprobe" in caps, "capabilities.ffprobe exists");
  assert("ffmpeg" in caps, "capabilities.ffmpeg exists");
  assert("localStorage" in caps, "capabilities.localStorage exists");
  assert("summary" in caps, "capabilities.summary exists");
  assertType(caps.openai.available, "boolean", "openai.available is boolean (not faked)");
  assertType(caps.ffprobe.available, "boolean", "ffprobe.available is boolean");
  assertType(caps.ffmpeg.available, "boolean", "ffmpeg.available is boolean");
  assertType(caps.summary.ocrCapable, "boolean", "summary.ocrCapable is boolean");
  assertType(caps.summary.frameSamplingCapable, "boolean", "summary.frameSamplingCapable is boolean");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("assertSupportedMimeType — valid MIME types pass", 2);
  let noThrow = true;
  try { assertSupportedMimeType("ocr_image", "image/jpeg"); } catch { noThrow = false; }
  assert(noThrow, "ocr_image accepts image/jpeg");
  noThrow = true;
  try { assertSupportedMimeType("caption_image", "image/png"); } catch { noThrow = false; }
  assert(noThrow, "caption_image accepts image/png");
  noThrow = true;
  try { assertSupportedMimeType("transcribe_audio", "audio/wav"); } catch { noThrow = false; }
  assert(noThrow, "transcribe_audio accepts audio/wav");
  noThrow = true;
  try { assertSupportedMimeType("extract_video_metadata", "video/mp4"); } catch { noThrow = false; }
  assert(noThrow, "extract_video_metadata accepts video/mp4");
  noThrow = true;
  try { assertSupportedMimeType("sample_video_frames", "video/mp4"); } catch { noThrow = false; }
  assert(noThrow, "sample_video_frames accepts video/mp4");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("assertSupportedMimeType — unsupported MIME fails explicitly (INV-MPROC3)", 3);
  let threw: ExplicitProcessorFailure | null = null;
  try { assertSupportedMimeType("ocr_image", "video/mp4"); } catch (e) { threw = e as ExplicitProcessorFailure; }
  assert(threw !== null, "ocr_image rejects video/mp4");
  assert(threw instanceof ExplicitProcessorFailure, "error is ExplicitProcessorFailure");
  assertEq(threw?.failureCode, "UNSUPPORTED_MIME_TYPE", "failure code is UNSUPPORTED_MIME_TYPE");

  threw = null;
  try { assertSupportedMimeType("transcribe_audio", "image/jpeg"); } catch (e) { threw = e as ExplicitProcessorFailure; }
  assert(threw !== null, "transcribe_audio rejects image/jpeg");

  threw = null;
  try { assertSupportedMimeType("extract_video_metadata", "audio/mp4"); } catch (e) { threw = e as ExplicitProcessorFailure; }
  assert(threw !== null, "extract_video_metadata rejects audio/mp4");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("loadAssetBinaryForProcessing — file not found → explicit failure", 4);
  const storObjMissing = await createTestStorageObject("image/jpeg", TEST_BUCKET, "nonexistent/missing.jpg");
  let loadErr: ExplicitProcessorFailure | null = null;
  try {
    await loadAssetBinaryForProcessing(storObjMissing, TEST_TENANT_ID);
  } catch (e) {
    loadErr = e as ExplicitProcessorFailure;
  }
  assert(loadErr !== null, "loadAssetBinaryForProcessing throws when file missing");
  assert(loadErr instanceof ExplicitProcessorFailure, "error is ExplicitProcessorFailure");
  assertEq(loadErr?.failureCode, "FILE_NOT_FOUND", "failure code is FILE_NOT_FOUND");
  assert(!!(loadErr?.message ?? "").includes("Binary file not found"), "error message mentions binary file not found");
  assert(loadErr?.processorName === "storage", "processorName is 'storage'");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("loadAssetBinaryForProcessing — cross-tenant access denied (INV-MPROC12)", 5);
  const otherTenantStorObj = await createTestStorageObject("image/png", "other-bucket", "img.png");
  let tenantErr: ExplicitProcessorFailure | null = null;
  try {
    await loadAssetBinaryForProcessing(otherTenantStorObj, "completely-different-tenant-id");
  } catch (e) {
    tenantErr = e as ExplicitProcessorFailure;
  }
  assert(tenantErr !== null, "loadAssetBinaryForProcessing denies cross-tenant access");
  assert(tenantErr instanceof ExplicitProcessorFailure, "error is ExplicitProcessorFailure");
  assertEq(tenantErr?.failureCode, "STORAGE_OBJECT_NOT_FOUND", "cross-tenant access returns NOT_FOUND");
  assert(!!(tenantErr?.message ?? "").includes("INV-MPROC12"), "error references INV-MPROC12");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("loadAssetBinaryForProcessing — non-local provider fails explicitly", 6);
  const s3StorObj = await createTestStorageObject("image/jpeg", "my-s3-bucket", "key.jpg", "s3");
  let providerErr: ExplicitProcessorFailure | null = null;
  try {
    await loadAssetBinaryForProcessing(s3StorObj, TEST_TENANT_ID);
  } catch (e) {
    providerErr = e as ExplicitProcessorFailure;
  }
  assert(providerErr !== null, "non-local provider throws ExplicitProcessorFailure");
  assertEq(providerErr?.failureCode, "UNSUPPORTED_STORAGE_PROVIDER", "failure code is UNSUPPORTED_STORAGE_PROVIDER");
  assert(!!(providerErr?.message ?? "").includes("s3"), "error mentions unsupported provider name");
  assert(!(providerErr?.message ?? "").toLowerCase().includes("success"), "error does not claim success");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Text normalization helpers correctness", 7);
  assertEq(normalizeExtractedText("  Hello  World  "), "Hello World", "normalizeExtractedText collapses spaces");
  assertEq(normalizeExtractedText(null), "", "normalizeExtractedText handles null → empty string");
  assertEq(normalizeExtractedText(""), "", "normalizeExtractedText handles empty");
  assertEq(normalizeCaptionText("  Caption text  "), "Caption text", "normalizeCaptionText trims");
  assertEq(normalizeTranscriptText("Line one\r\nLine two"), "Line one\nLine two", "normalizeTranscriptText normalizes CRLF");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("summarizeProcessorFailure structure is correct", 8);
  const explicitErr = new ExplicitProcessorFailure("ocr_image", "TEST_CODE", "Test failure message");
  const summary = summarizeProcessorFailure("ocr_image", explicitErr, { context: "test" });
  assertEq(summary.processorName, "ocr_image", "summary.processorName set");
  assertEq(summary.failureCode, "TEST_CODE", "summary.failureCode set");
  assertEq(summary.errorMessage, "Test failure message", "summary.errorMessage set");
  assertEq(summary.isExplicit as boolean, true, "summary.isExplicit is true for ExplicitProcessorFailure");
  assert(typeof summary.failedAt === "string", "summary.failedAt is a string timestamp");

  const genericErr = new Error("Unexpected error");
  const genericSummary = summarizeProcessorFailure("test_proc", genericErr);
  assertEq(genericSummary.isExplicit as boolean, false, "genericSummary.isExplicit is false for generic Error");
  assertEq(genericSummary.failureCode, "UNEXPECTED_ERROR", "generic failure code is UNEXPECTED_ERROR");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("safeEnqueueDownstreamJob — first enqueue creates job", 9);
  const assetForEnqueue = await createTestAsset("document", "Enqueue Test Asset");
  const versionForEnqueue = await createTestVersion(assetForEnqueue, "application/pdf", null);

  const result1 = await safeEnqueueDownstreamJob(
    TEST_TENANT_ID,
    assetForEnqueue,
    versionForEnqueue,
    "chunk_text",
    "fake-trigger-job-id",
  );
  assert(result1.enqueued === true, "First enqueue creates job");
  assert(typeof result1.newJobId === "string" && result1.newJobId.length > 0, "newJobId returned");
  assert(result1.existingJobId === undefined, "No existingJobId on first enqueue");

  const enqueuedJobs = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.tenantId, TEST_TENANT_ID),
        eq(knowledgeAssetProcessingJobs.assetId, assetForEnqueue),
        eq(knowledgeAssetProcessingJobs.jobType, "chunk_text"),
      ),
    );
  assert(enqueuedJobs.length === 1, "Exactly 1 chunk_text job in DB");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("safeEnqueueDownstreamJob — idempotency: re-enqueue skips duplicate (INV-MPROC6)", 10);
  const result2 = await safeEnqueueDownstreamJob(
    TEST_TENANT_ID,
    assetForEnqueue,
    versionForEnqueue,
    "chunk_text",
    "fake-trigger-job-id-2",
  );
  assert(result2.enqueued === false, "Second enqueue is skipped (idempotent)");
  assert(typeof result2.existingJobId === "string", "existingJobId returned on skip");
  assert(result2.newJobId === undefined, "No newJobId on skip");

  const jobsAfterDuplicate = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.tenantId, TEST_TENANT_ID),
        eq(knowledgeAssetProcessingJobs.assetId, assetForEnqueue),
        eq(knowledgeAssetProcessingJobs.jobType, "chunk_text"),
      ),
    );
  assertEq(jobsAfterDuplicate.length, 1, "Still only 1 chunk_text job after duplicate enqueue attempt (INV-MPROC6)");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("OCR processor — real file OR explicit failure if OpenAI unavailable (INV-MPROC8)", 11);
  const ocrFilePath = path.join(STORAGE_LOCAL_BASE, TEST_BUCKET, "test-image.jpg");
  createTinyJpeg(ocrFilePath);
  const ocrStorObj = await createTestStorageObject("image/jpeg", TEST_BUCKET, "test-image.jpg");
  const ocrAsset = await createTestAsset("image", "OCR Test Image");
  const ocrVersion = await createTestVersion(ocrAsset, "image/jpeg", ocrStorObj);

  // Update asset currentVersionId
  await db.update(knowledgeAssets).set({ currentVersionId: ocrVersion }).where(eq(knowledgeAssets.id, ocrAsset));

  // Create a fake job record for the OCR processor context
  const [ocrJob] = await db.insert(knowledgeAssetProcessingJobs).values({
    tenantId: TEST_TENANT_ID,
    assetId: ocrAsset,
    assetVersionId: ocrVersion,
    jobType: "ocr_image",
    jobStatus: "queued",
    metadata: {},
  }).returning();

  const asset = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, ocrAsset)))[0];
  const version = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, ocrVersion)))[0];

  // Import and call the real OCR processor
  const { getProcessor } = await import("../../services/asset-processing/asset_processor_registry");
  const ocrProcessor = getProcessor("ocr_image");
  const ocrResult = await ocrProcessor({ job: ocrJob, asset, version, tenantId: TEST_TENANT_ID });

  assert(typeof ocrResult.success === "boolean", "OCR processor returns boolean success");
  assert(typeof ocrResult === "object", "OCR processor returns an object");

  // Re-read version to check metadata was written
  const ocrVersionAfter = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, ocrVersion)))[0];
  const ocrMeta = (ocrVersionAfter.metadata as Record<string, unknown> | null) ?? {};
  assert("ocr" in ocrMeta, "metadata.ocr key written (INV-MPROC5: additive write)");

  const ocrSection = ocrMeta.ocr as Record<string, unknown>;
  assert("engine_name" in ocrSection, "metadata.ocr.engine_name present");
  assert("processed_at" in ocrSection, "metadata.ocr.processed_at present");

  if (ocrResult.success) {
    assert(typeof ocrSection.extracted_text === "string", "OCR success: extracted_text is string");
    assert((ocrSection.extracted_text as string).length > 0, "OCR success: extracted_text non-empty");
    console.log(`      [OCR success: extracted ${(ocrSection.extracted_text as string).length} chars]`);
  } else {
    // Explicit failure — INV-MPROC8 verified
    assert("failure" in ocrSection, "OCR failure: metadata.ocr.failure key set");
    assert(typeof ocrResult.errorMessage === "string", "OCR failure: errorMessage is string");
    console.log(`      [OCR explicit failure: ${ocrResult.errorMessage?.slice(0, 80)}]`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Caption processor — real file OR explicit failure (INV-MPROC5: does not overwrite OCR)", 12);
  const captionFilePath = path.join(STORAGE_LOCAL_BASE, TEST_BUCKET, "caption-image.jpg");
  createTinyJpeg(captionFilePath);
  const captionStorObj = await createTestStorageObject("image/jpeg", TEST_BUCKET, "caption-image.jpg");
  const captionAsset = await createTestAsset("image", "Caption Test Image");
  const captionVersion = await createTestVersion(captionAsset, "image/jpeg", captionStorObj);

  // Pre-set an OCR metadata section to verify caption doesn't overwrite it
  await db.update(knowledgeAssetVersions)
    .set({ metadata: { ocr: { engine_name: "existing-ocr", extracted_text: "existing ocr text" } } })
    .where(eq(knowledgeAssetVersions.id, captionVersion));

  const [captionJob] = await db.insert(knowledgeAssetProcessingJobs).values({
    tenantId: TEST_TENANT_ID,
    assetId: captionAsset,
    assetVersionId: captionVersion,
    jobType: "caption_image",
    jobStatus: "queued",
    metadata: {},
  }).returning();

  const captionAssetRow = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, captionAsset)))[0];
  const captionVersionRow = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, captionVersion)))[0];
  const captionProcessor = getProcessor("caption_image");
  const captionResult = await captionProcessor({ job: captionJob, asset: captionAssetRow, version: captionVersionRow, tenantId: TEST_TENANT_ID });

  assert(typeof captionResult.success === "boolean", "Caption processor returns boolean success");

  const captionVersionAfter = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, captionVersion)))[0];
  const captionMeta = (captionVersionAfter.metadata as Record<string, unknown> | null) ?? {};
  assert("caption" in captionMeta, "metadata.caption key written (INV-MPROC5)");
  assert("ocr" in captionMeta, "metadata.ocr preserved — caption did NOT overwrite OCR (INV-MPROC5)");
  assertEq((captionMeta.ocr as Record<string, unknown>).engine_name as string, "existing-ocr", "OCR metadata intact after caption run");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Transcription processor — file not found → explicit failure with metadata written", 13);
  const audioStorObj = await createTestStorageObject("audio/wav", TEST_BUCKET, "nonexistent/audio.wav");
  const audioAsset = await createTestAsset("audio", "Transcription Test Audio");
  const audioVersion = await createTestVersion(audioAsset, "audio/wav", audioStorObj);

  const [audioJob] = await db.insert(knowledgeAssetProcessingJobs).values({
    tenantId: TEST_TENANT_ID,
    assetId: audioAsset,
    assetVersionId: audioVersion,
    jobType: "transcribe_audio",
    jobStatus: "queued",
    metadata: {},
  }).returning();

  const audioAssetRow = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, audioAsset)))[0];
  const audioVersionRow = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, audioVersion)))[0];
  const transcribeProcessor = getProcessor("transcribe_audio");
  const audioResult = await transcribeProcessor({ job: audioJob, asset: audioAssetRow, version: audioVersionRow, tenantId: TEST_TENANT_ID });

  assert(audioResult.success === false, "Transcription fails when file not found");
  assert(typeof audioResult.errorMessage === "string", "errorMessage is string");

  const audioVersionAfter = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, audioVersion)))[0];
  const audioMeta = (audioVersionAfter.metadata as Record<string, unknown> | null) ?? {};
  assert("transcript" in audioMeta, "metadata.transcript key written even on failure (INV-MPROC5)");
  const transcriptSec = audioMeta.transcript as Record<string, unknown>;
  assert("failure" in transcriptSec, "metadata.transcript.failure key set");
  assert(transcriptSec.transcript_text === null, "transcript_text is null on failure (INV-MPROC4)");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Video metadata processor — with real test MP4 if ffmpeg available", 14);
  const mp4FilePath = path.join(STORAGE_LOCAL_BASE, TEST_BUCKET, "test-video.mp4");
  const mp4Created = createTestMp4(mp4FilePath);
  const mp4StorObj = await createTestStorageObject("video/mp4", TEST_BUCKET, "test-video.mp4");
  const videoAsset = await createTestAsset("video", "Video Metadata Test");
  const videoVersion = await createTestVersion(videoAsset, "video/mp4", mp4StorObj);

  const [videoMetaJob] = await db.insert(knowledgeAssetProcessingJobs).values({
    tenantId: TEST_TENANT_ID,
    assetId: videoAsset,
    assetVersionId: videoVersion,
    jobType: "extract_video_metadata",
    jobStatus: "queued",
    metadata: {},
  }).returning();

  const videoAssetRow = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, videoAsset)))[0];
  const videoVersionRow = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, videoVersion)))[0];
  const videoMetaProcessor = getProcessor("extract_video_metadata");
  const videoMetaResult = await videoMetaProcessor({ job: videoMetaJob, asset: videoAssetRow, version: videoVersionRow, tenantId: TEST_TENANT_ID });

  assert(typeof videoMetaResult.success === "boolean", "Video metadata processor returns boolean success");

  const videoVersionAfter = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, videoVersion)))[0];
  const videoMeta = (videoVersionAfter.metadata as Record<string, unknown> | null) ?? {};
  assert("video" in videoMeta, "metadata.video key written (INV-MPROC5)");

  if (mp4Created && caps.ffprobe.available && videoMetaResult.success) {
    const videoSec = videoMeta.video as Record<string, unknown>;
    assert("duration_seconds" in videoSec, "metadata.video.duration_seconds present");
    assert("processed_at" in videoSec, "metadata.video.processed_at present");
    assert(typeof videoSec.duration_seconds === "number", "duration_seconds is a number");
    console.log(`      [Video metadata: duration=${videoSec.duration_seconds}s, codec=${videoSec.video_codec}]`);
  } else {
    assert(typeof videoMetaResult.errorMessage === "string", "Video metadata explicit failure: errorMessage is string");
    console.log(`      [Video metadata explicit failure: ${videoMetaResult.errorMessage?.slice(0, 80)}]`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Video frame sampling — with real test MP4 or explicit failure (INV-MPROC8)", 15);
  const [framesJob] = await db.insert(knowledgeAssetProcessingJobs).values({
    tenantId: TEST_TENANT_ID,
    assetId: videoAsset,
    assetVersionId: videoVersion,
    jobType: "sample_video_frames",
    jobStatus: "queued",
    metadata: {},
  }).returning();

  const framesVersionRow = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, videoVersion)))[0];
  const framesProcessor = getProcessor("sample_video_frames");
  const framesResult = await framesProcessor({ job: framesJob, asset: videoAssetRow, version: framesVersionRow, tenantId: TEST_TENANT_ID });

  assert(typeof framesResult.success === "boolean", "Frame sampling processor returns boolean success");

  const framesVersionAfter = (await db.select().from(knowledgeAssetVersions).where(eq(knowledgeAssetVersions.id, videoVersion)))[0];
  const framesMeta = (framesVersionAfter.metadata as Record<string, unknown> | null) ?? {};
  assert("video_frames" in framesMeta, "metadata.video_frames key written (INV-MPROC5)");

  if (mp4Created && caps.ffmpeg.available && framesResult.success) {
    const framesSec = framesMeta.video_frames as Record<string, unknown>;
    assert("frame_count" in framesSec, "metadata.video_frames.frame_count present");
    assert("sample_strategy" in framesSec, "metadata.video_frames.sample_strategy present");
    assert("generated_at" in framesSec, "metadata.video_frames.generated_at present");
    assert((framesSec.frame_count as number) > 0, "frame_count > 0");
    console.log(`      [Frame sampling: ${framesSec.frame_count} frames, strategy=${framesSec.sample_strategy}]`);
  } else {
    const framesSec = framesMeta.video_frames as Record<string, unknown>;
    assert("failure" in framesSec, "video_frames has failure key on explicit failure");
    console.log(`      [Frame sampling explicit failure — dependency not available or file missing]`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Video pipeline correctly defined with Phase 5K steps", 16);
  assert("video" in ASSET_PIPELINES, "ASSET_PIPELINES includes 'video' pipeline");
  const videoPipeline = ASSET_PIPELINES["video"];
  assertIncludes(videoPipeline.steps, "extract_video_metadata", "video pipeline includes extract_video_metadata");
  assertIncludes(videoPipeline.steps, "sample_video_frames", "video pipeline includes sample_video_frames");
  assertIncludes(videoPipeline.steps, "index_asset", "video pipeline includes index_asset");
  assertEq(videoPipeline.steps[0], "extract_video_metadata", "video pipeline entry is extract_video_metadata");
  assertEq(getNextJobType("video", "extract_video_metadata"), "sample_video_frames", "next after extract_video_metadata is sample_video_frames");
  assertEq(getNextJobType("video", "sample_video_frames"), "index_asset", "next after sample_video_frames is index_asset");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Registry: all Phase 5K real processors are registered", 17);
  const registered = listRegisteredProcessors();
  assertIncludes(registered, "ocr_image", "ocr_image registered");
  assertIncludes(registered, "caption_image", "caption_image registered");
  assertIncludes(registered, "transcribe_audio", "transcribe_audio registered");
  assertIncludes(registered, "extract_video_metadata", "extract_video_metadata registered");
  assertIncludes(registered, "sample_video_frames", "sample_video_frames registered");
  assert(hasProcessor("ocr_image"), "hasProcessor('ocr_image') = true");
  assert(hasProcessor("extract_video_metadata"), "hasProcessor('extract_video_metadata') = true");
  console.log(`      [Registered processors: ${registered.join(", ")}]`);

  // ─────────────────────────────────────────────────────────────────────────
  scenario("SUPPORTED_MIME_TYPES table is complete and accurate", 18);
  assert(SUPPORTED_MIME_TYPES["ocr_image"].length >= 3, "ocr_image supports at least 3 MIME types");
  assert(SUPPORTED_MIME_TYPES["transcribe_audio"].length >= 3, "transcribe_audio supports at least 3 MIME types");
  assert(SUPPORTED_MIME_TYPES["caption_image"].length >= 2, "caption_image supports at least 2 MIME types");
  assert(SUPPORTED_MIME_TYPES["extract_video_metadata"].length >= 2, "extract_video_metadata supports at least 2 MIME types");
  assert(SUPPORTED_MIME_TYPES["sample_video_frames"].length >= 2, "sample_video_frames supports at least 2 MIME types");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("INV-MPROC7: OCR/caption/transcription do not mark retrieval-ready", 19);
  // After running OCR/caption/transcription, check asset.processingState is NOT 'retrieval_ready'
  const ocrAssetAfter = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, ocrAsset)))[0];
  const captionAssetAfter = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, captionAsset)))[0];
  const audioAssetAfter = (await db.select().from(knowledgeAssets).where(eq(knowledgeAssets.id, audioAsset)))[0];

  assert(
    ocrAssetAfter.processingState !== "retrieval_ready",
    "OCR does not mark asset as retrieval_ready (INV-MPROC7)",
  );
  assert(
    captionAssetAfter.processingState !== "retrieval_ready",
    "Caption does not mark asset as retrieval_ready (INV-MPROC7)",
  );
  assert(
    audioAssetAfter.processingState !== "retrieval_ready",
    "Transcription does not mark asset as retrieval_ready (INV-MPROC7)",
  );

  // Verify index_asset is the canonical final step (INV-MPROC7)
  assert(getPipelineForAssetType("image").steps.at(-1) === "index_asset", "image pipeline final step is index_asset");
  assert(getPipelineForAssetType("audio").steps.at(-1) === "index_asset", "audio pipeline final step is index_asset");
  assert(getPipelineForAssetType("video").steps.at(-1) === "index_asset", "video pipeline final step is index_asset");

  // ─────────────────────────────────────────────────────────────────────────
  scenario("Existing retrieval / document stack intact (INV-MPROC9, INV-MPROC10)", 20);

  // Check core tables still exist
  const coreTablesResult = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'knowledge_retrieval_runs',
        'retrieval_metrics',
        'retrieval_cache_entries',
        'document_trust_signals',
        'document_risk_scores',
        'knowledge_asset_versions',
        'knowledge_assets',
        'knowledge_bases'
      )
    ORDER BY table_name
  `);
  const coreTablesFound = (coreTablesResult.rows as SqlRow[]).map((r) => r.table_name as string);

  assert(coreTablesFound.includes("knowledge_retrieval_runs"), "knowledge_retrieval_runs exists (INV-MPROC9)");
  assert(coreTablesFound.includes("retrieval_metrics"), "retrieval_metrics exists (INV-MPROC9)");
  assert(coreTablesFound.includes("document_trust_signals"), "document_trust_signals exists (INV-MPROC10)");
  assert(coreTablesFound.includes("document_risk_scores"), "document_risk_scores exists (INV-MPROC10)");
  assert(coreTablesFound.includes("knowledge_asset_versions"), "knowledge_asset_versions intact");

  // Check document pipeline unchanged
  const docPipeline = getPipelineForAssetType("document");
  assertEq(docPipeline.steps[0], "parse_document", "document pipeline: first step still parse_document");
  assertEq(docPipeline.steps.at(-1), "index_asset", "document pipeline: last step still index_asset");

  console.log(`      [Core tables confirmed: ${coreTablesFound.length}/8 found]`);
  console.log(`      [Document pipeline: ${docPipeline.steps.join(" → ")}]`);

  // ─────────────────────────────────────────────────────────────────────────
  // Final summary
  await cleanup();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 5K Validation Complete`);
  console.log(`Scenarios: ${scenarioCount}/20`);
  console.log(`Assertions: ${passed + failed} total — ${passed} passed, ${failed} failed`);
  console.log(`OpenAI available: ${caps.openai.available} | ffprobe: ${caps.ffprobe.available} | ffmpeg: ${caps.ffmpeg.available}`);
  if (failed > 0) {
    console.log(`\n✗ ${failed} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log(`\n✓ All ${passed} assertions passed`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Validation script error:", err);
    process.exit(1);
  });
