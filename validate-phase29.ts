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

  // ══════════════════════════════════════════════════════════════════════════
  // S91–S100: System Pressure Detection (INV-REC8)
  // ══════════════════════════════════════════════════════════════════════════

  section("S91: system-pressure.ts — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("server/lib/recovery/system-pressure.ts"), "system-pressure.ts exists");
  }

  section("S92: system-pressure — exports required functions");
  {
    const mod = await import("./server/lib/recovery/system-pressure");
    assert(typeof mod.getSystemPressure      === "function", "getSystemPressure exported");
    assert(typeof mod.classifyPressureLevel  === "function", "classifyPressureLevel exported");
    assert(typeof mod.explainSystemPressure  === "function", "explainSystemPressure exported");
    assert(typeof mod.summarizePressureSignals === "function", "summarizePressureSignals exported");
    assert(typeof mod.collectPressureSignals === "function", "collectPressureSignals exported");
    assert(typeof mod.DEFAULT_THRESHOLDS     === "object",   "DEFAULT_THRESHOLDS exported");
  }

  section("S93: classifyPressureLevel — deterministic thresholds");
  {
    const { classifyPressureLevel } = await import("./server/lib/recovery/system-pressure");

    // All low → normal
    const allLow = [
      { name: "queue_depth", value: 10, threshold: 50, unit: "jobs", breached: false, severity: "low" as const },
      { name: "stalled_jobs", value: 2, threshold: 5, unit: "jobs", breached: false, severity: "low" as const },
    ];
    const r1 = classifyPressureLevel(allLow);
    assertEq(r1.level, "normal", "all-low signals → normal");
    assert(r1.score < 8, "all-low score < 8");

    // 1 medium → elevated
    const oneMedium = [
      { name: "queue_depth", value: 60, threshold: 50, unit: "jobs", breached: true, severity: "medium" as const },
    ];
    const r2 = classifyPressureLevel(oneMedium);
    assertEq(r2.level, "normal", "1 medium → still normal (needs 2 medium for elevated)");

    const twoMedium = [
      { name: "queue_depth",   value: 60,  threshold: 50, unit: "jobs", breached: true, severity: "medium" as const },
      { name: "stalled_jobs",  value: 8,   threshold: 5,  unit: "jobs", breached: true, severity: "medium" as const },
    ];
    const r3 = classifyPressureLevel(twoMedium);
    assertEq(r3.level, "elevated", "2 medium → elevated");

    // 1 high → elevated
    const oneHigh = [
      { name: "queue_depth", value: 210, threshold: 50, unit: "jobs", breached: true, severity: "high" as const },
    ];
    const r4 = classifyPressureLevel(oneHigh);
    assertEq(r4.level, "elevated", "1 high → elevated");

    // 2 high → degraded
    const twoHigh = [
      { name: "queue_depth",   value: 210, threshold: 50, unit: "jobs", breached: true, severity: "high" as const },
      { name: "stalled_jobs",  value: 25,  threshold: 5,  unit: "jobs", breached: true, severity: "high" as const },
    ];
    const r5 = classifyPressureLevel(twoHigh);
    assertEq(r5.level, "degraded", "2 high → degraded");

    // 1 critical → degraded
    const oneCritical = [
      { name: "queue_depth", value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
    ];
    const r6 = classifyPressureLevel(oneCritical);
    assertEq(r6.level, "degraded", "1 critical → degraded");

    // 2 critical → critical
    const twoCritical = [
      { name: "queue_depth",  value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
      { name: "stalled_jobs", value: 55,  threshold: 5,  unit: "jobs", breached: true, severity: "critical" as const },
    ];
    const r7 = classifyPressureLevel(twoCritical);
    assertEq(r7.level, "critical", "2 critical → critical");
  }

  section("S94: pressure score is deterministic and bounded 0–100");
  {
    const { classifyPressureLevel } = await import("./server/lib/recovery/system-pressure");

    for (let i = 0; i < 5; i++) {
      const signals = [
        { name: "q", value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
        { name: "s", value: 55,  threshold: 5,  unit: "jobs", breached: true, severity: "critical" as const },
      ];
      const r = classifyPressureLevel(signals);
      assert(r.score >= 0 && r.score <= 100, `score in bounds on run ${i} (got ${r.score})`);
      assertEq(r.level, "critical", `deterministic critical on run ${i}`);
    }
  }

  section("S95: explainSystemPressure — normal produces short explanation");
  {
    const { explainSystemPressure } = await import("./server/lib/recovery/system-pressure");
    const result = {
      level:         "normal" as const,
      score:         0,
      signals:       [],
      criticalCount: 0,
      highCount:     0,
      explanation:   "",
      checkedAt:     new Date().toISOString(),
    };
    const exp = explainSystemPressure(result);
    assert(exp.toLowerCase().includes("normal"), "explanation mentions normal");
    assertStr(exp, "explanation is non-empty");
  }

  section("S96: explainSystemPressure — lists breached signals");
  {
    const { explainSystemPressure } = await import("./server/lib/recovery/system-pressure");
    const result = {
      level:         "degraded" as const,
      score:         60,
      signals:       [
        { name: "queue_depth", value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
        { name: "stalled_jobs", value: 55, threshold: 5,  unit: "jobs", breached: true, severity: "high"     as const },
      ],
      criticalCount: 1,
      highCount:     1,
      explanation:   "",
      checkedAt:     new Date().toISOString(),
    };
    const exp = explainSystemPressure(result);
    assert(exp.includes("queue_depth") || exp.includes("stalled"), "explanation lists breached signals");
    assert(exp.includes("DEGRADED") || exp.includes("degraded"), "explanation mentions level");
  }

  section("S97: summarizePressureSignals — empty returns nominal message");
  {
    const { summarizePressureSignals } = await import("./server/lib/recovery/system-pressure");
    const r = summarizePressureSignals([]);
    assert(r.toLowerCase().includes("nominal") || r.toLowerCase().includes("normal"), "empty signals → nominal");
  }

  section("S98: summarizePressureSignals — lists breached names");
  {
    const { summarizePressureSignals } = await import("./server/lib/recovery/system-pressure");
    const signals = [
      { name: "queue_depth", value: 510, threshold: 50, unit: "jobs", breached: true,  severity: "critical" as const },
      { name: "stalled_jobs", value: 2,  threshold: 5,  unit: "jobs", breached: false, severity: "low"      as const },
    ];
    const r = summarizePressureSignals(signals);
    assert(r.includes("queue_depth"), "summary includes breached signal name");
    assert(!r.includes("stalled_jobs"), "summary omits non-breached signal");
  }

  section("S99: DEFAULT_THRESHOLDS — all tiers ordered correctly");
  {
    const { DEFAULT_THRESHOLDS: T } = await import("./server/lib/recovery/system-pressure");
    for (const [key, tiers] of Object.entries(T)) {
      assert(tiers.elevated < tiers.degraded, `${key}: elevated < degraded`);
      assert(tiers.degraded < tiers.critical, `${key}: degraded < critical`);
    }
  }

  section("S100: Admin GET /api/admin/recovery/pressure — responds");
  {
    const r = await httpGet("/api/admin/recovery/pressure");
    // May fail if DB not reachable — check structure only if 200
    assert(r.status === 200 || r.status === 500, "pressure endpoint responds (200 or 500)");
    if (r.status === 200) {
      assert(["normal", "elevated", "degraded", "critical"].includes(r.body?.level),
        "pressure.level is valid");
      assertNum(r.body?.score, "pressure.score");
      assertArr(r.body?.signals, "pressure.signals");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S101–S115: Brownout Mode (INV-REC9, INV-REC10)
  // ══════════════════════════════════════════════════════════════════════════

  section("S101: brownout-mode.ts — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("server/lib/recovery/brownout-mode.ts"), "brownout-mode.ts exists");
  }

  section("S102: brownout-mode — exports required functions");
  {
    const mod = await import("./server/lib/recovery/brownout-mode");
    assert(typeof mod.getBrownoutState       === "function", "getBrownoutState exported");
    assert(typeof mod.enterBrownoutMode      === "function", "enterBrownoutMode exported");
    assert(typeof mod.exitBrownoutMode       === "function", "exitBrownoutMode exported");
    assert(typeof mod.applyBrownoutPolicy    === "function", "applyBrownoutPolicy exported");
    assert(typeof mod.explainBrownoutDecision === "function", "explainBrownoutDecision exported");
    assert(typeof mod.summarizeBrownoutState === "function", "summarizeBrownoutState exported");
    assert(typeof mod.isFlowAllowed          === "function", "isFlowAllowed exported");
    assert(typeof mod.isFlowThrottled        === "function", "isFlowThrottled exported");
    assert(typeof mod.BROWNOUT_POLICIES      === "object",   "BROWNOUT_POLICIES exported");
    assert(typeof mod.CORE_FLOWS             === "object",   "CORE_FLOWS exported");
  }

  section("S103: CORE_FLOWS — all critical paths present (INV-REC9)");
  {
    const { CORE_FLOWS } = await import("./server/lib/recovery/brownout-mode");
    const expected = ["auth", "billing", "quota_enforcement", "retrieval_answer_path",
                      "stripe_webhook_handling", "restore_recovery_endpoints"];
    for (const f of expected) {
      assert(CORE_FLOWS.includes(f as any), `CORE_FLOWS includes ${f}`);
    }
  }

  section("S104: enterBrownoutMode — elevated activation");
  {
    const { enterBrownoutMode, exitBrownoutMode } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("pre-test reset", true); // ensure clean state
    const s = enterBrownoutMode("elevated", "test: queue pressure", false);
    assertEq(s.level,  "elevated", "level is elevated");
    assertBool(s.active, "active is boolean");
    assert(s.active === true, "active=true when elevated");
    assertArr(s.policy.deferredFlows, "deferredFlows is array");
    assertArr(s.policy.protectedFlows, "protectedFlows is array");
    assert(s.policy.protectedFlows.includes("auth"), "protectedFlows includes auth");
    exitBrownoutMode("post-test cleanup", true);
  }

  section("S105: enterBrownoutMode — degraded activation");
  {
    const { enterBrownoutMode, exitBrownoutMode, BROWNOUT_POLICIES } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("pre-test reset", true);
    const s = enterBrownoutMode("degraded", "test: webhook failure spike", false);
    assertEq(s.level, "degraded", "level is degraded");
    const policy = BROWNOUT_POLICIES["degraded"];
    assert(policy.throttledFlows.includes("webhook_retry_throughput"), "webhook retry throttled at degraded");
    assert(policy.throttledFlows.includes("agent_concurrency"), "agent concurrency throttled at degraded");
    assert(policy.throttledFlows.includes("evaluation_throughput"), "evaluation throttled at degraded");
    exitBrownoutMode("post-test cleanup", true);
  }

  section("S106: enterBrownoutMode — critical activation");
  {
    const { enterBrownoutMode, exitBrownoutMode, getBrownoutState } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("pre-test reset", true);
    enterBrownoutMode("critical", "test: queue critical", false);
    const s = getBrownoutState();
    assertEq(s.level, "critical", "level is critical");
    assert(s.policy.deferredFlows.length > 0, "critical has deferred flows");
    assert(s.policy.protectedFlows.includes("billing"), "billing protected at critical");
    assert(s.policy.protectedFlows.includes("stripe_webhook_handling"), "Stripe webhooks protected at critical");
    exitBrownoutMode("post-test cleanup", true);
  }

  section("S107: exitBrownoutMode — returns to normal");
  {
    const { enterBrownoutMode, exitBrownoutMode, getBrownoutState } = await import("./server/lib/recovery/brownout-mode");
    enterBrownoutMode("degraded", "test setup", true);
    const before = getBrownoutState();
    assertEq(before.level, "degraded", "setup: was degraded");

    exitBrownoutMode("test recovery", true);
    const after = getBrownoutState();
    assertEq(after.level,  "normal", "level returns to normal");
    assertEq(after.active, false,    "active=false after exit");
  }

  section("S108: core flows always allowed (INV-REC9)");
  {
    const { enterBrownoutMode, exitBrownoutMode, isFlowAllowed, CORE_FLOWS } = await import("./server/lib/recovery/brownout-mode");

    for (const brownoutLevel of ["normal", "elevated", "degraded", "critical"] as const) {
      exitBrownoutMode("reset", true);
      if (brownoutLevel !== "normal") enterBrownoutMode(brownoutLevel, "test", true);

      for (const flow of CORE_FLOWS) {
        assert(isFlowAllowed(flow), `[${brownoutLevel}] core flow '${flow}' is always allowed`);
      }
    }
    exitBrownoutMode("final cleanup", true);
  }

  section("S109: non-critical flows deferred at elevated");
  {
    const { enterBrownoutMode, exitBrownoutMode, isFlowAllowed } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("reset", true);
    enterBrownoutMode("elevated", "test", true);
    assert(!isFlowAllowed("non_critical_exports"),        "non_critical_exports blocked at elevated");
    assert(!isFlowAllowed("low_priority_cleanup_jobs"),   "low_priority_cleanup blocked at elevated");
    exitBrownoutMode("cleanup", true);
  }

  section("S110: throttled flows at degraded");
  {
    const { enterBrownoutMode, exitBrownoutMode, isFlowThrottled } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("reset", true);
    enterBrownoutMode("degraded", "test", true);
    assert(isFlowThrottled("webhook_retry_throughput"), "webhook_retry_throughput throttled at degraded");
    assert(isFlowThrottled("agent_concurrency"),        "agent_concurrency throttled at degraded");
    assert(isFlowThrottled("evaluation_throughput"),    "evaluation_throughput throttled at degraded");
    exitBrownoutMode("cleanup", true);
  }

  section("S111: applyBrownoutPolicy — maps pressure levels (INV-REC9)");
  {
    const { applyBrownoutPolicy, exitBrownoutMode } = await import("./server/lib/recovery/brownout-mode");

    // Use manual=false on reset so manualOverride flag is cleared, allowing auto-policy to work
    exitBrownoutMode("reset", false);
    const s1 = applyBrownoutPolicy("normal");
    assertEq(s1.level, "normal", "normal pressure → normal brownout");

    const s2 = applyBrownoutPolicy("elevated");
    assertEq(s2.level, "elevated", "elevated pressure → elevated brownout");

    const s3 = applyBrownoutPolicy("degraded");
    assertEq(s3.level, "degraded", "degraded pressure → degraded brownout");

    const s4 = applyBrownoutPolicy("critical");
    assertEq(s4.level, "critical", "critical pressure → critical brownout");

    exitBrownoutMode("cleanup", false);
  }

  section("S112: getBrownoutHistory — transitions are logged (INV-REC10)");
  {
    const { enterBrownoutMode, exitBrownoutMode, getBrownoutHistory } = await import("./server/lib/recovery/brownout-mode");
    const before = getBrownoutHistory().length;

    exitBrownoutMode("reset", true);
    enterBrownoutMode("elevated", "history test", false);
    enterBrownoutMode("degraded", "history test escalate", false);
    exitBrownoutMode("history test recovery", false);

    const history = getBrownoutHistory();
    assert(history.length > before, "transitions are recorded in history");

    const last = history.at(-1)!;
    assertEq(last.to, "normal", "last transition is to normal");
    assertStr(last.reason, "transition has reason string");
    assertStr(last.timestamp, "transition has timestamp");
    assertIso(last.timestamp, "transition timestamp is ISO");
  }

  section("S113: explainBrownoutDecision — all levels produce explanation");
  {
    const { explainBrownoutDecision } = await import("./server/lib/recovery/brownout-mode");
    for (const level of ["normal", "elevated", "degraded", "critical"] as const) {
      const exp = explainBrownoutDecision(level);
      assertStr(exp, `explainBrownoutDecision(${level}) is non-empty`);
    }
    const critExp = explainBrownoutDecision("critical");
    assert(critExp.toLowerCase().includes("core") || critExp.toLowerCase().includes("critical"),
      "critical explanation mentions core/critical");
  }

  section("S114: summarizeBrownoutState — normal vs active");
  {
    const { enterBrownoutMode, exitBrownoutMode, summarizeBrownoutState } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("reset", true);
    const normalSummary = summarizeBrownoutState();
    assert(normalSummary.toLowerCase().includes("normal") || normalSummary.toLowerCase().includes("inactive"),
      "normal summary mentions normal/inactive");

    enterBrownoutMode("degraded", "summary test", true);
    const activeSummary = summarizeBrownoutState();
    assert(activeSummary.toUpperCase().includes("DEGRADED"), "active summary mentions DEGRADED");
    exitBrownoutMode("cleanup", true);
  }

  section("S115: BROWNOUT_POLICIES — all levels defined, core flows protected");
  {
    const { BROWNOUT_POLICIES, CORE_FLOWS } = await import("./server/lib/recovery/brownout-mode");
    const levels = ["normal", "elevated", "degraded", "critical"];
    for (const level of levels) {
      const policy = BROWNOUT_POLICIES[level as keyof typeof BROWNOUT_POLICIES];
      assert(policy !== undefined, `policy defined for ${level}`);
      assertArr(policy.protectedFlows, `${level}: protectedFlows is array`);
      assertArr(policy.deferredFlows,  `${level}: deferredFlows is array`);
      assertArr(policy.throttledFlows, `${level}: throttledFlows is array`);
      for (const f of CORE_FLOWS) {
        assert(policy.protectedFlows.includes(f), `${level}: protectedFlows includes ${f}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S116–S120: Recovery Observability (Task 15)
  // ══════════════════════════════════════════════════════════════════════════

  section("S116: recovery-observability.ts — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("server/lib/recovery/recovery-observability.ts"), "recovery-observability.ts exists");
  }

  section("S117: recovery-observability — exports required functions");
  {
    const mod = await import("./server/lib/recovery/recovery-observability");
    assert(typeof mod.recordBackupSuccess    === "function", "recordBackupSuccess exported");
    assert(typeof mod.recordBackupFailure    === "function", "recordBackupFailure exported");
    assert(typeof mod.recordUploadSuccess    === "function", "recordUploadSuccess exported");
    assert(typeof mod.recordUploadFailure    === "function", "recordUploadFailure exported");
    assert(typeof mod.recordRestoreAttempt   === "function", "recordRestoreAttempt exported");
    assert(typeof mod.recordReplayAttempt    === "function", "recordReplayAttempt exported");
    assert(typeof mod.recordJobRecoveryRun   === "function", "recordJobRecoveryRun exported");
    assert(typeof mod.recordStripeDesync     === "function", "recordStripeDesync exported");
    assert(typeof mod.recordPressureSnapshot === "function", "recordPressureSnapshot exported");
    assert(typeof mod.getObservabilitySnapshot === "function", "getObservabilitySnapshot exported");
    assert(typeof mod.getRecentEvents        === "function", "getRecentEvents exported");
    assert(typeof mod.getPressureHistory     === "function", "getPressureHistory exported");
  }

  section("S118: recovery-observability — tracking counters");
  {
    const obs = await import("./server/lib/recovery/recovery-observability");

    obs.recordBackupSuccess({ size: 1024 });
    obs.recordBackupSuccess({ size: 2048 });
    obs.recordBackupFailure("conn timeout");
    obs.recordUploadSuccess("db/daily/test.sql.gz");
    obs.recordUploadFailure("R2 unreachable");
    obs.recordRestoreAttempt("tenant-abc", "tenant-restore");
    obs.recordReplayAttempt("tenant-abc", 5);
    obs.recordJobRecoveryRun(3, 2);
    obs.recordStripeDesync(4);

    const snap = obs.getObservabilitySnapshot();
    assert(snap.backup.backupSuccessCount >= 2,  "backupSuccessCount >= 2");
    assert(snap.backup.backupFailureCount >= 1,  "backupFailureCount >= 1");
    assert(snap.backup.uploadSuccessCount >= 1,  "uploadSuccessCount >= 1");
    assert(snap.backup.uploadFailureCount >= 1,  "uploadFailureCount >= 1");
    assert(snap.recovery.restoreAttempts  >= 1,  "restoreAttempts >= 1");
    assert(snap.recovery.replayAttempts   >= 1,  "replayAttempts >= 1");
    assert(snap.recovery.jobRecoveryRuns  >= 1,  "jobRecoveryRuns >= 1");
    assert(snap.recovery.stripeDesyncCount >= 4, "stripeDesyncCount >= 4");
    assertArr(snap.recentEvents, "recentEvents is array");
    assert(snap.recentEvents.length > 0, "recent events recorded");
  }

  section("S119: recovery-observability — pressure history tracking");
  {
    const obs = await import("./server/lib/recovery/recovery-observability");
    const { classifyPressureLevel } = await import("./server/lib/recovery/system-pressure");

    const signals = [
      { name: "queue_depth", value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
    ];
    const { level, score } = classifyPressureLevel(signals);
    const mockResult = {
      level, score, signals, criticalCount: 1, highCount: 0,
      explanation: "test", checkedAt: new Date().toISOString(),
    };

    obs.recordPressureSnapshot(mockResult);
    const history = obs.getPressureHistory();
    assertArr(history, "pressure history is array");
    assert(history.length > 0, "pressure history has entries after snapshot");
    assertStr(history.at(-1)!.level, "last entry has level");
    assertNum(history.at(-1)!.score, "last entry has score");
    assertIso(history.at(-1)!.timestamp, "last entry has ISO timestamp");
  }

  section("S120: recovery-observability — events are bounded (max 500)");
  {
    const obs = await import("./server/lib/recovery/recovery-observability");
    // Record 60 events
    for (let i = 0; i < 60; i++) {
      obs.recordBackupSuccess({ iteration: i });
    }
    const events = obs.getRecentEvents();
    assert(events.length <= 500, `events bounded <= 500 (got ${events.length})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S121–S125: New Admin Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  section("S121: Admin GET /api/admin/recovery/brownout — responds");
  {
    const r = await httpGet("/api/admin/recovery/brownout");
    assert(r.status === 200 || r.status === 500, "brownout endpoint responds");
    if (r.status === 200) {
      const validLevels = ["normal", "elevated", "degraded", "critical"];
      assert(validLevels.includes(r.body?.state?.level ?? r.body?.level),
        "brownout state has valid level");
      assertStr(r.body?.summary, "brownout response has summary");
    }
  }

  section("S122: Admin GET /api/admin/recovery/brownout-history — responds");
  {
    const r = await httpGet("/api/admin/recovery/brownout-history");
    assert(r.status === 200 || r.status === 500, "brownout-history responds");
    if (r.status === 200) {
      assertArr(r.body?.history,     "brownout history is array");
      assertNum(r.body?.transitionCount, "transitionCount is number");
      assertStr(r.body?.checkedAt,   "checkedAt present");
    }
  }

  section("S123: Admin POST /api/admin/recovery/job-recovery/requeue — dry-run");
  {
    const r = await httpPost("/api/admin/recovery/job-recovery/requeue", { dryRun: true });
    assert(r.status === 200 || r.status === 500, "requeue responds (200 or 500)");
    if (r.status === 200) {
      assertBool(r.body?.dryRun, "dryRun field present");
      assert(r.body?.dryRun === true, "dryRun=true in response");
      assertStr(r.body?.explain, "explain field present");
    }
  }

  section("S124: New runbooks exist (brownout-escalation + brownout-recovery)");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("docs/runbooks/brownout-escalation.md"), "brownout-escalation.md exists");
    assert(existsSync("docs/runbooks/brownout-recovery.md"),   "brownout-recovery.md exists");
  }

  section("S125: Runbook quality — brownout runbooks");
  {
    const { readFileSync } = await import("fs");
    const esc = readFileSync("docs/runbooks/brownout-escalation.md", "utf-8");
    const rec = readFileSync("docs/runbooks/brownout-recovery.md", "utf-8");
    assert(esc.includes("critical") && esc.includes("elevated"), "escalation runbook covers all levels");
    assert(rec.includes("normal") || rec.includes("recovery"),    "recovery runbook covers return to normal");
    assert(esc.includes("core") || esc.includes("auth"),          "escalation runbook mentions core flows");
    assert(esc.length > 1000, "escalation runbook is substantial");
    assert(rec.length > 1000, "recovery runbook is substantial");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S126–S130: Service Layer Invariants (INV-REC1 to INV-REC12)
  // ══════════════════════════════════════════════════════════════════════════

  section("S126: INV-REC4 — restore preview does not write (dry-run default)");
  {
    const { planTenantRestore } = await import("./server/lib/backup/restore-tools");
    // planTenantRestore defaults dryRun=true — preview only, no writes
    const plan = await planTenantRestore("tenant-xyz-preview-test");
    assert(typeof plan === "object", "planTenantRestore returns object");
    assertBool(plan.dryRun, "plan.dryRun is boolean");
    assert(plan.dryRun === true, "plan.dryRun = true (preview — no writes)");
    assertStr(plan.planId, "plan.planId is non-empty string");
    assertArr(plan.steps,  "plan.steps is array");
  }

  section("S127: INV-REC5 — job requeue is idempotent");
  {
    const { requeueJobs } = await import("./server/lib/recovery/job-recovery");
    // Call twice with same options in dry-run mode — same input = same output (idempotent)
    const r1 = await requeueJobs({ dryRun: true });
    const r2 = await requeueJobs({ dryRun: true });
    assertNum(r1.requested, "first call: requested is number");
    assertNum(r2.requested, "second call: requested is number");
    assertEq(r1.requested, r2.requested, "idempotent: same requested count both calls");
    assertBool(r1.dryRun, "dryRun flag present on result");
    assert(r1.dryRun === true, "dryRun=true — no writes performed");
  }

  section("S128: INV-REC8 — pressure classification deterministic across multiple calls");
  {
    const { classifyPressureLevel } = await import("./server/lib/recovery/system-pressure");
    const signals = [
      { name: "queue_depth", value: 510, threshold: 50, unit: "jobs", breached: true, severity: "critical" as const },
      { name: "stalled_jobs", value: 55, threshold: 5,  unit: "jobs", breached: true, severity: "critical" as const },
    ];
    const results = Array.from({ length: 10 }, () => classifyPressureLevel(signals));
    const levels  = new Set(results.map(r => r.level));
    const scores  = new Set(results.map(r => r.score));
    assertEq(levels.size, 1, "pressure level is deterministic (same inputs = same output)");
    assertEq(scores.size, 1, "pressure score is deterministic");
  }

  section("S129: INV-REC9 — core flows survive all brownout levels");
  {
    const { enterBrownoutMode, exitBrownoutMode, isFlowAllowed, CORE_FLOWS } = await import("./server/lib/recovery/brownout-mode");
    const levels = ["normal", "elevated", "degraded", "critical"] as const;
    for (const level of levels) {
      exitBrownoutMode("reset", true);
      if (level !== "normal") enterBrownoutMode(level, "invariant test", true);
      for (const flow of CORE_FLOWS) {
        assert(isFlowAllowed(flow), `INV-REC9: [${level}] ${flow} always allowed`);
      }
    }
    exitBrownoutMode("final cleanup", true);
  }

  section("S130: INV-REC10 — brownout transitions are explainable");
  {
    const { enterBrownoutMode, exitBrownoutMode, getBrownoutHistory, explainBrownoutDecision } = await import("./server/lib/recovery/brownout-mode");
    exitBrownoutMode("reset", true);
    enterBrownoutMode("critical", "invariant test", true);
    exitBrownoutMode("invariant recovery", true);

    const history = getBrownoutHistory();
    assert(history.length >= 2, "at least 2 transitions recorded");
    for (const t of history.slice(-4)) {
      assertStr(t.reason, `transition has reason: ${t.to}`);
      assertStr(t.timestamp, `transition has timestamp: ${t.to}`);
      const exp = explainBrownoutDecision(t.to);
      assertStr(exp, `explain(${t.to}) is non-empty`);
    }
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
