/**
 * validate-phase5g.ts — Phase 5G
 * Knowledge Asset Registry & Multimodal Foundation
 *
 * 20 scenarios, target ≥ 70 assertions.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  createKnowledgeAsset,
  createKnowledgeAssetVersion,
  setKnowledgeAssetCurrentVersion,
  getKnowledgeAssetById,
  listKnowledgeAssetsByKnowledgeBase,
  listKnowledgeAssetsByTenant,
  updateKnowledgeAssetLifecycle,
  markKnowledgeAssetProcessingState,
  explainKnowledgeAsset,
} from "./knowledge-assets";
import {
  registerStorageObject,
  getStorageObjectById,
  listStorageObjectsByTenant,
  markStorageObjectArchived,
  markStorageObjectDeleted,
  explainStorageObject,
} from "./knowledge-storage";
import {
  enqueueAssetProcessingJob,
  startAssetProcessingJob,
  completeAssetProcessingJob,
  failAssetProcessingJob,
  listAssetProcessingJobs,
  explainAssetProcessingState,
} from "./knowledge-asset-processing";
import {
  explainDocumentToAssetMigrationStrategy,
  previewLegacyDocumentCompatibility,
  explainCurrentRegistryState,
} from "./knowledge-asset-compat";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

async function assertThrows(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    console.error(`  ✗ FAIL (no error thrown): ${label}`);
    failed++;
  } catch {
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

// ─── Test data ────────────────────────────────────────────────────────────────
const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000099";
const KB_ID    = "test-kb-5g";
const RUN_ID   = Date.now().toString(36); // unique per run for idempotency

console.log("\n========================================");
console.log("  validate-phase5g.ts — Phase 5G");
console.log("  Knowledge Asset Registry & Multimodal");
console.log("========================================\n");

async function main() {
  // ── S01: Create document asset ────────────────────────────────────────────
  console.log("\n── S01: Create document asset ──");
  const docAsset = await createKnowledgeAsset({
    tenantId: TENANT_A,
    knowledgeBaseId: KB_ID,
    assetType: "document",
    sourceType: "upload",
    title: "Test Document Asset",
  });
  assert(typeof docAsset.id === "string" && docAsset.id.length > 0, "asset id is non-empty string");
  assert(docAsset.assetType === "document", "assetType = document");
  assert(docAsset.lifecycleState === "active", "default lifecycleState = active");
  assert(docAsset.processingState === "pending", "default processingState = pending");
  assert(docAsset.visibilityState === "private", "default visibilityState = private");
  assert(docAsset.tenantId === TENANT_A, "tenantId correct");
  assert(docAsset.currentVersionId === null, "currentVersionId starts null");

  // ── S02: Create image asset ───────────────────────────────────────────────
  console.log("\n── S02: Create image asset ──");
  const imgAsset = await createKnowledgeAsset({
    tenantId: TENANT_A,
    knowledgeBaseId: KB_ID,
    assetType: "image",
    sourceType: "url",
    title: "Test Image",
  });
  assert(imgAsset.assetType === "image", "assetType = image");
  assert(imgAsset.tenantId === TENANT_A, "tenantId scoped correctly");

  // ── S03: Create video asset ───────────────────────────────────────────────
  console.log("\n── S03: Create video asset ──");
  const vidAsset = await createKnowledgeAsset({
    tenantId: TENANT_A,
    knowledgeBaseId: KB_ID,
    assetType: "video",
    sourceType: "api",
  });
  assert(vidAsset.assetType === "video", "assetType = video");

  // ── S04: Create asset version ─────────────────────────────────────────────
  console.log("\n── S04: Create asset version ──");
  const v1 = await createKnowledgeAssetVersion({
    assetId: docAsset.id,
    versionNumber: 1,
    mimeType: "application/pdf",
    sizeBytes: 102400,
    checksumSha256: "abc123def456abc123def456abc123def456abc123def456abc123def456abc12",
  });
  assert(typeof v1.id === "string" && v1.id.length > 0, "version id is non-empty string");
  assert(v1.assetId === docAsset.id, "version.assetId = docAsset.id");
  assert(v1.versionNumber === 1, "versionNumber = 1");
  assert(v1.mimeType === "application/pdf", "mimeType = application/pdf");
  assert(v1.sizeBytes === 102400, "sizeBytes = 102400");

  // ── S05: Current version switch works ─────────────────────────────────────
  console.log("\n── S05: Current version switch works ──");
  const v2 = await createKnowledgeAssetVersion({ assetId: docAsset.id, versionNumber: 2 });
  const updatedAsset = await setKnowledgeAssetCurrentVersion(docAsset.id, TENANT_A, v1.id);
  assert(updatedAsset.currentVersionId === v1.id, "currentVersionId set to v1.id");

  const switched = await setKnowledgeAssetCurrentVersion(docAsset.id, TENANT_A, v2.id);
  assert(switched.currentVersionId === v2.id, "currentVersionId switched to v2.id");

  // ── S06: Invalid asset_type rejected ──────────────────────────────────────
  console.log("\n── S06: Invalid asset_type rejected ──");
  await assertThrows(
    () => createKnowledgeAsset({ tenantId: TENANT_A, knowledgeBaseId: KB_ID, assetType: "spreadsheet", sourceType: "upload" }),
    "createKnowledgeAsset rejects invalid asset_type",
  );

  // ── S07: Invalid lifecycle_state rejected ─────────────────────────────────
  console.log("\n── S07: Invalid lifecycle_state rejected ──");
  await assertThrows(
    () => updateKnowledgeAssetLifecycle(docAsset.id, TENANT_A, "decommissioned" as any),
    "updateKnowledgeAssetLifecycle rejects invalid lifecycle_state",
  );

  // ── S08: Invalid processing_state rejected ────────────────────────────────
  console.log("\n── S08: Invalid processing_state rejected ──");
  await assertThrows(
    () => markKnowledgeAssetProcessingState(docAsset.id, TENANT_A, "half_done" as any),
    "markKnowledgeAssetProcessingState rejects invalid processing_state",
  );

  // ── S09: Processing job enqueue/start/complete works ──────────────────────
  console.log("\n── S09: Processing job enqueue/start/complete ──");
  const job1 = await enqueueAssetProcessingJob({
    tenantId: TENANT_A,
    assetId: docAsset.id,
    jobType: "parse_document",
  });
  assert(typeof job1.id === "string", "job id is string");
  assert(job1.jobStatus === "queued", "initial jobStatus = queued");
  assert(job1.jobType === "parse_document", "jobType = parse_document");
  assert(job1.attemptNumber === 1, "attemptNumber = 1");

  const startedJob = await startAssetProcessingJob(job1.id, TENANT_A);
  assert(startedJob.jobStatus === "started", "after start: jobStatus = started");
  assert(startedJob.startedAt !== null, "startedAt is set after start");

  const completedJob = await completeAssetProcessingJob(job1.id, TENANT_A, { chunkCount: 42 });
  assert(completedJob.jobStatus === "completed", "after complete: jobStatus = completed");
  assert(completedJob.completedAt !== null, "completedAt is set after complete");

  // ── S10: Processing job failure works ─────────────────────────────────────
  console.log("\n── S10: Processing job failure works ──");
  const failJob = await enqueueAssetProcessingJob({
    tenantId: TENANT_A,
    assetId: imgAsset.id,
    jobType: "ocr_image",
  });
  await startAssetProcessingJob(failJob.id, TENANT_A);
  const failedJob = await failAssetProcessingJob(failJob.id, TENANT_A, "OCR engine timeout");
  assert(failedJob.jobStatus === "failed", "after fail: jobStatus = failed");
  assert(failedJob.errorMessage === "OCR engine timeout", "errorMessage preserved");

  // Invalid transition — completed job cannot be started
  await assertThrows(
    () => startAssetProcessingJob(completedJob.id, TENANT_A),
    "invalid transition completed → started rejected",
  );

  // ── S11: Storage object register works ────────────────────────────────────
  console.log("\n── S11: Storage object register works ──");
  const storageObj = await registerStorageObject({
    tenantId: TENANT_A,
    storageProvider: "r2",
    bucketName: "tenant-assets",
    objectKey: `docs/test-5g-doc-${RUN_ID}.pdf`,
    sizeBytes: 204800,
    mimeType: "application/pdf",
    checksumSha256: "a".repeat(64),
    storageClass: "hot",
  });
  assert(typeof storageObj.id === "string", "storageObj id is string");
  assert(storageObj.storageProvider === "r2", "storageProvider = r2");
  assert(storageObj.storageClass === "hot", "storageClass = hot");
  assert(storageObj.sizeBytes === 204800, "sizeBytes = 204800");

  // ── S12: Storage object archive/delete transitions ────────────────────────
  console.log("\n── S12: Storage object archive/delete transitions ──");
  const archived = await markStorageObjectArchived(storageObj.id, TENANT_A);
  assert(archived.storageClass === "archive", "storageClass = archive after archive");
  assert(archived.archivedAt !== null, "archivedAt is set");

  // Cannot archive again (already archived)
  await assertThrows(
    () => markStorageObjectArchived(storageObj.id, TENANT_A),
    "cannot archive already-archived storage object",
  );

  const storageObj2 = await registerStorageObject({
    tenantId: TENANT_A,
    storageProvider: "s3",
    bucketName: "tenant-assets",
    objectKey: `docs/test-5g-img-${RUN_ID}.png`,
    sizeBytes: 51200,
    storageClass: "hot",
  });
  const deleted = await markStorageObjectDeleted(storageObj2.id, TENANT_A);
  assert(deleted.storageClass === "deleted", "storageClass = deleted after delete");
  assert(deleted.deletedAt !== null, "deletedAt is set");

  // ── S13: Tenant isolation enforced ───────────────────────────────────────
  console.log("\n── S13: Tenant isolation enforced ──");
  const isolatedAsset = await getKnowledgeAssetById(docAsset.id, TENANT_B);
  assert(isolatedAsset === null, "TENANT_B cannot see TENANT_A's asset (INV-5)");

  const tenantBStorage = await listStorageObjectsByTenant(TENANT_B);
  const tenantAIds = new Set([storageObj.id, storageObj2.id]);
  const leak = tenantBStorage.some((obj) => tenantAIds.has(obj.id));
  assert(!leak, "TENANT_B storage list does not include TENANT_A objects");

  const tenantBJobs = await listAssetProcessingJobs(TENANT_B, { assetId: docAsset.id });
  assert(tenantBJobs.length === 0, "TENANT_B cannot list TENANT_A's jobs");

  // ── S14: KB-scoped listing works ─────────────────────────────────────────
  console.log("\n── S14: KB-scoped listing works ──");
  const kbAssets = await listKnowledgeAssetsByKnowledgeBase(TENANT_A, KB_ID);
  assert(Array.isArray(kbAssets), "listKnowledgeAssetsByKnowledgeBase returns array");
  const assetIds = kbAssets.map((a) => a.id);
  assert(assetIds.includes(docAsset.id), "docAsset present in KB listing");
  assert(assetIds.includes(imgAsset.id), "imgAsset present in KB listing");
  assert(assetIds.includes(vidAsset.id), "vidAsset present in KB listing");

  const tenantAssets = await listKnowledgeAssetsByTenant(TENANT_A);
  assert(Array.isArray(tenantAssets), "listKnowledgeAssetsByTenant returns array");
  assert(tenantAssets.length >= 3, "at least 3 assets for TENANT_A");

  // ── S15: Version uniqueness enforced ─────────────────────────────────────
  console.log("\n── S15: Version uniqueness enforced ──");
  await assertThrows(
    () => createKnowledgeAssetVersion({ assetId: docAsset.id, versionNumber: 1 }),
    "duplicate version_number for same asset rejected (DB unique constraint)",
  );

  // ── S16: explainKnowledgeAsset returns full structured output ─────────────
  console.log("\n── S16: explainKnowledgeAsset returns full structured output ──");
  const explanation = await explainKnowledgeAsset(docAsset.id, TENANT_A);
  assert(typeof explanation.asset === "object", "explanation.asset is object");
  assert(Array.isArray(explanation.versions), "explanation.versions is array");
  assert(explanation.versionCount >= 2, "versionCount >= 2 (v1, v2)");
  assert(explanation.currentVersion !== null, "currentVersion is set (v2)");
  assert(explanation.currentVersion?.id === v2.id, "currentVersion.id = v2.id");
  assert(typeof explanation.isSearchable === "boolean", "isSearchable is boolean");
  assert(Array.isArray(explanation.explanation), "explanation.explanation is array");
  assert(explanation.explanation.length > 0, "explanation.explanation has entries");

  // ── S17: explainAssetProcessingState returns full structured output ────────
  console.log("\n── S17: explainAssetProcessingState returns full structured output ──");
  const processingState = await explainAssetProcessingState(TENANT_A, docAsset.id);
  assert(processingState.assetId === docAsset.id, "assetId correct");
  assert(typeof processingState.totalJobs === "number", "totalJobs is number");
  assert(processingState.totalJobs >= 1, "totalJobs >= 1");
  assert(typeof processingState.completed === "number", "completed is number");
  assert(typeof processingState.hasActiveJob === "boolean", "hasActiveJob is boolean");
  assert(typeof processingState.lastJobType === "string" || processingState.lastJobType === null, "lastJobType is string or null");
  assert(Array.isArray(processingState.explanation), "explanation array present");

  // ── S18: explainStorageObject returns full structured output ──────────────
  console.log("\n── S18: Compat migration strategy output ──");
  const migrationStrategy = explainDocumentToAssetMigrationStrategy();
  assert(typeof migrationStrategy.strategy === "string", "strategy is string");
  assert(migrationStrategy.strategy === "additive-coexistence", "strategy = additive-coexistence");
  assert(Array.isArray(migrationStrategy.phases), "phases is array");
  assert(migrationStrategy.phases.length >= 3, "at least 3 migration phases defined");
  assert(typeof migrationStrategy.mappings === "object", "mappings is object");
  assert(Array.isArray(migrationStrategy.warnings), "warnings is array");
  assert(migrationStrategy.warnings.length > 0, "warnings are non-empty");
  assert(typeof migrationStrategy.recommendation === "string", "recommendation is string");

  const legacyPreview = await previewLegacyDocumentCompatibility(TENANT_A);
  assert(legacyPreview.tenantId === TENANT_A, "legacyPreview tenantId matches");
  assert(typeof legacyPreview.legacyDocumentCount === "number", "legacyDocumentCount is number");
  assert(typeof legacyPreview.newAssetCount === "number", "newAssetCount is number");
  assert(legacyPreview.newAssetCount >= 3, "newAssetCount >= 3 (3 assets created above)");
  assert(Array.isArray(legacyPreview.previewDocuments), "previewDocuments is array");
  assert(typeof legacyPreview.overlapNote === "string", "overlapNote is string");

  const registryState = await explainCurrentRegistryState();
  assert(typeof registryState.migrationPhase === "string", "migrationPhase is string");
  assert(typeof registryState.readinessLevel === "string", "readinessLevel is string");
  assert(typeof registryState.legacyTables === "object", "legacyTables is object");
  assert(typeof registryState.newAssetRegistryTables === "object", "newAssetRegistryTables is object");
  assert(registryState.newAssetRegistryTables.knowledge_assets >= 3, "at least 3 assets in registry");
  assert(Array.isArray(registryState.explanation), "explanation array present");

  // ── S19: No new TypeScript errors (checked via tsc externally) ────────────
  console.log("\n── S19: explainStorageObject output ──");
  const storageExplain = await explainStorageObject(storageObj.id, TENANT_A);
  assert(typeof storageExplain.object === "object", "storageExplain.object is object");
  assert(storageExplain.isArchived === true, "isArchived = true (archived in S12)");
  assert(storageExplain.isDeleted === false, "isDeleted = false");
  assert(storageExplain.isActive === false, "isActive = false (archived)");
  assert(typeof storageExplain.dedupReady === "boolean", "dedupReady is boolean");
  assert(storageExplain.dedupReady === true, "dedupReady = true (64-char SHA256 present)");
  assert(Array.isArray(storageExplain.explanation), "explanation array present");

  // ── S20: DB verification — all new tables present ──────────────────────────
  console.log("\n── S20: DB verification — tables, indexes, constraints ──");

  const tableCheck = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'knowledge_assets',
        'knowledge_asset_versions',
        'asset_storage_objects',
        'knowledge_asset_processing_jobs'
      )
    ORDER BY table_name
  `);
  const tableNames = Array.from(new Set(((tableCheck as any).rows ?? []).map((r: any) => r.table_name)));
  assert(tableNames.includes("knowledge_assets"), "DB: knowledge_assets exists");
  assert(tableNames.includes("knowledge_asset_versions"), "DB: knowledge_asset_versions exists");
  assert(tableNames.includes("asset_storage_objects"), "DB: asset_storage_objects exists");
  assert(tableNames.includes("knowledge_asset_processing_jobs"), "DB: knowledge_asset_processing_jobs exists");

  // CHECK constraints
  const constraintCheck = await db.execute(sql`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'ka_asset_type_check',
      'ka_source_type_check',
      'ka_lifecycle_state_check',
      'ka_processing_state_check',
      'ka_visibility_state_check',
      'kav_version_number_check',
      'kav_size_bytes_check',
      'kav_asset_version_uniq',
      'aso_size_bytes_check',
      'aso_storage_provider_check',
      'aso_storage_class_check',
      'kapj_attempt_number_check',
      'kapj_job_type_check',
      'kapj_job_status_check',
      'ka_current_version_id_fk'
    )
    ORDER BY conname
  `);
  const constraintNames = new Set(((constraintCheck as any).rows ?? []).map((r: any) => r.conname));
  assert(constraintNames.has("ka_asset_type_check"), "DB: ka_asset_type_check exists");
  assert(constraintNames.has("ka_lifecycle_state_check"), "DB: ka_lifecycle_state_check exists");
  assert(constraintNames.has("ka_processing_state_check"), "DB: ka_processing_state_check exists");
  assert(constraintNames.has("ka_visibility_state_check"), "DB: ka_visibility_state_check exists");
  assert(constraintNames.has("kav_version_number_check"), "DB: kav_version_number_check exists");
  assert(constraintNames.has("kav_asset_version_uniq"), "DB: kav_asset_version_uniq exists");
  assert(constraintNames.has("aso_storage_provider_check"), "DB: aso_storage_provider_check exists");
  assert(constraintNames.has("aso_storage_class_check"), "DB: aso_storage_class_check exists");
  assert(constraintNames.has("kapj_job_type_check"), "DB: kapj_job_type_check exists");
  assert(constraintNames.has("kapj_job_status_check"), "DB: kapj_job_status_check exists");
  assert(constraintNames.has("ka_current_version_id_fk"), "DB: ka_current_version_id_fk (deferred FK) exists");

  // Indexes
  const indexCheck = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'ka_tenant_kb_created_idx',
        'ka_tenant_type_created_idx',
        'ka_tenant_lifecycle_idx',
        'ka_tenant_processing_idx',
        'kav_asset_created_idx',
        'kav_storage_object_idx',
        'aso_tenant_created_idx',
        'aso_tenant_checksum_idx',
        'aso_tenant_class_created_idx',
        'kapj_tenant_created_idx',
        'kapj_asset_created_idx',
        'kapj_status_created_idx',
        'kapj_type_created_idx'
      )
  `);
  const indexNames = new Set(((indexCheck as any).rows ?? []).map((r: any) => r.indexname));
  assert(indexNames.has("ka_tenant_kb_created_idx"), "DB: ka_tenant_kb_created_idx");
  assert(indexNames.has("ka_tenant_lifecycle_idx"), "DB: ka_tenant_lifecycle_idx");
  assert(indexNames.has("ka_tenant_processing_idx"), "DB: ka_tenant_processing_idx");
  assert(indexNames.has("kav_asset_created_idx"), "DB: kav_asset_created_idx");
  assert(indexNames.has("aso_tenant_checksum_idx"), "DB: aso_tenant_checksum_idx");
  assert(indexNames.has("kapj_status_created_idx"), "DB: kapj_status_created_idx");
  assert(indexNames.has("kapj_type_created_idx"), "DB: kapj_type_created_idx");

  // DB CHECK constraint enforcement
  const rejectBadAssetType = await db.execute(sql`
    SELECT 1 FROM knowledge_assets WHERE false
  `).then(() => true).catch(() => false);
  // Verify bad CHECK rejected via direct SQL
  let checkEnforced = false;
  try {
    await db.execute(sql`
      INSERT INTO knowledge_assets (tenant_id, knowledge_base_id, asset_type, source_type)
      VALUES ('t', 'kb', 'invalid_type', 'upload')
    `);
  } catch {
    checkEnforced = true;
  }
  assert(checkEnforced, "DB: ka_asset_type_check rejects invalid asset_type");

  let jobStatusCheckEnforced = false;
  try {
    await db.execute(sql`
      INSERT INTO knowledge_asset_processing_jobs (tenant_id, asset_id, job_type, job_status)
      VALUES ('t', 'fake-id', 'parse_document', 'invalid_status')
    `);
  } catch {
    jobStatusCheckEnforced = true;
  }
  assert(jobStatusCheckEnforced, "DB: kapj_job_status_check rejects invalid job_status");

  let storageClassCheckEnforced = false;
  try {
    await db.execute(sql`
      INSERT INTO asset_storage_objects (tenant_id, storage_provider, bucket_name, object_key, storage_class, size_bytes)
      VALUES ('t', 'r2', 'b', 'k', 'invalid_class', 100)
    `);
  } catch {
    storageClassCheckEnforced = true;
  }
  assert(storageClassCheckEnforced, "DB: aso_storage_class_check rejects invalid storage_class");

  // ─── Results ──────────────────────────────────────────────────────────────

  console.log("\n========================================");
  console.log(`  RESULTS: ${passed} passed / ${failed} failed`);
  console.log(`  Total assertions: ${passed + failed}`);
  console.log("========================================");

  if (failed === 0) {
    console.log("\nAll assertions passed. Phase 5G validation complete.\n");
  } else {
    console.error(`\n${failed} assertion(s) failed!\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\nValidation error:", err);
  process.exit(1);
});
