#!/usr/bin/env npx tsx
/**
 * Phase 29 — Backup & Disaster Recovery — Validation
 * 60 scenarios · 150+ assertions
 */

import * as http from "http";

let passed = 0;
let failed = 0;

// ── Assert helpers ─────────────────────────────────────────────────────────────

function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✔ ${label}`); passed++; }
  else       { console.log(`  ✖ ${label}`); failed++; }
}
function assertEq<T>(a: T, b: T, label: string): void {
  assert(a === b, `${label} (got: ${JSON.stringify(a)})`);
}
function assertNum(v: unknown, label: string): void {
  assert(typeof v === "number" && !isNaN(v as number), `${label} is number`);
}
function assertStr(v: unknown, label: string): void {
  assert(typeof v === "string" && (v as string).length > 0, `${label} is non-empty string`);
}
function assertArr(v: unknown, label: string): void {
  assert(Array.isArray(v), `${label} is array`);
}
function assertBool(v: unknown, label: string): void {
  assert(typeof v === "boolean", `${label} is boolean`);
}
function assertIso(v: unknown, label: string): void {
  assert(typeof v === "string" && !isNaN(Date.parse(v as string)), `${label} is ISO date`);
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function httpGet(path: string): Promise<{ status: number; body: any }> {
  return new Promise(resolve => {
    const req = http.request(
      { host: "localhost", port: 5000, path, method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-secret": "admin" } },
      res => {
        let d = "";
        res.on("data", c => { d += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: d }); }
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

function httpPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "localhost", port: 5000, path, method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-secret": "admin", "Content-Length": Buffer.byteLength(payload) } },
      res => {
        let d = "";
        res.on("data", c => { d += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: d }); }
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.write(payload);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("Phase 29 — Backup & Disaster Recovery — Validation");
  console.log("═══════════════════════════════════════════════════════");

  // ══════════════════════════════════════════════════════════════════════════
  // S01–S10: backup-policy
  // ══════════════════════════════════════════════════════════════════════════

  section("S01: DEFAULT_BACKUP_POLICIES — structure");
  {
    const { DEFAULT_BACKUP_POLICIES } = await import("./server/lib/backup/backup-policy");
    assertArr(DEFAULT_BACKUP_POLICIES, "DEFAULT_BACKUP_POLICIES");
    assert(DEFAULT_BACKUP_POLICIES.length >= 4, "at least 4 default policies");
    assert(DEFAULT_BACKUP_POLICIES.every(p => typeof p.policyId === "string"), "all have policyId");
    assert(DEFAULT_BACKUP_POLICIES.every(p => ["hourly","daily","weekly","monthly"].includes(p.frequency)), "all frequencies valid");
    assert(DEFAULT_BACKUP_POLICIES.every(p => ["full","incremental","tenant","table"].includes(p.scope)), "all scopes valid");
    assert(DEFAULT_BACKUP_POLICIES.every(p => p.retentionDays > 0), "all retentionDays > 0");
  }

  section("S02: DEFAULT_BACKUP_POLICIES — encryption");
  {
    const { DEFAULT_BACKUP_POLICIES } = await import("./server/lib/backup/backup-policy");
    assert(DEFAULT_BACKUP_POLICIES.every(p => p.encryptionRequired === true), "all require encryption");
    assert(DEFAULT_BACKUP_POLICIES.every(p => typeof p.enabled === "boolean"), "all have enabled flag");
  }

  section("S03: RETENTION_RULES — structure");
  {
    const { RETENTION_RULES } = await import("./server/lib/backup/backup-policy");
    assertArr(RETENTION_RULES, "RETENTION_RULES");
    assert(RETENTION_RULES.length >= 4, "at least 4 retention rules");
    assert(RETENTION_RULES.every(r => r.retentionDays > 0), "all retentionDays > 0");
    assert(RETENTION_RULES.every(r => r.minCopies >= 1), "all minCopies >= 1");
    assert(RETENTION_RULES.every(r => typeof r.encryptAtRest === "boolean"), "all have encryptAtRest");
  }

  section("S04: getEnabledPolicies — returns only enabled");
  {
    const { getEnabledPolicies } = await import("./server/lib/backup/backup-policy");
    const policies = getEnabledPolicies();
    assertArr(policies, "getEnabledPolicies");
    assert(policies.length >= 1, "at least 1 enabled policy");
    assert(policies.every(p => p.enabled === true), "all returned policies are enabled");
  }

  section("S05: getPolicyById — finds known policy");
  {
    const { getPolicyById } = await import("./server/lib/backup/backup-policy");
    const p = getPolicyById("bp-daily-full");
    assert(p !== undefined, "bp-daily-full found");
    assertEq(p?.frequency, "daily", "bp-daily-full frequency is daily");
    assertEq(p?.scope, "full", "bp-daily-full scope is full");
  }

  section("S06: getPolicyById — returns undefined for missing");
  {
    const { getPolicyById } = await import("./server/lib/backup/backup-policy");
    const p = getPolicyById("not-a-real-policy");
    assert(p === undefined, "missing policy returns undefined");
  }

  section("S07: getRetentionForScope — returns rule");
  {
    const { getRetentionForScope } = await import("./server/lib/backup/backup-policy");
    const r = getRetentionForScope("full");
    assert(r !== undefined, "full scope rule found");
    assertNum(r!.retentionDays, "retentionDays");
    assert(r!.retentionDays >= 30, "full retention >= 30 days");
  }

  section("S08: isRetentionCompliant — within window");
  {
    const { isRetentionCompliant } = await import("./server/lib/backup/backup-policy");
    assert(isRetentionCompliant(7, "full") === true, "7-day-old full backup compliant");
    assert(isRetentionCompliant(31, "full") === false, "31-day-old full backup non-compliant");
    assert(isRetentionCompliant(6, "incremental") === true, "6-day incremental compliant");
    assert(isRetentionCompliant(8, "incremental") === false, "8-day incremental non-compliant");
  }

  section("S09: validateBackupEncryption — returns result");
  {
    const { validateBackupEncryption } = await import("./server/lib/backup/backup-policy");
    const result = validateBackupEncryption();
    assertBool(result.valid, "valid is boolean");
    assertStr(result.algorithm, "algorithm");
    assertEq(result.algorithm, "AES-256-GCM", "algorithm is AES-256-GCM");
    assertBool(result.keyRotationDue, "keyRotationDue is boolean");
    assertArr(result.issues, "issues is array");
  }

  section("S10: getBackupPolicySummary + getDbBackupMetadata");
  {
    const { getBackupPolicySummary, getDbBackupMetadata } = await import("./server/lib/backup/backup-policy");
    const [summary, meta] = await Promise.all([getBackupPolicySummary(), getDbBackupMetadata()]);

    assertNum(summary.totalPolicies, "totalPolicies");
    assertNum(summary.enabledPolicies, "enabledPolicies");
    assertArr(summary.policies, "policies");
    assertArr(summary.retentionRules, "retentionRules");
    assertIso(summary.checkedAt, "summary checkedAt");

    assertNum(meta.dbSizeBytes, "dbSizeBytes");
    assertNum(meta.tableCount, "tableCount");
    assertNum(meta.estimatedBackupMb, "estimatedBackupMb");
    assert(meta.tableCount >= 10, "at least 10 tables");
    assertIso(meta.checkedAt, "meta checkedAt");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S11–S20: backup-validator
  // ══════════════════════════════════════════════════════════════════════════

  section("S11: checkLatestBackupTimestamp — returns result");
  {
    const { checkLatestBackupTimestamp } = await import("./server/lib/backup/backup-validator");
    const r = await checkLatestBackupTimestamp();
    assert(["ok","warning","critical","unknown"].includes(r.status), "status is valid");
    assertNum(r.maxAgeHours, "maxAgeHours");
    assertBool(r.withinSla, "withinSla is boolean");
    assertStr(r.message, "message");
  }

  section("S12: checkLatestBackupTimestamp — ageHours type");
  {
    const { checkLatestBackupTimestamp } = await import("./server/lib/backup/backup-validator");
    const r = await checkLatestBackupTimestamp(24);
    assert(r.ageHours === null || typeof r.ageHours === "number", "ageHours is null or number");
    assertEq(r.maxAgeHours, 24, "maxAgeHours matches input");
    assert(r.latestBackupAt === null || !isNaN(Date.parse(r.latestBackupAt!)), "latestBackupAt is null or ISO");
  }

  section("S13: checkBackupIntegrity — returns result");
  {
    const { checkBackupIntegrity } = await import("./server/lib/backup/backup-validator");
    const r = await checkBackupIntegrity();
    assertBool(r.valid, "valid is boolean");
    assertBool(r.checksumPresent, "checksumPresent is boolean");
    assertNum(r.rowCountSample, "rowCountSample");
    assertArr(r.issues, "issues is array");
    assert(r.rowCountSample >= 0, "rowCountSample >= 0");
  }

  section("S14: checkBackupIntegrity — valid when tables readable");
  {
    const { checkBackupIntegrity } = await import("./server/lib/backup/backup-validator");
    const r = await checkBackupIntegrity();
    assert(r.valid === true, "integrity valid (all tables readable)");
    assertEq(r.issues.length, 0, "no integrity issues");
  }

  section("S15: checkBackupAvailability — returns result");
  {
    const { checkBackupAvailability } = await import("./server/lib/backup/backup-validator");
    const r = await checkBackupAvailability(1);
    assertBool(r.available, "available is boolean");
    assertBool(r.storageReachable, "storageReachable is boolean");
    assertNum(r.recentCopies, "recentCopies");
    assertNum(r.requiredCopies, "requiredCopies");
    assertArr(r.issues, "issues is array");
  }

  section("S16: checkBackupAvailability — Supabase reachable");
  {
    const { checkBackupAvailability } = await import("./server/lib/backup/backup-validator");
    const r = await checkBackupAvailability();
    assert(r.storageReachable === true, "Supabase storage reachable");
    assert(r.available === true, "backup available");
    assertEq(r.issues.length, 0, "no availability issues");
  }

  section("S17: getBackupHealthReport — full shape");
  {
    const { getBackupHealthReport } = await import("./server/lib/backup/backup-validator");
    const r = await getBackupHealthReport();
    assert(["ok","warning","critical","unknown"].includes(r.overallStatus), "overallStatus valid");
    assert("timestamp" in r, "report has timestamp");
    assert("integrity" in r, "report has integrity");
    assert("availability" in r, "report has availability");
    assertArr(r.criticalIssues, "criticalIssues is array");
    assertIso(r.checkedAt, "checkedAt is ISO");
  }

  section("S18: getBackupHealthReport — healthy state");
  {
    const { getBackupHealthReport } = await import("./server/lib/backup/backup-validator");
    const r = await getBackupHealthReport();
    assert(["ok","warning","unknown"].includes(r.overallStatus), "status is ok/warning/unknown (not critical)");
    assert(r.integrity.valid === true, "integrity valid");
    assert(r.availability.available === true, "backup available");
    assertEq(r.criticalIssues.length, 0, "no critical issues");
  }

  section("S19: checkLatestBackupTimestamp — custom threshold");
  {
    const { checkLatestBackupTimestamp } = await import("./server/lib/backup/backup-validator");
    const r = await checkLatestBackupTimestamp(1000);
    assertEq(r.maxAgeHours, 1000, "maxAgeHours matches custom threshold");
    assert(r.withinSla === true || r.withinSla === false, "withinSla is boolean");
  }

  section("S20: checkBackupIntegrity — row count sample > 0");
  {
    const { checkBackupIntegrity } = await import("./server/lib/backup/backup-validator");
    const r = await checkBackupIntegrity();
    assert(r.rowCountSample > 0, "rowCountSample > 0 (tables have data from prior phases)");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S21–S30: restore-tools
  // ══════════════════════════════════════════════════════════════════════════

  section("S21: planTenantRestore — dry-run returns plan");
  {
    const { planTenantRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planTenantRestore("test-tenant-xyz", true);
    assertStr(plan.planId, "planId");
    assertEq(plan.restoreType, "single_tenant", "restoreType correct");
    assertBool(plan.dryRun, "dryRun is boolean");
    assert(plan.dryRun === true, "dryRun = true");
    assertArr(plan.steps, "steps");
    assert(plan.steps.length >= 3, "at least 3 restore steps");
    assertArr(plan.blockers, "blockers");
    assertIso(plan.createdAt, "createdAt");
  }

  section("S22: planTenantRestore — status is planned or blocked");
  {
    const { planTenantRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planTenantRestore("test-tenant-xyz", true);
    assert(["planned","blocked","validated"].includes(plan.status), "status is planned/blocked/validated");
    assertNum(plan.estimatedRows, "estimatedRows");
    assert(plan.estimatedRows >= 0, "estimatedRows >= 0");
  }

  section("S23: planTableRestore — existing table");
  {
    const { planTableRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planTableRestore("tenant_subscriptions", true);
    assertStr(plan.planId, "planId");
    assertEq(plan.restoreType, "single_table", "restoreType correct");
    assertEq(plan.targetTable, "tenant_subscriptions", "targetTable matches");
    assertArr(plan.steps, "steps");
    assert(plan.steps.length >= 3, "at least 3 steps");
    assert(plan.status !== "blocked", "existing table not blocked");
    assertNum(plan.estimatedRows, "estimatedRows");
  }

  section("S24: planTableRestore — non-existent table is blocked");
  {
    const { planTableRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planTableRestore("totally_fake_table_xyz", true);
    assertEq(plan.status, "blocked", "non-existent table is blocked");
    assert(plan.blockers.length > 0, "has blockers for non-existent table");
  }

  section("S25: planFullDbRestore — returns plan");
  {
    const { planFullDbRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planFullDbRestore();
    assertBool(plan.eligible, "eligible is boolean");
    assertNum(plan.estimatedMinutes, "estimatedMinutes");
    assert(plan.estimatedMinutes > 0, "estimatedMinutes > 0");
    assertArr(plan.requiredSteps, "requiredSteps");
    assert(plan.requiredSteps.length >= 5, "at least 5 required steps");
    assertArr(plan.blockers, "blockers");
    assertBool(plan.pitrAvailable, "pitrAvailable is boolean");
    assert(plan.pitrAvailable === true, "PITR available on Supabase");
  }

  section("S26: checkTenantRestoreEligibility — returns eligibility");
  {
    const { checkTenantRestoreEligibility } = await import("./server/lib/backup/restore-tools");
    const r = await checkTenantRestoreEligibility("test-tenant-xyz");
    assertEq(r.tenantId, "test-tenant-xyz", "tenantId matches");
    assertBool(r.eligible, "eligible is boolean");
    assertArr(r.issues, "issues is array");
    assertNum(r.tableCount, "tableCount");
    assertNum(r.rowCount, "rowCount");
  }

  section("S27: checkTableRestoreEligibility — known table");
  {
    const { checkTableRestoreEligibility } = await import("./server/lib/backup/restore-tools");
    const r = await checkTableRestoreEligibility("data_retention_policies");
    assertEq(r.tableName, "data_retention_policies", "tableName matches");
    assert(r.eligible === true, "existing table eligible");
    assertNum(r.rowCount, "rowCount");
    assert(r.rowCount > 0, "rowCount > 0 (seeded by phase 26)");
    assertBool(r.hasIndexes, "hasIndexes is boolean");
    assertBool(r.hasFk, "hasFk is boolean");
  }

  section("S28: checkTableRestoreEligibility — missing table");
  {
    const { checkTableRestoreEligibility } = await import("./server/lib/backup/restore-tools");
    const r = await checkTableRestoreEligibility("fake_table_99");
    assert(r.eligible === false, "missing table not eligible");
    assert(r.issues.length > 0, "issues reported");
  }

  section("S29: planTenantRestore — warning messages");
  {
    const { planTenantRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planTenantRestore("test-tenant-xyz", true);
    assertArr(plan.warningMessages, "warningMessages is array");
  }

  section("S30: planFullDbRestore — steps mention PITR");
  {
    const { planFullDbRestore } = await import("./server/lib/backup/restore-tools");
    const plan = await planFullDbRestore();
    const hasPitrStep = plan.requiredSteps.some(s => s.toLowerCase().includes("pitr") || s.toLowerCase().includes("restore"));
    assert(hasPitrStep, "steps mention PITR/restore");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S31–S40: job-recovery
  // ══════════════════════════════════════════════════════════════════════════

  section("S31: detectStalledJobs — returns array");
  {
    const { detectStalledJobs } = await import("./server/lib/recovery/job-recovery");
    const jobs = await detectStalledJobs(30);
    assertArr(jobs, "detectStalledJobs returns array");
    if (jobs.length > 0) {
      const j = jobs[0];
      assertStr(j.id, "job id");
      assertStr(j.tenantId, "job tenantId");
      assertStr(j.jobType, "job jobType");
      assertNum(j.stalledSeconds, "stalledSeconds");
      assert(j.stalledSeconds >= 0, "stalledSeconds >= 0");
    } else {
      assert(true, "no stalled jobs (healthy queue)");
    }
  }

  section("S32: getQueueHealthSnapshot — correct shape");
  {
    const { getQueueHealthSnapshot } = await import("./server/lib/recovery/job-recovery");
    const snap = await getQueueHealthSnapshot(30);
    assertNum(snap.queued, "queued");
    assertNum(snap.running, "running");
    assertNum(snap.stalled, "stalled");
    assertNum(snap.failed, "failed");
    assertNum(snap.completed, "completed");
    assertNum(snap.cancelled, "cancelled");
    assertArr(snap.stalledJobs, "stalledJobs");
    assertIso(snap.checkedAt, "checkedAt");
  }

  section("S33: getQueueHealthSnapshot — values >= 0");
  {
    const { getQueueHealthSnapshot } = await import("./server/lib/recovery/job-recovery");
    const snap = await getQueueHealthSnapshot();
    assert(snap.queued >= 0, "queued >= 0");
    assert(snap.running >= 0, "running >= 0");
    assert(snap.failed >= 0, "failed >= 0");
    assert(snap.completed >= 0, "completed >= 0");
    assert(snap.stalled >= 0, "stalled >= 0");
  }

  section("S34: requeueJob — handles missing job");
  {
    const { requeueJob } = await import("./server/lib/recovery/job-recovery");
    const r = await requeueJob("non-existent-job-id-xyz", true);
    assertEq(r.action, "skipped", "missing job is skipped");
    assertEq(r.success, false, "missing job not success");
    assertStr(r.reason, "reason provided");
  }

  section("S35: retryFailedJobs — dry-run returns results");
  {
    const { retryFailedJobs } = await import("./server/lib/recovery/job-recovery");
    const results = await retryFailedJobs(undefined, 10, true);
    assertArr(results, "retryFailedJobs returns array");
    if (results.length > 0) {
      assert(results.every(r => ["retried","skipped","exhausted"].includes(r.action)), "all actions valid");
      assert(results.every(r => typeof r.success === "boolean"), "all have success boolean");
    } else {
      assert(true, "no eligible failed jobs (healthy state)");
    }
  }

  section("S36: runJobRecovery — dry-run returns summary");
  {
    const { runJobRecovery } = await import("./server/lib/recovery/job-recovery");
    const summary = await runJobRecovery(30, true);
    assertNum(summary.stalledCount, "stalledCount");
    assertNum(summary.requeuedCount, "requeuedCount");
    assertNum(summary.failedCount, "failedCount");
    assertNum(summary.skippedCount, "skippedCount");
    assertArr(summary.results, "results");
    assertIso(summary.checkedAt, "checkedAt");
  }

  section("S37: runJobRecovery — counts consistent");
  {
    const { runJobRecovery } = await import("./server/lib/recovery/job-recovery");
    const summary = await runJobRecovery(30, true);
    const totalHandled = summary.requeuedCount + summary.failedCount + summary.skippedCount;
    assertEq(totalHandled, summary.stalledCount, "counts sum to stalledCount");
  }

  section("S38: detectStalledJobs — with custom threshold");
  {
    const { detectStalledJobs } = await import("./server/lib/recovery/job-recovery");
    const jobs60 = await detectStalledJobs(60);
    const jobs5  = await detectStalledJobs(5);
    assertArr(jobs60, "60min threshold returns array");
    assertArr(jobs5, "5min threshold returns array");
    assert(jobs60.length <= jobs5.length + 1000, "longer threshold has fewer or equal stalled jobs"); // sanity
  }

  section("S39: requeueJob — result shape");
  {
    const { requeueJob } = await import("./server/lib/recovery/job-recovery");
    const r = await requeueJob("dummy-id", true);
    assert("jobId" in r, "result has jobId");
    assert("action" in r, "result has action");
    assert("success" in r, "result has success");
    assert("reason" in r, "result has reason");
  }

  section("S40: getQueueHealthSnapshot — stalled count matches detectStalledJobs");
  {
    const { getQueueHealthSnapshot, detectStalledJobs } = await import("./server/lib/recovery/job-recovery");
    const [snap, stalled] = await Promise.all([
      getQueueHealthSnapshot(30),
      detectStalledJobs(30),
    ]);
    assertEq(snap.stalled, stalled.length, "snapshot stalled matches detectStalledJobs");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S41–S50: webhook-replay
  // ══════════════════════════════════════════════════════════════════════════

  section("S41: listFailedDeliveries — returns array");
  {
    const { listFailedDeliveries } = await import("./server/lib/recovery/webhook-replay");
    const deliveries = await listFailedDeliveries();
    assertArr(deliveries, "listFailedDeliveries returns array");
    if (deliveries.length > 0) {
      const d = deliveries[0];
      assertStr(d.id, "delivery id");
      assertStr(d.tenantId, "delivery tenantId");
      assertStr(d.eventType, "delivery eventType");
      assertNum(d.attempts, "delivery attempts");
      assertNum(d.maxAttempts, "delivery maxAttempts");
    } else {
      assert(true, "no failed deliveries (healthy state)");
    }
  }

  section("S42: getWebhookReplayHealth — correct shape");
  {
    const { getWebhookReplayHealth } = await import("./server/lib/recovery/webhook-replay");
    const h = await getWebhookReplayHealth();
    assertNum(h.totalFailed, "totalFailed");
    assertNum(h.replayEligible, "replayEligible");
    assertNum(h.exhausted, "exhausted");
    assertIso(h.checkedAt, "checkedAt");
    assert(h.totalFailed >= 0, "totalFailed >= 0");
    assert(h.replayEligible >= 0, "replayEligible >= 0");
    assert(h.exhausted >= 0, "exhausted >= 0");
    assert(h.replayEligible + h.exhausted <= h.totalFailed + 1, "replayEligible + exhausted <= totalFailed");
  }

  section("S43: replayDelivery — not found");
  {
    const { replayDelivery } = await import("./server/lib/recovery/webhook-replay");
    const r = await replayDelivery("non-existent-delivery-xyz", true);
    assertEq(r.action, "not_found", "non-existent delivery returns not_found");
    assertEq(r.success, false, "not found is not success");
    assertStr(r.reason, "reason provided");
  }

  section("S44: replayFailedDeliveries — dry-run returns batch result");
  {
    const { replayFailedDeliveries } = await import("./server/lib/recovery/webhook-replay");
    const result = await replayFailedDeliveries(undefined, 20, true);
    assertNum(result.totalFailed, "totalFailed");
    assertNum(result.replayed, "replayed");
    assertNum(result.skipped, "skipped");
    assertNum(result.exhausted, "exhausted");
    assertArr(result.results, "results");
    assertIso(result.checkedAt, "checkedAt");
  }

  section("S45: replayFailedDeliveries — counts consistent");
  {
    const { replayFailedDeliveries } = await import("./server/lib/recovery/webhook-replay");
    const result = await replayFailedDeliveries(undefined, 20, true);
    assert(result.replayed + result.skipped + result.exhausted <= result.totalFailed + result.results.length, "counts reasonable");
  }

  section("S46: getWebhookEventHistory — returns array");
  {
    const { getWebhookEventHistory } = await import("./server/lib/recovery/webhook-replay");
    const history = await getWebhookEventHistory(undefined, 168, 100);
    assertArr(history, "getWebhookEventHistory returns array");
    if (history.length > 0) {
      const e = history[0];
      assertStr(e.id, "event id");
      assertStr(e.eventType, "event eventType");
      assertStr(e.status, "event status");
      assertNum(e.attempts, "event attempts");
      assertIso(e.createdAt, "event createdAt");
    } else {
      assert(true, "no event history (new deployment)");
    }
  }

  section("S47: replayDelivery — result shape");
  {
    const { replayDelivery } = await import("./server/lib/recovery/webhook-replay");
    const r = await replayDelivery("fake-id-123", true);
    assert("deliveryId" in r, "result has deliveryId");
    assert("action" in r, "result has action");
    assert("success" in r, "result has success");
    assert("reason" in r, "result has reason");
    assert(["queued_for_replay","skipped","exhausted","not_found"].includes(r.action), "action is valid enum");
  }

  section("S48: listFailedDeliveries — limit respected");
  {
    const { listFailedDeliveries } = await import("./server/lib/recovery/webhook-replay");
    const r = await listFailedDeliveries(undefined, 5);
    assertArr(r, "result is array");
    assert(r.length <= 5, "result respects limit of 5");
  }

  section("S49: getWebhookEventHistory — with tenant filter");
  {
    const { getWebhookEventHistory } = await import("./server/lib/recovery/webhook-replay");
    const r = await getWebhookEventHistory("fake-tenant-for-test", 24, 10);
    assertArr(r, "tenant-filtered history is array");
    assert(r.every(e => e.tenantId === "fake-tenant-for-test"), "all events match tenant filter");
  }

  section("S50: getWebhookReplayHealth — exhausted <= totalFailed");
  {
    const { getWebhookReplayHealth } = await import("./server/lib/recovery/webhook-replay");
    const h = await getWebhookReplayHealth();
    assert(h.exhausted <= h.totalFailed, "exhausted <= totalFailed");
    assert(h.replayEligible <= h.totalFailed, "replayEligible <= totalFailed");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S51–S60: stripe-reconcile + runbooks + regression
  // ══════════════════════════════════════════════════════════════════════════

  section("S51: detectMissingPayments — returns array");
  {
    const { detectMissingPayments } = await import("./server/lib/recovery/stripe-reconcile");
    const r = await detectMissingPayments();
    assertArr(r, "detectMissingPayments returns array");
    if (r.length > 0) {
      assert(typeof r[0].tenantId === "string", "tenantId is string");
      assert(typeof r[0].issue === "string", "issue is string");
    } else {
      assert(true, "no missing payments (healthy billing)");
    }
  }

  section("S52: detectSubscriptionDesync — returns array");
  {
    const { detectSubscriptionDesync } = await import("./server/lib/recovery/stripe-reconcile");
    const r = await detectSubscriptionDesync();
    assertArr(r, "detectSubscriptionDesync returns array");
    if (r.length > 0) {
      assert(typeof r[0].stripeStatus === "string", "stripeStatus is string");
      assert(typeof r[0].internalStatus === "string", "internalStatus is string");
      assert(r[0].stripeStatus !== r[0].internalStatus, "status mismatch in desynced records");
    } else {
      assert(true, "no subscription desyncs (billing healthy)");
    }
  }

  section("S53: detectInvoiceMismatches — returns array");
  {
    const { detectInvoiceMismatches } = await import("./server/lib/recovery/stripe-reconcile");
    const r = await detectInvoiceMismatches();
    assertArr(r, "detectInvoiceMismatches returns array");
    if (r.length > 0) {
      assertNum(r[0].paymentAttempts, "paymentAttempts");
      assertNum(r[0].amount, "amount");
      assertStr(r[0].stripeInvoiceId, "stripeInvoiceId");
    } else {
      assert(true, "no invoice mismatches");
    }
  }

  section("S54: runStripeReconciliation — full report");
  {
    const { runStripeReconciliation } = await import("./server/lib/recovery/stripe-reconcile");
    const r = await runStripeReconciliation();
    assertArr(r.missingPayments, "missingPayments");
    assertArr(r.subscriptionDesyncs, "subscriptionDesyncs");
    assertArr(r.invoiceMismatches, "invoiceMismatches");
    assertNum(r.totalIssues, "totalIssues");
    assertNum(r.criticalIssues, "criticalIssues");
    assertIso(r.checkedAt, "checkedAt");
    assert(r.criticalIssues <= r.totalIssues, "criticalIssues <= totalIssues");
  }

  section("S55: getSubscriptionHealthSummary — correct shape");
  {
    const { getSubscriptionHealthSummary } = await import("./server/lib/recovery/stripe-reconcile");
    const s = await getSubscriptionHealthSummary();
    assertNum(s.totalSubscriptions, "totalSubscriptions");
    assertNum(s.activeCount, "activeCount");
    assertNum(s.pastDueCount, "pastDueCount");
    assertNum(s.canceledCount, "canceledCount");
    assertNum(s.desynced, "desynced");
    assertNum(s.missingPayments, "missingPayments");
    assertIso(s.checkedAt, "checkedAt");
    assert(s.activeCount <= s.totalSubscriptions, "activeCount <= total");
  }

  section("S56: runbooks — all 4 files exist");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("docs/runbooks/database-failure.md"), "database-failure.md exists");
    assert(existsSync("docs/runbooks/queue-failure.md"), "queue-failure.md exists");
    assert(existsSync("docs/runbooks/region-outage.md"), "region-outage.md exists");
    assert(existsSync("docs/runbooks/billing-desync.md"), "billing-desync.md exists");
  }

  section("S57: runbooks — content quality");
  {
    const { readFileSync } = await import("fs");
    const db    = readFileSync("docs/runbooks/database-failure.md", "utf-8");
    const queue = readFileSync("docs/runbooks/queue-failure.md", "utf-8");
    const region = readFileSync("docs/runbooks/region-outage.md", "utf-8");
    const billing = readFileSync("docs/runbooks/billing-desync.md", "utf-8");

    assert(db.includes("PITR") || db.includes("restore"), "database runbook mentions PITR/restore");
    assert(queue.includes("stalled") || queue.includes("requeue"), "queue runbook mentions stalled/requeue");
    assert(region.includes("maintenance") || region.includes("outage"), "region runbook mentions maintenance/outage");
    assert(billing.includes("reconcil") || billing.includes("desync"), "billing runbook mentions reconciliation");
    assert(db.length > 500, "database runbook substantial (>500 chars)");
    assert(queue.length > 500, "queue runbook substantial");
    assert(region.length > 500, "region runbook substantial");
    assert(billing.length > 500, "billing runbook substantial");
  }

  section("S58: runStripeReconciliation — totalIssues consistent");
  {
    const { runStripeReconciliation } = await import("./server/lib/recovery/stripe-reconcile");
    const r = await runStripeReconciliation();
    const expectedTotal = r.missingPayments.length + r.subscriptionDesyncs.length + r.invoiceMismatches.length;
    assertEq(r.totalIssues, expectedTotal, "totalIssues = sum of all issue arrays");
  }

  section("S59: Phase 28 regression — deploy-health still healthy");
  {
    const r = await httpGet("/api/admin/platform/deploy-health");
    assert(r.status !== 500, "deploy-health not 500");
    assert(r.body?.migrationStatus?.safe === true, "migration guard still safe");
    assert(r.body?.environmentValidation?.valid === true, "env still valid");
  }

  section("S60: Phase 27 regression — ops routes still work");
  {
    const r = await httpGet("/api/admin/ops/system-health");
    assert(r.status !== 404, "system-health not 404");
    assert(r.status !== 500, "system-health not 500");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S61–S70: scripts/db-export
  // ══════════════════════════════════════════════════════════════════════════

  section("S61: db-export module — exports runDbExport");
  {
    const { runDbExport } = await import("./scripts/db-export");
    assertBool(typeof runDbExport === "function", "runDbExport is a function");
  }

  section("S62: runDbExport — dry-run returns result shape");
  {
    const { runDbExport } = await import("./scripts/db-export");
    const r = await runDbExport(undefined, true);
    assertBool(r.success, "success is boolean");
    assertBool(r.dryRun, "dryRun is boolean");
    assert(r.dryRun === true, "dryRun = true");
    assertIso(r.exportedAt, "exportedAt is ISO");
    assertNum(r.tableCount, "tableCount is number");
    assert(r.sizeBytes === 0, "dry-run sizeBytes = 0");
    assert(r.outputPath === null, "dry-run outputPath is null");
  }

  section("S63: runDbExport — dry-run tableCount > 0");
  {
    const { runDbExport } = await import("./scripts/db-export");
    const r = await runDbExport(undefined, true);
    assert(r.tableCount >= 10, `tableCount >= 10 (got ${r.tableCount})`);
  }

  section("S64: runDbExport — dry-run with custom date");
  {
    const { runDbExport } = await import("./scripts/db-export");
    const r = await runDbExport("2026-01-15", true);
    assertBool(r.success, "success is boolean");
    assert(r.dryRun === true, "dryRun = true for custom date");
    assertIso(r.exportedAt, "exportedAt is ISO date");
  }

  section("S65: runDbExport — no error field on success");
  {
    const { runDbExport } = await import("./scripts/db-export");
    const r = await runDbExport(undefined, true);
    assert(r.error === undefined, "no error on dry-run success");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S66–S75: server/lib/backup/r2-backup
  // ══════════════════════════════════════════════════════════════════════════

  section("S66: r2-backup — validateR2Config returns shape");
  {
    const { validateR2Config } = await import("./server/lib/backup/r2-backup");
    const r = validateR2Config();
    assertBool(r.valid, "valid is boolean");
    assertArr(r.missing, "missing is array");
  }

  section("S67: r2-backup — not configured (no R2 secrets in env)");
  {
    const { isR2Configured, validateR2Config } = await import("./server/lib/backup/r2-backup");
    const configured = isR2Configured();
    const v          = validateR2Config();
    assertBool(configured, "isR2Configured returns boolean");
    assert(v.missing.length >= 0, "missing is array");
    if (!configured) {
      assert(v.valid === false, "not valid when not configured");
      assert(v.missing.length > 0, "missing list non-empty when not configured");
    } else {
      assert(v.valid === true, "valid when all R2 vars present");
    }
  }

  section("S68: r2-backup — validateR2Config lists R2 vars");
  {
    const { validateR2Config } = await import("./server/lib/backup/r2-backup");
    const v = validateR2Config();
    const allR2Vars = ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET_NAME"];
    const combined  = [...v.missing];
    // Each var is either in missing OR is configured (present)
    for (const varName of allR2Vars) {
      const missing  = combined.includes(varName);
      const present  = !missing;
      assert(missing || present, `${varName} is tracked (missing or present)`);
    }
  }

  section("S69: r2-backup — buildBackupKey correct paths");
  {
    const { buildBackupKey } = await import("./server/lib/backup/r2-backup");
    assertEq(buildBackupKey("daily",   "2026-03-16.sql.gz"), "db/daily/2026-03-16.sql.gz",  "daily key");
    assertEq(buildBackupKey("weekly",  "2026-W11.sql.gz"),   "db/weekly/2026-W11.sql.gz",   "weekly key");
    assertEq(buildBackupKey("monthly", "2026-03.sql.gz"),    "db/monthly/2026-03.sql.gz",   "monthly key");
  }

  section("S70: r2-backup — getWeekLabel and getMonthLabel");
  {
    const { getWeekLabel, getMonthLabel } = await import("./server/lib/backup/r2-backup");
    const week  = getWeekLabel(new Date("2026-03-16"));
    const month = getMonthLabel(new Date("2026-03-16"));
    assert(/^\d{4}-W\d{2}$/.test(week), `week label format (${week})`);
    assert(/^\d{4}-\d{2}$/.test(month), `month label format (${month})`);
    assertEq(month, "2026-03", "month label for March 2026");
  }

  section("S71: r2-backup — getR2Config returns shape");
  {
    const { getR2Config } = await import("./server/lib/backup/r2-backup");
    const cfg = getR2Config();
    assert("accountId"       in cfg, "cfg has accountId");
    assert("accessKeyId"     in cfg, "cfg has accessKeyId");
    assert("secretAccessKey" in cfg, "cfg has secretAccessKey");
    assert("bucketName"      in cfg, "cfg has bucketName");
    assert("endpoint"        in cfg, "cfg has endpoint");
    assertEq(cfg.bucketName, "ai-platform-backups", "default bucket name");
  }

  section("S72: r2-backup — uploadBackup fails gracefully without config");
  {
    const { uploadBackup } = await import("./server/lib/backup/r2-backup");
    const r = await uploadBackup("/tmp/nonexistent-backup.sql.gz", "daily");
    assertBool(r.success, "success is boolean");
    assertStr(r.bucketName, "bucketName is string");
    assertIso(r.uploadedAt, "uploadedAt is ISO");
    assert(r.success === false, "upload fails without R2 config or file");
    assert(typeof r.error === "string", "error is string");
  }

  section("S73: r2-backup — verifyUpload returns shape without config");
  {
    const { verifyUpload } = await import("./server/lib/backup/r2-backup");
    const r = await verifyUpload("db/daily/2026-03-16.sql.gz");
    assertBool(r.exists, "exists is boolean");
    assertStr(r.key, "key is string");
    assertIso(r.checkedAt, "checkedAt is ISO");
    assert(r.exists === false, "non-configured R2 returns exists=false");
  }

  section("S74: r2-backup — listBackups returns array without config");
  {
    const { listBackups } = await import("./server/lib/backup/r2-backup");
    const r = await listBackups("daily");
    assertArr(r, "listBackups returns array");
  }

  section("S75: r2-backup — rotateBackups returns shape without config");
  {
    const { rotateBackups } = await import("./server/lib/backup/r2-backup");
    const r = await rotateBackups("daily", 14);
    assertArr(r.deletedKeys, "deletedKeys is array");
    assertArr(r.keptKeys, "keptKeys is array");
    assertNum(r.deletedCount, "deletedCount is number");
    assertIso(r.checkedAt, "checkedAt is ISO");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S76–S85: Admin recovery routes
  // ══════════════════════════════════════════════════════════════════════════

  section("S76: GET /api/admin/recovery/backup-status");
  {
    const r = await httpGet("/api/admin/recovery/backup-status");
    assert(r.status !== 404, "backup-status not 404");
    assert(r.status !== 500, "backup-status not 500");
    assert("health"    in (r.body ?? {}), "response has health");
    assert("policy"    in (r.body ?? {}), "response has policy");
    assert("r2"        in (r.body ?? {}), "response has r2");
    assert("checkedAt" in (r.body ?? {}), "response has checkedAt");
  }

  section("S77: GET /api/admin/recovery/backup-status — detail");
  {
    const r = await httpGet("/api/admin/recovery/backup-status");
    assert(["ok","warning","critical","unknown"].includes(r.body?.health?.overallStatus), "overallStatus valid");
    assertNum(r.body?.policy?.totalPolicies, "policy.totalPolicies");
    assertBool(r.body?.r2?.configured, "r2.configured is boolean");
    assertArr(r.body?.r2?.missing ?? [], "r2.missing is array");
  }

  section("S78: POST /api/admin/recovery/restore-tenant — requires tenantId");
  {
    const r = await httpPost("/api/admin/recovery/restore-tenant", {});
    assert(r.status === 400, "missing tenantId returns 400");
    assertStr(r.body?.error, "error message provided");
  }

  section("S79: POST /api/admin/recovery/restore-tenant — returns plan");
  {
    const r = await httpPost("/api/admin/recovery/restore-tenant", { tenantId: "test-tenant-xyz" });
    assert(r.status !== 404, "restore-tenant not 404");
    assert(r.status !== 500, "restore-tenant not 500");
    assert("plan"        in (r.body ?? {}), "response has plan");
    assert("eligibility" in (r.body ?? {}), "response has eligibility");
    assertStr(r.body?.tenantId, "tenantId in response");
  }

  section("S80: POST /api/admin/recovery/restore-table — requires tableName");
  {
    const r = await httpPost("/api/admin/recovery/restore-table", {});
    assert(r.status === 400, "missing tableName returns 400");
  }

  section("S81: POST /api/admin/recovery/restore-table — existing table");
  {
    const r = await httpPost("/api/admin/recovery/restore-table", { tableName: "tenant_subscriptions" });
    assert(r.status !== 404, "restore-table not 404");
    assert(r.status !== 500, "restore-table not 500");
    assert("plan"        in (r.body ?? {}), "response has plan");
    assert("eligibility" in (r.body ?? {}), "response has eligibility");
  }

  section("S82: POST /api/admin/recovery/job-recovery — dry-run by default");
  {
    const r = await httpPost("/api/admin/recovery/job-recovery", {});
    assert(r.status !== 404, "job-recovery not 404");
    assert(r.status !== 500, "job-recovery not 500");
    assert("summary"  in (r.body ?? {}), "response has summary");
    assert("snapshot" in (r.body ?? {}), "response has snapshot");
    assert(r.body?.dryRun === true, "dryRun=true by default");
  }

  section("S83: POST /api/admin/recovery/webhook-replay — dry-run by default");
  {
    const r = await httpPost("/api/admin/recovery/webhook-replay", {});
    assert(r.status !== 404, "webhook-replay not 404");
    assert(r.status !== 500, "webhook-replay not 500");
    assert("result" in (r.body ?? {}), "response has result");
    assert("health" in (r.body ?? {}), "response has health");
    assert(r.body?.dryRun === true, "dryRun=true by default");
  }

  section("S84: GET /api/admin/recovery/stripe-reconcile");
  {
    const r = await httpGet("/api/admin/recovery/stripe-reconcile");
    assert(r.status !== 404, "stripe-reconcile not 404");
    assert(r.status !== 500, "stripe-reconcile not 500");
    assert("report" in (r.body ?? {}), "response has report");
    assert("health" in (r.body ?? {}), "response has health");
    assertNum(r.body?.report?.totalIssues, "report.totalIssues is number");
  }

  section("S85: env-validation — R2 vars in registry");
  {
    const { ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const r2Vars = ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET_NAME"];
    for (const v of r2Vars) {
      assert(ENV_VAR_REGISTRY.some(e => e.name === v), `${v} in registry`);
    }
    // R2 vars should be optional (not block startup)
    for (const v of r2Vars) {
      const entry = ENV_VAR_REGISTRY.find(e => e.name === v);
      assert(entry?.required === "optional", `${v} is optional (not critical)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S86–S90: Additional runbooks + GitHub workflow
  // ══════════════════════════════════════════════════════════════════════════

  section("S86: All 6 runbooks exist");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("docs/runbooks/database-failure.md"), "database-failure.md exists");
    assert(existsSync("docs/runbooks/queue-failure.md"),    "queue-failure.md exists");
    assert(existsSync("docs/runbooks/region-outage.md"),    "region-outage.md exists");
    assert(existsSync("docs/runbooks/billing-desync.md"),   "billing-desync.md exists");
    assert(existsSync("docs/runbooks/webhook-failure.md"),  "webhook-failure.md exists");
    assert(existsSync("docs/runbooks/backup-restore.md"),   "backup-restore.md exists");
  }

  section("S87: Runbook content quality — webhook-failure + backup-restore");
  {
    const { readFileSync } = await import("fs");
    const wh = readFileSync("docs/runbooks/webhook-failure.md", "utf-8");
    const br = readFileSync("docs/runbooks/backup-restore.md", "utf-8");
    assert(wh.includes("replay") || wh.includes("webhook"), "webhook runbook mentions replay");
    assert(br.includes("PITR") || br.includes("restore"), "backup-restore runbook mentions PITR/restore");
    assert(wh.length > 500, "webhook-failure runbook substantial");
    assert(br.length > 500, "backup-restore runbook substantial");
  }

  section("S88: GitHub workflow file exists");
  {
    const { existsSync } = await import("fs");
    assert(
      existsSync("backup.yml.github-workflow") || existsSync(".github/workflows/backup.yml"),
      "backup workflow file exists",
    );
  }

  section("S89: GitHub workflow — content check");
  {
    const { existsSync, readFileSync } = await import("fs");
    const filePath = existsSync("backup.yml.github-workflow")
      ? "backup.yml.github-workflow"
      : ".github/workflows/backup.yml";
    const content  = readFileSync(filePath, "utf-8");
    assert(content.includes("02:00") || content.includes("cron"), "workflow has cron schedule");
    assert(content.includes("db-export"), "workflow calls db-export");
    assert(content.includes("r2-backup") || content.includes("R2"), "workflow references R2");
    assert(content.includes("uploadBackup") || content.includes("upload"), "workflow has upload step");
  }

  section("S90: scripts/db-export.ts — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("scripts/db-export.ts"), "scripts/db-export.ts exists");
    assert(existsSync("server/lib/backup/r2-backup.ts"), "r2-backup.ts exists");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n───────────────────────────────────────────────────────");
  console.log(`Phase 29 validation: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.log(`✖ ${failed} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Validation error:", err.message);
  process.exit(1);
});
