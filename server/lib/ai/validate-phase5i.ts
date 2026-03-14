/**
 * validate-phase5i.ts — Phase 5I
 * Asset Processing Engine Validation
 *
 * 20 scenarios, 80+ assertions
 * Tests: registry, pipeline definitions, job lifecycle, processor idempotency,
 *        dispatcher, orphan detection, tenant isolation, retry logic, admin API.
 *
 * Pattern: each test is a named scenario with explicit assertions.
 */

import { db } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import {
  knowledgeAssets,
  knowledgeAssetVersions,
  knowledgeAssetProcessingJobs,
  knowledgeBases,
} from "@shared/schema";
import {
  enqueueAssetProcessingJob,
  startAssetProcessingJob,
  completeAssetProcessingJob,
  failAssetProcessingJob,
  listAssetProcessingJobs,
  getAssetProcessingJobById,
  explainAssetProcessingState,
} from "./knowledge-asset-processing";
import {
  registerProcessor,
  getProcessor,
  listRegisteredProcessors,
  hasProcessor,
  loadAllProcessors,
  ProcessorNotFoundError,
} from "../../services/asset-processing/asset_processor_registry";
import {
  getPipelineForAssetType,
  getNextJobType,
  getPipelineEntryJob,
  explainPipeline,
  ASSET_PIPELINES,
} from "../../services/asset-processing/asset_processing_pipeline";
import {
  processAssetJob,
  retryAssetProcessingJob,
  detectOrphanJobs,
  explainJobExecution,
  MAX_ATTEMPTS,
} from "../../services/asset-processing/process_asset_job";
import {
  dispatchProcessingBatch,
  getQueueHealthSummary,
} from "../../services/asset-processing/asset_processing_dispatcher";

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    process.stdout.write(`    ✓ ${message}\n`);
  } else {
    failed++;
    failures.push(message);
    process.stdout.write(`    ✗ FAIL: ${message}\n`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
}

function assertIncludes(arr: string[], item: string, message: string): void {
  assert(arr.includes(item), `${message} (array missing: ${item})`);
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n  [SCENARIO] ${name}\n`);
  try {
    await fn();
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: EXCEPTION — ${msg}`);
    process.stdout.write(`    ✗ EXCEPTION: ${msg}\n`);
  }
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

const TEST_TENANT = `test-5i-${Date.now()}`;
const TEST_TENANT_B = `test-5i-b-${Date.now()}`;

async function ensureKnowledgeBase(tenantId: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.tenantId, tenantId))
    .limit(1);
  if (existing) return existing.id;

  const slug = `phase5i-test-${tenantId.slice(-8)}`;
  const [kb] = await db
    .insert(knowledgeBases)
    .values({
      tenantId,
      name: `Phase 5I Test KB (${tenantId})`,
      slug,
      description: "Validation test knowledge base",
    })
    .returning();
  return kb.id;
}

async function createTestAsset(
  tenantId: string,
  assetType: string = "document",
  lifecycleState: string = "active",
): Promise<{ assetId: string; versionId: string }> {
  const kbId = await ensureKnowledgeBase(tenantId);

  const [asset] = await db
    .insert(knowledgeAssets)
    .values({
      tenantId,
      knowledgeBaseId: kbId,
      assetType,
      sourceType: "upload",
      title: `Phase 5I Test ${assetType}`,
      lifecycleState,
      processingState: "pending",
    })
    .returning();

  const [version] = await db
    .insert(knowledgeAssetVersions)
    .values({
      assetId: asset.id,
      tenantId,
      versionNumber: 1,
      mimeType: "text/plain",
      sizeBytes: 1024,
      isActive: true,
    })
    .returning();

  return { assetId: asset.id, versionId: version.id };
}

// ─── SCENARIO 1: Processor Registry — load and list ────────────────────────────

await scenario("S01: Processor registry — load all processors and verify registration", async () => {
  await loadAllProcessors();
  const processors = listRegisteredProcessors();

  assertIncludes(processors, "parse_document", "parse_document registered");
  assertIncludes(processors, "chunk_text", "chunk_text registered");
  assertIncludes(processors, "embed_text", "embed_text registered");
  assertIncludes(processors, "index_asset", "index_asset registered");
  assertIncludes(processors, "ocr_image", "ocr_image registered");
  assertIncludes(processors, "caption_image", "caption_image registered");
  assertIncludes(processors, "transcribe_audio", "transcribe_audio registered");
  assert(processors.length >= 7, `At least 7 processors registered (got ${processors.length})`);
});

// ─── SCENARIO 2: Processor Registry — hasProcessor + getProcessor ────────────

