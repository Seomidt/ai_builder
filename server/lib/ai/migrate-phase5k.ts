/**
 * migrate-phase5k.ts — Phase 5K Database Migration
 *
 * Phase 5K does NOT require new schema columns or indexes.
 * All processor outputs are stored in the existing JSONB metadata column
 * of knowledge_asset_versions.
 *
 * This migration script:
 *  1. Verifies the existing schema supports Phase 5K metadata keys
 *  2. Verifies job_type CHECK constraint includes 5K job types
 *  3. Creates STORAGE_LOCAL_BASE directory for local file processing
 *  4. Reports environment capabilities
 *
 * Run: npx tsx server/lib/ai/migrate-phase5k.ts
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";

const STORAGE_LOCAL_BASE = process.env.STORAGE_LOCAL_BASE ?? "/tmp/asset-storage";

type SqlRow = Record<string, unknown>;

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ⚠ ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ✗ ${msg}`);
  process.exitCode = 1;
}

async function main() {
  console.log("\n=== Phase 5K Migration ===\n");

  // ─── Step 1: Schema verification ───────────────────────────────────────────

  console.log("1. Verifying knowledge_asset_versions schema...");

  const versionCols = await db.execute(sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'knowledge_asset_versions'
    ORDER BY ordinal_position
  `);

  const cols = versionCols.rows as SqlRow[];
  const colNames = cols.map((c) => c.column_name as string);

  const requiredCols = ["id", "tenant_id", "asset_id", "metadata", "mime_type", "storage_object_id", "is_active", "ingest_status"];
  for (const col of requiredCols) {
    if (colNames.includes(col)) {
      ok(`Column exists: ${col}`);
    } else {
      fail(`Missing column: ${col}`);
    }
  }

  const metaCol = cols.find((c) => c.column_name === "metadata");
  if (metaCol?.udt_name === "jsonb") {
    ok("metadata column is JSONB — supports 5K processor output keys (ocr, transcript, caption, video, video_frames)");
  } else {
    fail(`metadata column type unexpected: ${metaCol?.udt_name}`);
  }

  // ─── Step 2: Job type CHECK constraint ─────────────────────────────────────

  console.log("\n2. Verifying job_type CHECK constraint includes 5K types...");

  const constraints = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'knowledge_asset_processing_jobs'::regclass
      AND contype = 'c'
      AND conname LIKE '%job_type%'
    LIMIT 5
  `);

  const constraintRows = constraints.rows as SqlRow[];
  const constraintDef = constraintRows[0]?.definition as string ?? "";

  const phase5kJobTypes = ["extract_video_metadata", "sample_video_frames", "ocr_image", "transcribe_audio", "caption_image"];
  for (const jt of phase5kJobTypes) {
    if (constraintDef.includes(jt)) {
      ok(`job_type CHECK includes: ${jt}`);
    } else {
      warn(`job_type CHECK may not include: ${jt} — check schema`);
    }
  }

  if (!constraintDef) {
    warn("No job_type CHECK constraint found — may be unrestricted (acceptable if constraint was not added)");
  }

  // ─── Step 3: Video pipeline asset_type validation ──────────────────────────

  console.log("\n3. Verifying asset_type column accepts 'video'...");

  const assetTypeCheck = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'knowledge_assets'::regclass
      AND contype = 'c'
    LIMIT 10
  `);

  const assetTypeDef = (assetTypeCheck.rows as SqlRow[])
    .map((r) => r.definition as string)
    .find((d) => d.includes("asset_type") || d.includes("video")) ?? "";

  if (assetTypeDef.includes("video")) {
    ok("asset_type CHECK constraint includes 'video'");
  } else if (!assetTypeDef) {
    warn("No asset_type CHECK constraint found — unrestricted (acceptable)");
  } else {
    warn(`asset_type CHECK constraint may not include 'video': ${assetTypeDef.slice(0, 80)}`);
  }

  // ─── Step 4: Ensure local storage base directory exists ────────────────────

  console.log(`\n4. Ensuring STORAGE_LOCAL_BASE exists: ${STORAGE_LOCAL_BASE}...`);

  try {
    fs.mkdirSync(STORAGE_LOCAL_BASE, { recursive: true });
    ok(`Created/verified: ${STORAGE_LOCAL_BASE}`);
    fs.mkdirSync(path.join(STORAGE_LOCAL_BASE, "frames"), { recursive: true });
    ok(`Created/verified frames subdirectory`);
  } catch (e: unknown) {
    fail(`Failed to create storage directory: ${(e as Error).message}`);
  }

  // ─── Step 5: Environment capability detection ───────────────────────────────

  console.log("\n5. Detecting processing environment capabilities...");

  // OpenAI
  const apiKeyConfigured = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10);
  let openaiPackageAvailable = false;
  try {
    require("openai");
    openaiPackageAvailable = true;
    ok(`openai npm package available`);
  } catch {
    warn("openai npm package not found");
  }
  if (apiKeyConfigured) {
    ok("OPENAI_API_KEY configured");
  } else {
    warn("OPENAI_API_KEY not configured — OCR/caption/transcription will fail explicitly");
  }

  // ffprobe
  try {
    const ffprobeVer = child_process.execSync("ffprobe -version 2>&1", { timeout: 5000, encoding: "utf8" });
    const verMatch = ffprobeVer.match(/ffprobe version ([\d.]+)/);
    ok(`ffprobe available: version ${verMatch?.[1] ?? "unknown"}`);
  } catch {
    warn("ffprobe not found in PATH — video metadata extraction will fail explicitly");
  }

  // ffmpeg
  try {
    const ffmpegVer = child_process.execSync("ffmpeg -version 2>&1", { timeout: 5000, encoding: "utf8" });
    const verMatch = ffmpegVer.match(/ffmpeg version ([\d.]+)/);
    ok(`ffmpeg available: version ${verMatch?.[1] ?? "unknown"}`);
  } catch {
    warn("ffmpeg not found in PATH — frame sampling will fail explicitly");
  }

  // ─── Step 6: Phase 5K processor files present ──────────────────────────────

  console.log("\n6. Verifying Phase 5K processor files...");

  const processorFiles = [
    "server/services/asset-processing/processors/real-ocr-image.ts",
    "server/services/asset-processing/processors/real-transcribe-audio.ts",
    "server/services/asset-processing/processors/real-caption-image.ts",
    "server/services/asset-processing/processors/real-extract-video-metadata.ts",
    "server/services/asset-processing/processors/real-sample-video-frames.ts",
    "server/lib/ai/multimodal-processing-utils.ts",
  ];

  for (const f of processorFiles) {
    if (fs.existsSync(f)) {
      ok(`File exists: ${f}`);
    } else {
      fail(`Missing file: ${f}`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log("\n=== Phase 5K Migration Summary ===");
  console.log("Schema changes: NONE required (metadata stored in existing JSONB column)");
  console.log("New pipelines: video (extract_video_metadata → sample_video_frames → index_asset)");
  console.log("New processors: real-ocr-image, real-transcribe-audio, real-caption-image, real-extract-video-metadata, real-sample-video-frames");
  console.log(`Storage base: ${STORAGE_LOCAL_BASE}`);
  console.log(`OpenAI package: ${openaiPackageAvailable ? "AVAILABLE" : "NOT FOUND"}`);
  console.log(`OpenAI API key: ${apiKeyConfigured ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log("Migration complete.\n");
}

main()
  .then(() => {
    console.log("Done.");
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
