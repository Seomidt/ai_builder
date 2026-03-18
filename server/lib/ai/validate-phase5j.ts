/**
 * validate-phase5j.ts — Phase 5J Validation Suite
 *
 * 20 scenarios, 90+ assertions covering:
 *  S01 - Schema/DB column verification
 *  S02 - DB index verification
 *  S03 - Storage registration (INV-ING5/6)
 *  S04 - Storage dedup preview (INV-ING9)
 *  S05 - Deleted storage block (INV-ING10)
 *  S06 - New asset ingestion full flow
 *  S07 - Processing plan explains correctly
 *  S08 - Preview ingestion performs no writes (INV-ING8)
 *  S09 - Version append-only (INV-ING3)
 *  S10 - setCurrentAssetVersion cross-asset guard (INV-ING4)
 *  S11 - setCurrentAssetVersion blocks deleted storage (INV-ING10)
 *  S12 - Deleted asset version guard
 *  S13 - Cross-tenant isolation (INV-ING1/6)
 *  S14 - KB scope check (INV-ING2)
 *  S15 - explainKnowledgeAssetIngestion observability
 *  S16 - Storage object explain (pure function)
 *  S17 - Multi-version flow
 *  S18 - Ingestion without auto-enqueue
 *  S19 - Storage reuse (same bucket+key same tenant)
 *  S20 - Phase 5I/12 retrieval stack intact
 *
 * Usage: npx tsx server/lib/ai/validate-phase5j.ts
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { eq, and } from "drizzle-orm";
import {
  knowledgeBases,
  knowledgeAssets,
  knowledgeAssetVersions,
  assetStorageObjects,
  knowledgeAssetProcessingJobs,
} from "@shared/schema";
import {
  registerKnowledgeStorageObject,
  findKnowledgeStorageObjectByLocation,
  getKnowledgeStorageObjectById,
  explainKnowledgeStorageObjectData,
  previewStorageBinding,
  markStorageObjectDeleted,
} from "./knowledge-storage";
import {
  ingestKnowledgeAsset,
  ingestKnowledgeAssetVersion,
  previewKnowledgeAssetIngestion,
  setCurrentAssetVersion,
  explainKnowledgeAssetIngestion,
  listKnowledgeAssetVersions,
  explainAssetProcessingPlan,
} from "./knowledge-asset-ingestion";
import { getPipelineForAssetType } from "../../services/asset-processing/asset_processing_pipeline";
import { listAssetProcessingJobs } from "./knowledge-asset-processing";

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${message}`);
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const msg = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(`FAIL: ${msg}`);
    console.error(`  ✗ ${msg}`);
  }
}

function ok(message: string) {
  console.log(`  ✓ ${message}`);
}

async function scenario(name: string, fn: () => Promise<void>) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    const msg = `${name} threw: ${(e as Error).message}`;
    failures.push(`FAIL: ${msg}`);
    console.error(`  ✗ EXCEPTION: ${(e as Error).message}`);
  }
}

// ─── Seed fixtures ────────────────────────────────────────────────────────────

const TENANT_A = `test-tenant-5j-${Date.now()}`;
const TENANT_B = `test-tenant-5j-b-${Date.now()}`;
const BUCKET = "test-bucket-5j";

let kbId: string;
let kbIdB: string;

async function setupFixtures() {
  console.log("Setting up fixtures...");

  // Create KBs for both tenants
  const [kb] = await db
    .insert(knowledgeBases)
    .values({ tenantId: TENANT_A, name: "Test KB 5J A", slug: `test-kb-5j-a-${Date.now()}` } as any)
    .returning();
  kbId = kb.id;

  const [kbB] = await db
    .insert(knowledgeBases)
    .values({ tenantId: TENANT_B, name: "Test KB 5J B", slug: `test-kb-5j-b-${Date.now()}` } as any)
    .returning();
  kbIdB = kbB.id;

  console.log(`  KB-A: ${kbId} | KB-B: ${kbIdB}`);
}

async function teardownFixtures() {
  console.log("\nCleaning up fixtures...");
  // Clean jobs, versions, assets, storage objects for test tenants
  for (const t of [TENANT_A, TENANT_B]) {
    await db.execute(
      sql.raw(`DELETE FROM knowledge_asset_processing_jobs WHERE tenant_id='${t}'`),
    );
    await db.execute(sql.raw(`DELETE FROM knowledge_asset_versions WHERE tenant_id='${t}'`));
    await db.execute(sql.raw(`DELETE FROM knowledge_assets WHERE tenant_id='${t}'`));
    await db.execute(sql.raw(`DELETE FROM asset_storage_objects WHERE tenant_id='${t}'`));
    await db.execute(sql.raw(`DELETE FROM knowledge_bases WHERE tenant_id='${t}'`));
  }
  console.log("  Fixtures removed.");
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function runScenarios() {
  await setupFixtures();

  // ─── S01: Schema/DB column verification ──────────────────────────────────────
  await scenario("S01 — DB schema columns (Phase 5J)", async () => {
    const colChecks = [
      ["knowledge_assets", "updated_by"],
      ["knowledge_asset_versions", "tenant_id"],
      ["knowledge_asset_versions", "ingest_status"],
      ["knowledge_asset_versions", "source_upload_id"],
      ["knowledge_asset_versions", "is_active"],
      ["asset_storage_objects", "uploaded_at"],
      ["knowledge_asset_processing_jobs", "created_by"],
    ];
    for (const [table, col] of colChecks) {
      const r = await db.execute(
        sql.raw(
          `SELECT column_name FROM information_schema.columns WHERE table_name='${table}' AND column_name='${col}'`,
        ),
      );
      const found = (r as any).rows?.length > 0 || (r as any).length > 0;
      assert(found, `Column ${table}.${col} exists in DB`);
      if (found) ok(`${table}.${col} exists`);
    }
  });

  // ─── S02: DB index verification ───────────────────────────────────────────────
  await scenario("S02 — DB indexes (Phase 5J)", async () => {
    const expectedIndexes = [
      "ka_tenant_kb_type_idx",
      "ka_tenant_current_version_idx",
      "kav_tenant_checksum_partial_idx",
      "kapj_tenant_asset_status_idx",
      "kapj_tenant_version_type_idx",
    ];
    for (const name of expectedIndexes) {
      const r = await db.execute(
        sql.raw(`SELECT indexname FROM pg_indexes WHERE indexname='${name}'`),
      );
      const found = (r as any).rows?.length > 0 || (r as any).length > 0;
      assert(found, `Index ${name} exists`);
      if (found) ok(`Index ${name} exists`);
    }
  });

  // ─── S03: Storage registration ────────────────────────────────────────────────
  await scenario("S03 — registerKnowledgeStorageObject (INV-ING5/6)", async () => {
    const obj = await registerKnowledgeStorageObject({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s03/test.pdf",
      sizeBytes: 1024,
      mimeType: "application/pdf",
      checksumSha256: "abc123def456",
    });
    assert(!!obj.id, "Storage object has id");
    assertEqual(obj.tenantId, TENANT_A, "Tenant matches (INV-ING5)");
    assertEqual(obj.storageProvider, "local", "Provider stored correctly");
    assertEqual(obj.sizeBytes, 1024, "Size stored correctly");
    assertEqual(obj.storageClass, "hot", "Default storage class is hot");
    assert(obj.checksumSha256 === "abc123def456", "Checksum stored");
    ok(`Storage object ${obj.id} registered`);

    // Validate missing tenantId rejected
    try {
      await registerKnowledgeStorageObject({
        tenantId: "",
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s03/test-noauth.pdf",
        sizeBytes: 512,
      });
      assert(false, "Should reject empty tenantId");
    } catch (e) {
      assert(true, "Empty tenantId correctly rejected (INV-ING5)");
      ok("Empty tenantId rejected");
    }
  });

  // ─── S04: Storage dedup preview ───────────────────────────────────────────────
  await scenario("S04 — previewStorageBinding (INV-ING9, INV-ING8)", async () => {
    // Register something first
    await registerKnowledgeStorageObject({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s04/existing.pdf",
      sizeBytes: 2048,
      checksumSha256: "dupe-checksum-s04",
    });

    const previewNew = await previewStorageBinding({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s04/new-file.pdf",
      sizeBytes: 512,
      checksumSha256: "dupe-checksum-s04",
    });
    assertEqual(previewNew.wouldWrite, false, "Preview does not write (INV-ING8)");
    assert(previewNew.isNew, "New location detected");
    assert(previewNew.duplicateChecksumDetected, "Duplicate checksum detected (INV-ING9)");
    assert(previewNew.duplicateChecksumCount > 0, "Duplicate count > 0");
    ok(`Preview detected duplicate checksum (count: ${previewNew.duplicateChecksumCount})`);

    const previewExisting = await previewStorageBinding({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s04/existing.pdf",
      sizeBytes: 2048,
    });
    assert(!previewExisting.isNew, "Existing location detected");
    assert(!!previewExisting.existingObjectId, "Returns existing id");
    ok(`Preview found existing object: ${previewExisting.existingObjectId}`);
  });

  // ─── S05: Deleted storage block ───────────────────────────────────────────────
  await scenario("S05 — deleted storage object blocked (INV-ING10)", async () => {
    const deletable = await registerKnowledgeStorageObject({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s05/to-delete.pdf",
      sizeBytes: 512,
    });
    await markStorageObjectDeleted(deletable.id, TENANT_A);

    try {
      await ingestKnowledgeAsset({
        tenantId: TENANT_A,
        knowledgeBaseId: kbId,
        assetType: "document",
        sourceType: "upload",
        storage: {
          storageProvider: "local",
          bucketName: BUCKET,
          objectKey: "s05/to-delete.pdf",
          sizeBytes: 512,
        },
        autoEnqueueProcessing: false,
      });
      assert(false, "Should block ingestion with deleted storage object");
    } catch (e) {
      assert(
        (e as Error).message.includes("deleted"),
        "Error message mentions deleted storage (INV-ING10)",
      );
      ok("Deleted storage object rejected for ingestion (INV-ING10)");
    }
  });

  // ─── S06: New asset ingestion full flow ───────────────────────────────────────
  let assetId6: string;
  let versionId6: string;
  await scenario("S06 — ingestKnowledgeAsset full flow", async () => {
    const result = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "upload",
      title: "Test PDF S06",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s06/report.pdf",
        sizeBytes: 8192,
        mimeType: "application/pdf",
        checksumSha256: "sha256-s06-unique",
      },
      createdBy: "tester",
      autoSetCurrent: true,
      autoEnqueueProcessing: true,
    });

    assert(result.success, "Ingestion succeeded");
    assert(!!result.assetId, "Asset ID returned");
    assert(!!result.versionId, "Version ID returned");
    assertEqual(result.versionNumber, 1, "First version is v1");
    assert(result.isNewAsset, "isNewAsset = true");
    assert(result.currentVersionSet, "Current version set");
    assert(result.processingJobsEnqueued > 0, "Processing jobs enqueued");
    assert(!!result.processingEntryJobType, "Entry job type returned");
    assert(!!result.storageObjectId, "Storage object ID returned");
    assert(!result.existingStorageObjectReused, "New storage object created");
    assert(result.processingPlan.totalSteps > 0, "Processing plan has steps");

    assetId6 = result.assetId;
    versionId6 = result.versionId;
    ok(`Asset ${assetId6} (v${result.versionNumber}) ingested — jobs: ${result.processingJobsEnqueued}`);

    // Verify DB state
    const [asset] = await db
      .select()
      .from(knowledgeAssets)
      .where(eq(knowledgeAssets.id, assetId6));
    assert(!!asset, "Asset row exists in DB");
    assertEqual(asset.tenantId, TENANT_A, "Asset tenant matches");
    assertEqual(asset.currentVersionId, versionId6, "Current version set on asset");
    assertEqual(asset.processingState, "processing", "Asset processing state = processing");

    const [version] = await db
      .select()
      .from(knowledgeAssetVersions)
      .where(eq(knowledgeAssetVersions.id, versionId6));
    assert(!!version, "Version row exists in DB");
    assertEqual((version as any).tenantId, TENANT_A, "Version tenant matches");
    assertEqual((version as any).ingestStatus, "processing", "Version ingestStatus = processing");
    ok("DB state verified for S06");
  });

  // ─── S07: Processing plan explains correctly ──────────────────────────────────
  await scenario("S07 — explainAssetProcessingPlan", async () => {
    for (const type of ["document", "image", "audio", "video"]) {
      const plan = explainAssetProcessingPlan(type);
      assert(plan.assetType === type, `Plan type = ${type}`);
      assert(plan.totalSteps > 0, `Plan has steps for ${type}`);
      assert(plan.steps.length === plan.totalSteps, `Steps array matches totalSteps for ${type}`);
      assert(plan.activeSteps >= 0, `activeSteps >= 0 for ${type}`);
      assert(plan.plannedSteps >= 0, `plannedSteps >= 0 for ${type}`);
      assert(plan.activeSteps + plan.plannedSteps === plan.totalSteps, `Step counts sum correctly for ${type}`);
      ok(`Plan for ${type}: ${plan.totalSteps} total, ${plan.activeSteps} active, entry=${plan.entryJobType}`);
    }

    const docPlan = explainAssetProcessingPlan("document");
    assert(docPlan.entryJobType === "parse_document", "Document plan starts with parse_document");
    assert(docPlan.steps[0].isEntryPoint, "First step is entry point");
  });

  // ─── S08: Preview ingestion performs no writes ────────────────────────────────
  await scenario("S08 — previewKnowledgeAssetIngestion (INV-ING8)", async () => {
    const countBefore = await db
      .select()
      .from(knowledgeAssets)
      .where(eq(knowledgeAssets.tenantId, TENANT_A));

    const preview = await previewKnowledgeAssetIngestion({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s08/preview-test.pdf",
        sizeBytes: 1024,
      },
    });

    assertEqual(preview.wouldWrite, false, "Preview wouldWrite = false (INV-ING8)");
    assert(preview.kbExists, "Preview detects KB exists");
    assert(!!preview.processingPlan, "Preview includes processing plan");

    const countAfter = await db
      .select()
      .from(knowledgeAssets)
      .where(eq(knowledgeAssets.tenantId, TENANT_A));
    assertEqual(countAfter.length, countBefore.length, "No new assets written by preview (INV-ING8)");

    // Missing KB
    const badPreview = await previewKnowledgeAssetIngestion({
      tenantId: TENANT_A,
      knowledgeBaseId: "nonexistent-kb-id",
      assetType: "document",
      sourceType: "upload",
    });
    assert(!badPreview.kbExists, "Preview detects missing KB");
    assert(badPreview.validationErrors.length > 0, "Preview lists validation errors");
    ok("Preview correctly reports validation errors without writing");
  });

  // ─── S09: Version append-only (INV-ING3) ──────────────────────────────────────
  await scenario("S09 — version append-only/monotonic (INV-ING3)", async () => {
    // Use asset from S06
    const result2 = await ingestKnowledgeAssetVersion({
      tenantId: TENANT_A,
      assetId: assetId6,
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s09/report-v2.pdf",
        sizeBytes: 10240,
        mimeType: "application/pdf",
      },
      autoEnqueueProcessing: false,
    });
    assertEqual(result2.versionNumber, 2, "Second version is v2 (INV-ING3)");
    assert(!result2.isNewAsset, "isNewAsset = false for second version");

    const result3 = await ingestKnowledgeAssetVersion({
      tenantId: TENANT_A,
      assetId: assetId6,
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s09/report-v3.pdf",
        sizeBytes: 10240,
      },
      autoEnqueueProcessing: false,
    });
    assertEqual(result3.versionNumber, 3, "Third version is v3 (INV-ING3)");
    ok("Versions are monotonically increasing (INV-ING3)");

    const versions = await listKnowledgeAssetVersions(assetId6, TENANT_A);
    assert(versions.length >= 3, "At least 3 versions found");
    const vNums = versions.map((v) => v.versionNumber);
    for (let i = 1; i < vNums.length; i++) {
      assert(vNums[i] > vNums[i - 1], `Version ${vNums[i]} > ${vNums[i - 1]} (monotonic)`);
    }
    ok(`Versions: [${vNums.join(", ")}] all monotonically increasing`);
  });

  // ─── S10: setCurrentAssetVersion cross-asset guard (INV-ING4) ────────────────
  await scenario("S10 — setCurrentAssetVersion cross-asset guard (INV-ING4)", async () => {
    // Create a second asset to get a version from it
    const result2 = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "image",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s10/image.png",
        sizeBytes: 512,
        mimeType: "image/png",
      },
      autoEnqueueProcessing: false,
    });
    const asset2Id = result2.assetId;
    const version2Id = result2.versionId;

    // Try to set asset6's current version to version2 (belongs to asset2)
    try {
      await setCurrentAssetVersion(assetId6, version2Id, TENANT_A);
      assert(false, "Should reject cross-asset version assignment");
    } catch (e) {
      assert(
        (e as Error).message.includes("INV-ING4") ||
        (e as Error).message.includes("does not belong"),
        "Error references INV-ING4",
      );
      ok("Cross-asset version assignment rejected (INV-ING4)");
    }
  });

  // ─── S11: setCurrentAssetVersion blocks deleted storage ──────────────────────
  await scenario("S11 — setCurrentAssetVersion blocks deleted storage (INV-ING10)", async () => {
    // Create asset with storage, then delete the storage object
    const r = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s11/will-delete.pdf",
        sizeBytes: 1024,
      },
      autoSetCurrent: false,
      autoEnqueueProcessing: false,
    });

    // Delete the storage object
    await markStorageObjectDeleted(r.storageObjectId, TENANT_A);

    try {
      await setCurrentAssetVersion(r.assetId, r.versionId, TENANT_A);
      assert(false, "Should block: storage is deleted (INV-ING10)");
    } catch (e) {
      assert(
        (e as Error).message.includes("deleted") || (e as Error).message.includes("INV-ING10"),
        "Error references deleted storage (INV-ING10)",
      );
      ok("setCurrentAssetVersion blocked with deleted storage (INV-ING10)");
    }
  });

  // ─── S12: Deleted asset version guard ────────────────────────────────────────
  await scenario("S12 — cannot add version to deleted asset", async () => {
    // Create then delete an asset
    const r = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "audio",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s12/deleted-asset.mp3",
        sizeBytes: 4096,
      },
      autoEnqueueProcessing: false,
    });

    // Mark as deleted in DB
    await db
      .update(knowledgeAssets)
      .set({ lifecycleState: "deleted" })
      .where(eq(knowledgeAssets.id, r.assetId));

    try {
      await ingestKnowledgeAssetVersion({
        tenantId: TENANT_A,
        assetId: r.assetId,
        storage: {
          storageProvider: "local",
          bucketName: BUCKET,
          objectKey: "s12/deleted-asset-v2.mp3",
          sizeBytes: 4096,
        },
        autoEnqueueProcessing: false,
      });
      assert(false, "Should block versioning of deleted asset");
    } catch (e) {
      assert(
        (e as Error).message.includes("deleted"),
        "Error mentions deleted asset",
      );
      ok("Version addition blocked for deleted asset");
    }
  });

  // ─── S13: Cross-tenant isolation ─────────────────────────────────────────────
  await scenario("S13 — cross-tenant isolation (INV-ING1/6)", async () => {
    // Register storage object for TENANT_A
    const obj = await registerKnowledgeStorageObject({
      tenantId: TENANT_A,
      storageProvider: "local",
      bucketName: BUCKET,
      objectKey: "s13/tenant-a-file.pdf",
      sizeBytes: 1024,
    });

    // TENANT_B should not find it
    const found = await getKnowledgeStorageObjectById(obj.id, TENANT_B);
    assert(found === null, "TENANT_B cannot see TENANT_A storage object (INV-ING6)");
    ok("Cross-tenant storage object isolation confirmed (INV-ING6)");

    // TENANT_B cannot ingest using TENANT_A's KB
    try {
      await ingestKnowledgeAsset({
        tenantId: TENANT_B,
        knowledgeBaseId: kbId, // kbId belongs to TENANT_A
        assetType: "document",
        sourceType: "upload",
        storage: {
          storageProvider: "local",
          bucketName: BUCKET,
          objectKey: "s13/b-attempt.pdf",
          sizeBytes: 512,
        },
        autoEnqueueProcessing: false,
      });
      assert(false, "Should reject TENANT_B using TENANT_A KB");
    } catch (e) {
      assert(true, "TENANT_B correctly blocked from TENANT_A KB (INV-ING1/2)");
      ok("Cross-tenant KB access blocked (INV-ING1/2)");
    }
  });

  // ─── S14: KB scope check ──────────────────────────────────────────────────────
  await scenario("S14 — missing KB rejected (INV-ING2)", async () => {
    try {
      await ingestKnowledgeAsset({
        tenantId: TENANT_A,
        knowledgeBaseId: "00000000-0000-0000-0000-000000000000",
        assetType: "document",
        sourceType: "upload",
        storage: {
          storageProvider: "local",
          bucketName: BUCKET,
          objectKey: "s14/no-kb.pdf",
          sizeBytes: 512,
        },
        autoEnqueueProcessing: false,
      });
      assert(false, "Should reject nonexistent KB");
    } catch (e) {
      assert(
        (e as Error).message.includes("INV-ING2") ||
        (e as Error).message.includes("not found"),
        "Error references KB not found (INV-ING2)",
      );
      ok("Nonexistent KB correctly rejected (INV-ING2)");
    }
  });

  // ─── S15: explainKnowledgeAssetIngestion ─────────────────────────────────────
  await scenario("S15 — explainKnowledgeAssetIngestion observability", async () => {
    const explain = await explainKnowledgeAssetIngestion(assetId6, TENANT_A);
    assert(explain.assetId === assetId6, "Asset ID in explain");
    assert(explain.tenantId === TENANT_A, "Tenant in explain");
    assert(typeof explain.versionCount === "number", "versionCount is number");
    assert((explain.versionCount as number) >= 1, "At least 1 version");
    assert(Array.isArray(explain.versions), "versions is array");
    assert(Array.isArray(explain.explanation), "explanation is array");
    assert(typeof explain.processingJobs === "object", "processingJobs present");
    assert(!!explain.processingPlan, "processingPlan included");
    ok(`Explain: ${explain.versionCount} versions, ${(explain.processingJobs as any).total} jobs`);

    // Wrong tenant
    try {
      await explainKnowledgeAssetIngestion(assetId6, TENANT_B);
      assert(false, "Should reject wrong tenant");
    } catch (e) {
      assert(true, "Wrong tenant correctly rejected in explain");
      ok("Explain rejects wrong tenant (INV-ING1)");
    }
  });

  // ─── S16: Storage object explain (pure function) ──────────────────────────────
  await scenario("S16 — explainKnowledgeStorageObjectData (pure)", async () => {
    const obj = await registerKnowledgeStorageObject({
      tenantId: TENANT_A,
      storageProvider: "r2",
      bucketName: BUCKET,
      objectKey: "s16/explain-test.pdf",
      sizeBytes: 4096,
      mimeType: "application/pdf",
      checksumSha256: "sha256-s16",
    });

    // Pure function — does not hit DB
    const explanation = explainKnowledgeStorageObjectData(obj);
    assert(explanation.id === obj.id, "Explain has correct id");
    assert(explanation.tenantId === TENANT_A, "Explain has correct tenantId");
    assert(explanation.storageProvider === "r2", "Explain has correct provider");
    assertEqual(explanation.isDeleted as boolean, false, "Not deleted initially");
    assertEqual(explanation.isUsableAsActiveVersion as boolean, true, "Usable initially");
    assert(Array.isArray(explanation.explanation), "Explanation is array");
    assert((explanation.explanation as string[]).length > 0, "Explanation has content");
    ok("Pure explain function works correctly");

    // Deleted object explain
    await markStorageObjectDeleted(obj.id, TENANT_A);
    const deletedObj = await getKnowledgeStorageObjectById(obj.id, TENANT_A);
    const deletedExplain = explainKnowledgeStorageObjectData(deletedObj!);
    assert(deletedExplain.isDeleted as boolean, "Deleted object flagged correctly");
    assert(!(deletedExplain.isUsableAsActiveVersion as boolean), "Deleted object not usable (INV-ING10)");
    ok("Deleted object explain correctly flags unusability (INV-ING10)");
  });

  // ─── S17: Multi-version flow ──────────────────────────────────────────────────
  await scenario("S17 — multi-version ingestion + setCurrentAssetVersion", async () => {
    const r1 = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "url",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s17/multi-v1.pdf",
        sizeBytes: 1024,
      },
      autoSetCurrent: true,
      autoEnqueueProcessing: false,
    });

    const r2 = await ingestKnowledgeAssetVersion({
      tenantId: TENANT_A,
      assetId: r1.assetId,
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s17/multi-v2.pdf",
        sizeBytes: 2048,
      },
      autoSetCurrent: false,
      autoEnqueueProcessing: false,
    });

    assertEqual(r2.versionNumber, 2, "V2 assigned version number 2");

    // Set v2 as current
    const updated = await setCurrentAssetVersion(r1.assetId, r2.versionId, TENANT_A);
    assertEqual(updated.currentVersionId, r2.versionId, "Current version switched to v2");
    ok("Multi-version flow: v1 → v2 current");

    // Roll back to v1
    const updated2 = await setCurrentAssetVersion(r1.assetId, r1.versionId, TENANT_A);
    assertEqual(updated2.currentVersionId, r1.versionId, "Rolled back to v1");
    ok("Current version rolled back to v1");
  });

  // ─── S18: Ingestion without auto-enqueue ──────────────────────────────────────
  await scenario("S18 — ingestKnowledgeAsset with autoEnqueueProcessing=false", async () => {
    const r = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "image",
      sourceType: "api",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s18/no-process.jpg",
        sizeBytes: 512,
        mimeType: "image/jpeg",
      },
      autoEnqueueProcessing: false,
    });
    assertEqual(r.processingJobsEnqueued, 0, "No jobs enqueued when autoEnqueueProcessing=false");
    assertEqual(r.ingestStatus, "registered", "Status = registered (no processing)");
    ok("Ingestion without processing: status=registered, jobs=0");

    // Verify version ingestStatus is 'registered'
    const [version] = await db
      .select()
      .from(knowledgeAssetVersions)
      .where(eq(knowledgeAssetVersions.id, r.versionId));
    assertEqual((version as any).ingestStatus, "registered", "Version ingestStatus = registered");
  });

  // ─── S19: Storage reuse (same bucket+key same tenant) ────────────────────────
  await scenario("S19 — existing storage object reused (INV-ING9)", async () => {
    // First ingest
    const r1 = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s19/reused.pdf",
        sizeBytes: 1024,
      },
      autoEnqueueProcessing: false,
    });

    // Second ingest with SAME storage location
    const r2 = await ingestKnowledgeAsset({
      tenantId: TENANT_A,
      knowledgeBaseId: kbId,
      assetType: "document",
      sourceType: "upload",
      storage: {
        storageProvider: "local",
        bucketName: BUCKET,
        objectKey: "s19/reused.pdf", // same key
        sizeBytes: 1024,
      },
      autoEnqueueProcessing: false,
    });

    assert(r2.existingStorageObjectReused, "Existing storage object reused (INV-ING9)");
    assertEqual(r2.storageObjectId, r1.storageObjectId, "Same storage object ID");
    ok("Storage object reused for identical location (INV-ING9)");
  });

  // ─── S20: Phase 5I/12 retrieval stack intact ──────────────────────────────────
  await scenario("S20 — Phase 5I processing stack still accessible (INV-ING12)", async () => {
    const pipeline = getPipelineForAssetType("document");
    assert(pipeline.steps.length > 0, "Phase 5I pipeline accessible");
    assert(pipeline.steps.includes("parse_document"), "parse_document in pipeline");
    assert(pipeline.steps.includes("chunk_text"), "chunk_text in pipeline");
    assert(pipeline.steps.includes("embed_text"), "embed_text in pipeline");
    assert(pipeline.steps.includes("index_asset"), "index_asset in pipeline");
    ok("Phase 5I pipeline accessible (INV-ING12)");

    const jobs = await listAssetProcessingJobs(TENANT_A, {});
    assert(Array.isArray(jobs), "listAssetProcessingJobs returns array");
    ok("Phase 5I listAssetProcessingJobs accessible (INV-ING12)");

    // Verify existing knowledge_bases, knowledge_documents not affected
    const kbs = await db.select().from(knowledgeBases).where(
      eq(knowledgeBases.tenantId, TENANT_A),
    );
    assert(kbs.length > 0, "Knowledge bases table accessible");
    ok("Phase 5B knowledge_bases table intact (INV-ING12)");
  });

  await teardownFixtures();

  // ─── Summary ──────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Phase 5J Validation Complete`);
  console.log(`  Total assertions: ${total}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log(`\nFailed assertions:`);
    for (const f of failures) {
      console.log(`  ${f}`);
    }
  }
  console.log("=".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

runScenarios().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