await scenario("S02: Processor registry — hasProcessor and getProcessor", async () => {
  await loadAllProcessors();

  assert(hasProcessor("parse_document"), "hasProcessor returns true for parse_document");
  assert(hasProcessor("chunk_text"), "hasProcessor returns true for chunk_text");
  assert(!hasProcessor("nonexistent_processor"), "hasProcessor returns false for unknown type");

  const processor = getProcessor("parse_document");
  assert(typeof processor === "function", "getProcessor returns a function");
});

// ─── SCENARIO 3: Processor Registry — ProcessorNotFoundError ─────────────────

await scenario("S03: ProcessorNotFoundError thrown for unknown job type", async () => {
  let threw = false;
  let errorName = "";
  try {
    getProcessor("completely_unknown_type_xyz");
  } catch (err: unknown) {
    threw = true;
    errorName = err instanceof Error ? err.name : "";
  }
  assert(threw, "getProcessor throws for unknown job type");
  assertEqual(errorName, "ProcessorNotFoundError", "Error is ProcessorNotFoundError");
});

// ─── SCENARIO 4: Pipeline Definitions — all asset types ─────────────────────

await scenario("S04: Pipeline definitions — all asset types have valid steps", async () => {
  const docPipeline = getPipelineForAssetType("document");
  assertEqual(docPipeline.steps[0], "parse_document", "document pipeline starts with parse_document");
  assertEqual(docPipeline.steps[docPipeline.steps.length - 1], "index_asset", "document pipeline ends with index_asset");
  assert(docPipeline.steps.length >= 4, "document pipeline has at least 4 steps");

  const imagePipeline = getPipelineForAssetType("image");
  assertEqual(imagePipeline.steps[0], "ocr_image", "image pipeline starts with ocr_image");

  const audioPipeline = getPipelineForAssetType("audio");
  assertEqual(audioPipeline.steps[0], "transcribe_audio", "audio pipeline starts with transcribe_audio");

  const unknownPipeline = getPipelineForAssetType("unknown_type");
  assertEqual(unknownPipeline.steps[0], "parse_document", "unknown type falls back to document pipeline");
});

// ─── SCENARIO 5: Pipeline — getNextJobType and entry job ─────────────────────

await scenario("S05: Pipeline — getNextJobType traversal and entry job", async () => {
  const next1 = getNextJobType("document", "parse_document");
  assertEqual(next1, "chunk_text", "parse_document → chunk_text");

  const next2 = getNextJobType("document", "chunk_text");
  assertEqual(next2, "embed_text", "chunk_text → embed_text");

  const next3 = getNextJobType("document", "embed_text");
  assertEqual(next3, "index_asset", "embed_text → index_asset");

  const next4 = getNextJobType("document", "index_asset");
  assertEqual(next4, null, "index_asset is final step (returns null)");

  const entry = getPipelineEntryJob("document");
  assertEqual(entry, "parse_document", "document pipeline entry is parse_document");

  const entryAudio = getPipelineEntryJob("audio");
  assertEqual(entryAudio, "transcribe_audio", "audio pipeline entry is transcribe_audio");
});

// ─── SCENARIO 6: Pipeline — explainPipeline ──────────────────────────────────

await scenario("S06: Pipeline — explainPipeline returns structured output", async () => {
  const explanation = explainPipeline("document");
  assert(explanation.assetType === "document", "explanation.assetType is document");
  assert(typeof explanation.stepCount === "number", "stepCount is a number");
  assert((explanation.stepCount as number) >= 4, "stepCount >= 4 for document");
  assert(Array.isArray(explanation.steps), "steps is an array");
});

// ─── SCENARIO 7: Job Lifecycle — enqueue → start → complete ─────────────────

await scenario("S07: Job lifecycle — enqueue → start → complete", async () => {
  const { assetId, versionId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: versionId,
    jobType: "parse_document",
    metadata: { test: "s07" },
  });

  assertEqual(job.jobStatus, "queued", "New job is queued");
  assertEqual(job.tenantId, TEST_TENANT, "Job tenant is correct");
  assertEqual(job.assetId, assetId, "Job asset ID is correct");
  assert(job.id.length > 0, "Job has an ID");

  const started = await startAssetProcessingJob(job.id, TEST_TENANT);
  assertEqual(started.jobStatus, "started", "Job moved to started");
  assert(started.startedAt !== null, "Job has startedAt timestamp");

  const completed = await completeAssetProcessingJob(job.id, TEST_TENANT);
  assertEqual(completed.jobStatus, "completed", "Job moved to completed");
  assert(completed.completedAt !== null, "Job has completedAt timestamp");
});

// ─── SCENARIO 8: Job Lifecycle — enqueue → start → fail ─────────────────────

await scenario("S08: Job lifecycle — enqueue → start → fail with error message", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "chunk_text",
    metadata: { test: "s08" },
  });

  await startAssetProcessingJob(job.id, TEST_TENANT);
  const failed = await failAssetProcessingJob(job.id, TEST_TENANT, "Test error: missing parsedText");
  assertEqual(failed.jobStatus, "failed", "Job moved to failed");
  assert((failed.errorMessage ?? "").includes("Test error"), "Error message preserved (INV-PROC-6)");
});

// ─── SCENARIO 9: Tenant Isolation — job not visible across tenants ────────────

await scenario("S09: Tenant isolation — job not accessible from another tenant", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "parse_document",
    metadata: { test: "s09" },
  });

  const foundInCorrectTenant = await getAssetProcessingJobById(job.id, TEST_TENANT);
  assert(foundInCorrectTenant !== null, "Job found in correct tenant");

  const foundInWrongTenant = await getAssetProcessingJobById(job.id, TEST_TENANT_B);
  assert(foundInWrongTenant === null, "Job not found in wrong tenant (INV-PROC-2)");
});

// ─── SCENARIO 10: getAssetProcessingJobById — not found returns null ─────────

await scenario("S10: getAssetProcessingJobById — nonexistent job returns null", async () => {
  const result = await getAssetProcessingJobById("nonexistent-job-id-xyz", TEST_TENANT);
  assert(result === null, "getAssetProcessingJobById returns null for nonexistent job");
});

// ─── SCENARIO 11: MAX_ATTEMPTS constant ──────────────────────────────────────

await scenario("S11: MAX_ATTEMPTS is 3", async () => {
  assertEqual(MAX_ATTEMPTS, 3, "MAX_ATTEMPTS equals 3");
});

// ─── SCENARIO 12: retryAssetProcessingJob — retry a failed job ───────────────

await scenario("S12: Retry mechanism — retry failed job creates new queued job", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "embed_text",
    metadata: { test: "s12" },
  });
  await startAssetProcessingJob(job.id, TEST_TENANT);
  await failAssetProcessingJob(job.id, TEST_TENANT, "Stub embed failure");

  const retryJob = await retryAssetProcessingJob(job.id, TEST_TENANT);
  assertEqual(retryJob.jobStatus, "queued", "Retry job starts as queued");
  assertEqual(retryJob.jobType, "embed_text", "Retry job has same job type");
  assertEqual(retryJob.attemptNumber, 2, "Retry job is attempt #2");
  assert(retryJob.id !== job.id, "Retry creates a new job row");
  const meta = retryJob.metadata as Record<string, unknown>;
  assertEqual(meta.retriedFromJobId as string, job.id, "Retry metadata references original job ID");
});

// ─── SCENARIO 13: retryAssetProcessingJob — reject non-failed jobs ───────────

await scenario("S13: Retry rejected for non-failed job", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "parse_document",
    metadata: { test: "s13" },
  });

  let threw = false;
  let errorMessage = "";
  try {
    await retryAssetProcessingJob(job.id, TEST_TENANT);
  } catch (err: unknown) {
    threw = true;
    errorMessage = err instanceof Error ? err.message : "";
  }
  assert(threw, "retryAssetProcessingJob throws for queued job");
  assert(errorMessage.includes("failed jobs"), "Error mentions 'failed jobs'");
});

// ─── SCENARIO 14: detectOrphanJobs — no orphans in fresh tenant ──────────────

await scenario("S14: detectOrphanJobs — fresh tenant has no orphans", async () => {
  const freshTenant = `orphan-test-${Date.now()}`;
  const orphans = await detectOrphanJobs(freshTenant, 30);
  assertEqual(orphans.length, 0, "Fresh tenant has no orphan jobs");
});

// ─── SCENARIO 15: explainJobExecution — full observability ───────────────────

await scenario("S15: explainJobExecution — full observability output", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "index_asset",
    metadata: { test: "s15" },
  });
  await startAssetProcessingJob(job.id, TEST_TENANT);
  await failAssetProcessingJob(job.id, TEST_TENANT, "Stub error for observability test");

  const failedJob = await getAssetProcessingJobById(job.id, TEST_TENANT);
  assert(failedJob !== null, "Failed job is retrievable");

  const explanation = explainJobExecution(failedJob!);
  assert("jobId" in explanation, "explanation has jobId");
  assert("jobType" in explanation, "explanation has jobType");
  assert("jobStatus" in explanation, "explanation has jobStatus");
  assert("canRetry" in explanation, "explanation has canRetry");
  assert("isOrphan" in explanation, "explanation has isOrphan");
  assert("maxAttempts" in explanation, "explanation has maxAttempts");
  assertEqual(explanation.canRetry as boolean, true, "Failed job in attempt 1 can be retried");
  assertEqual(explanation.maxAttempts as number, MAX_ATTEMPTS, "maxAttempts is correct");
  assert(Array.isArray(explanation.explanation), "explanation field is an array");
});

// ─── SCENARIO 16: listAssetProcessingJobs — filter by asset ──────────────────

await scenario("S16: listAssetProcessingJobs — filter by assetId", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "parse_document",
    metadata: { test: "s16-a" },
  });
  await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "chunk_text",
    metadata: { test: "s16-b" },
  });

  const jobs = await listAssetProcessingJobs(TEST_TENANT, { assetId });
  assert(jobs.length >= 2, `At least 2 jobs found for asset (got ${jobs.length})`);
  assert(jobs.every((j) => j.assetId === assetId), "All jobs belong to correct asset");
});

// ─── SCENARIO 17: explainAssetProcessingState ────────────────────────────────

await scenario("S17: explainAssetProcessingState — structured output", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "parse_document",
    metadata: { test: "s17" },
  });

  const state = await explainAssetProcessingState(TEST_TENANT, assetId);
  assertEqual(state.assetId, assetId, "State has correct assetId");
  assertEqual(state.tenantId, TEST_TENANT, "State has correct tenantId");
  assert(state.totalJobs >= 1, "At least 1 job in state");
  assert(state.queued >= 1, "At least 1 queued job");
  assert(Array.isArray(state.explanation), "explanation is an array");
  assert(state.hasActiveJob, "hasActiveJob is true when jobs are queued");
});

// ─── SCENARIO 18: getQueueHealthSummary — all-tenant health check ─────────────

await scenario("S18: getQueueHealthSummary — structured health output", async () => {
  const health = await getQueueHealthSummary();
  assert("totalJobs" in health, "health has totalJobs");
  assert("queued" in health, "health has queued");
  assert("completed" in health, "health has completed");
  assert("failed" in health, "health has failed");
  assert("potentialOrphans" in health, "health has potentialOrphans");
  assert("byStatus" in health, "health has byStatus");
  assert("byType" in health, "health has byType");
  assert("queueHealthy" in health, "health has queueHealthy");
  assert(Array.isArray(health.explanation), "explanation is an array");
});

// ─── SCENARIO 19: dispatchProcessingBatch — empty batch ──────────────────────

await scenario("S19: dispatchProcessingBatch — isolated tenant with no queued jobs", async () => {
  const isolatedTenant = `dispatch-test-${Date.now()}`;
  const result = await dispatchProcessingBatch({ tenantId: isolatedTenant, batchSize: 5 });

  assert("batchId" in result, "result has batchId");
  assert("durationMs" in result, "result has durationMs");
  assertEqual(result.jobsFound, 0, "No jobs found for isolated tenant");
  assertEqual(result.jobsDispatched, 0, "No jobs dispatched");
  assert(Array.isArray(result.results), "results is an array");
});

// ─── SCENARIO 20: processAssetJob — INV-PROC-1 concurrent duplicate prevention ─

await scenario("S20: INV-PROC-1 — concurrent duplicate execution prevented", async () => {
  const { assetId } = await createTestAsset(TEST_TENANT, "document");

  const job = await enqueueAssetProcessingJob({
    tenantId: TEST_TENANT,
    assetId,
    assetVersionId: null,
    jobType: "chunk_text",
    metadata: { test: "s20" },
  });

  // Manually start the job to simulate concurrent state
  await startAssetProcessingJob(job.id, TEST_TENANT);

  let threw = false;
  let errorCode = "";
  try {
    await processAssetJob(job.id, TEST_TENANT);
  } catch (err: unknown) {
    threw = true;
    if (err instanceof Error && "code" in err) {
      errorCode = (err as any).code;
    }
  }

  assert(threw, "processAssetJob throws when job already started (INV-PROC-1)");
  assertEqual(errorCode, "CONCURRENT_EXECUTION", "Error code is CONCURRENT_EXECUTION");
});

// ─── Results ───────────────────────────────────────────────────────────────────

console.log("\n========================================");
console.log(`  validate-phase5i.ts`);
console.log(`  Scenarios: 20 | Assertions: ${passed + failed}`);
console.log(`  ✓ Passed: ${passed} | ✗ Failed: ${failed}`);
console.log("========================================");

if (failures.length > 0) {
  console.log("\n  FAILURES:");
  for (const f of failures) {
    console.log(`    - ${f}`);
  }
  process.exit(1);
}

process.exit(0);
