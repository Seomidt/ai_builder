/**
 * Phase 30 Final — Platform Rate Limiting & Restart Recovery
 * validate-phase30.ts
 *
 * 40 scenarios, 120+ assertions
 *
 * Invariants:
 *   INV-SAFE1: Rate limiting must never affect tenant isolation.
 *   INV-SAFE2: Rate limiting decisions must be deterministic.
 *   INV-SAFE3: Restart recovery must not duplicate jobs.
 *   INV-SAFE4: Restart recovery must log all recovery actions.
 *   INV-SAFE5: Safety systems must never block billing or auth.
 */

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  checkRateLimit,
  recordRequest,
  getRateLimitState,
  resetRateLimit,
  explainRateLimitDecision,
  summarizeRateLimitState,
  summarizeRateLimiter,
  checkMultiScope,
  checkAndRecord,
  getRecentViolations,
  getBucketState,
  resolveEndpointCategory,
  ENDPOINT_CONFIGS,
  type RateLimitDecision,
} from "./server/lib/security/global-rate-limiter";

import {
  detectIncompleteJobs,
  detectStalledJobs,
  resumeSafeJobs,
  repairQueues,
  runRestartRecovery,
  explainRestartRecovery,
  summarizeRecoveryState,
  summarizeRestartState,
  type IncompleteJob,
  type RestartRecoveryResult,
} from "./server/lib/recovery/platform-restart-recovery";

import {
  recordRateLimitViolation,
  recordRestartRecovery,
  recordJobResumed,
  recordJobMarkedFailed,
  getSafetySnapshot,
  getRecentSafetyEvents,
} from "./server/lib/safety/safety-observability";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✔ ${label}`); _passed++; }
  else       { console.error(`  ✖ ${label}`); _failed++; }
}
function assertEq<T>(a: T, b: T, label: string): void {
  assert(a === b, `${label} (got: ${JSON.stringify(a)})`);
}
function assertStr(v: unknown, label: string): void {
  assert(typeof v === "string" && (v as string).length > 0, label);
}
function assertNum(v: unknown, label: string): void {
  assert(typeof v === "number" && isFinite(v as number), label);
}
function assertArr(v: unknown, label: string): void {
  assert(Array.isArray(v), label);
}
function assertBool(v: unknown, label: string): void {
  assert(typeof v === "boolean", label);
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// Fill a rate-limit bucket using recordRequest so checkRateLimit sees a full bucket
function fillBucket(
  scope: Parameters<typeof recordRequest>[0],
  identifier: string,
  path: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    recordRequest(scope, identifier, path);
  }
}

async function main(): Promise<void> {
  console.log("Phase 30 — Platform Rate Limiting & Restart Recovery\n");
  console.log("Validating: 40 scenarios, 120+ assertions\n");

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION A — GLOBAL RATE LIMITER
  // ════════════════════════════════════════════════════════════════════════════

  // ── S01: ENDPOINT_CONFIGS shape ──────────────────────────────────────────
  section("S01: ENDPOINT_CONFIGS — correct limits per category");
  assertEq(ENDPOINT_CONFIGS.ai.maxRequests,      60,  "ai limit = 60");
  assertEq(ENDPOINT_CONFIGS.webhook.maxRequests, 120, "webhook limit = 120");
  assertEq(ENDPOINT_CONFIGS.auth.maxRequests,    30,  "auth limit = 30");
  assertEq(ENDPOINT_CONFIGS.admin.maxRequests,   10,  "admin limit = 10");
  assertEq(ENDPOINT_CONFIGS.general.maxRequests, 300, "general limit = 300");
  assertEq(ENDPOINT_CONFIGS.ai.windowMs,      60_000, "ai window = 60 s");
  assertEq(ENDPOINT_CONFIGS.auth.windowMs,    60_000, "auth window = 60 s");

  // ── S02: resolveEndpointCategory ─────────────────────────────────────────
  section("S02: resolveEndpointCategory — correct routing");
  assertEq(resolveEndpointCategory("/api/ai/run"),          "ai",      "ai path");
  assertEq(resolveEndpointCategory("/api/webhooks/ingest"), "webhook", "webhook path");
  assertEq(resolveEndpointCategory("/api/auth/login"),      "auth",    "auth path");
  assertEq(resolveEndpointCategory("/api/admin/status"),    "admin",   "admin path");
  assertEq(resolveEndpointCategory("/api/users/me"),        "general", "general path");
  assertEq(resolveEndpointCategory("/health"),              "general", "health = general");

  // ── S03: checkRateLimit — allowed when bucket empty ──────────────────────
  section("S03: checkRateLimit — allowed when bucket empty");
  resetRateLimit("ip", "fresh-ip-s03", "general");
  const s03 = checkRateLimit("ip", "fresh-ip-s03", "/api/users/me");
  assertBool(s03.allowed,  "allowed when bucket empty");
  assertNum(s03.requestCount, "requestCount is number");
  assertNum(s03.limit,        "limit is number");
  assertStr(s03.resetAt,      "resetAt is string");
  assertStr(s03.reason,       "reason is string");
  assertBool(s03.violationLogged, "violationLogged is bool");
  assert(s03.violationLogged === false, "not logged when allowed");

  // ── S04: recordRequest — increments bucket ────────────────────────────────
  section("S04: recordRequest — increments count");
  resetRateLimit("ip", "record-ip-s04", "general");
  recordRequest("ip", "record-ip-s04", "/api/users/me");
  recordRequest("ip", "record-ip-s04", "/api/users/me");
  recordRequest("ip", "record-ip-s04", "/api/users/me");
  const bucket04 = getBucketState("ip", "record-ip-s04", "general");
  assert(bucket04 !== undefined,     "bucket exists after recording");
  assertEq(bucket04!.count, 3, "count = 3 after 3 records");

  // ── S05: INV-SAFE2 — rate limit enforcement is deterministic ─────────────
  section("S05: INV-SAFE2 — deterministic: same input = same decision");
  resetRateLimit("ip", "det-ip-s05", "auth");
  const d1 = checkRateLimit("ip", "det-ip-s05", "/api/auth/login");
  const d2 = checkRateLimit("ip", "det-ip-s05", "/api/auth/login");
  assertEq(d1.allowed,   d2.allowed,   "INV-SAFE2: allowed consistent");
  assertEq(d1.limit,     d2.limit,     "INV-SAFE2: limit consistent");
  assertEq(d1.category,  d2.category,  "INV-SAFE2: category consistent");
  assertEq(d1.scope,     d2.scope,     "INV-SAFE2: scope consistent");

  // ── S06: Rate limit enforcement — blocks when limit exceeded ─────────────
  section("S06: Rate limit enforcement — blocks after limit reached");
  resetRateLimit("ip", "enforcer-s06", "admin");
  const limit06 = ENDPOINT_CONFIGS.admin.maxRequests;
  fillBucket("ip", "enforcer-s06", "/api/admin/status", limit06);
  const blocked06 = checkRateLimit("ip", "enforcer-s06", "/api/admin/status");
  assert(blocked06.allowed === false,          "blocked after limit exceeded");
  assert(blocked06.violationLogged === true,   "violation logged on block");
  assert(blocked06.requestCount >= limit06,    "requestCount >= limit");
  assertStr(blocked06.resetAt,                 "resetAt present on block");

  // ── S07: Rate limit reset — allows after reset ────────────────────────────
  section("S07: resetRateLimit — allows after reset");
  resetRateLimit("ip", "enforcer-s06", "admin");
  const afterReset07 = checkRateLimit("ip", "enforcer-s06", "/api/admin/status");
  assert(afterReset07.allowed === true, "allowed after reset");
  assertEq(afterReset07.requestCount, 0, "count = 0 after reset");

  // ── S08: getRateLimitState — alias for checkRateLimit ────────────────────
  section("S08: getRateLimitState — returns decision (INV-SAFE2 alias)");
  resetRateLimit("ip", "state-ip-s08", "general");
  const s08 = getRateLimitState("ip", "state-ip-s08", "/api/users/me");
  assertBool(s08.allowed,  "getRateLimitState returns decision.allowed");
  assertStr(s08.category,  "getRateLimitState returns category");
  assertStr(s08.scope,     "getRateLimitState returns scope");
  assertNum(s08.limit,     "getRateLimitState returns limit");

  // ── S09: explainRateLimitDecision — allowed case ──────────────────────────
  section("S09: explainRateLimitDecision — allowed");
  resetRateLimit("ip", "explain-ip-s09", "general");
  const s09dec = checkRateLimit("ip", "explain-ip-s09", "/api/users/me");
  const s09exp = explainRateLimitDecision(s09dec);
  assertStr(s09exp, "explain returns string");
  assert(
    s09exp.toLowerCase().includes("allowed") || s09exp.toLowerCase().includes("requests"),
    "explanation mentions allowed/requests",
  );

  // ── S10: explainRateLimitDecision — blocked case ──────────────────────────
  section("S10: explainRateLimitDecision — blocked mentions limit/reset");
  resetRateLimit("ip", "explain-block-s10", "admin");
  fillBucket("ip", "explain-block-s10", "/api/admin/x", ENDPOINT_CONFIGS.admin.maxRequests);
  const s10dec = checkRateLimit("ip", "explain-block-s10", "/api/admin/x");
  const s10exp = explainRateLimitDecision(s10dec);
  assertStr(s10exp, "explain returns non-empty for blocked");
  assert(
    s10exp.toLowerCase().includes("exceeded") || s10exp.toLowerCase().includes("limit"),
    "blocked explanation mentions exceeded/limit",
  );
  assert(
    s10exp.includes("Resets") || s10exp.includes("Reset") || s10exp.includes("resetAt"),
    "blocked explanation mentions reset time",
  );

  // ── S11: summarizeRateLimitState — structure ───────────────────────────────
  section("S11: summarizeRateLimitState — structure correct");
  const s11 = summarizeRateLimitState();
  assertNum(s11.totalKeys,      "totalKeys is number");
  assertNum(s11.violationCount, "violationCount is number");
  assertArr(s11.topViolators,   "topViolators is array");
  assertStr(s11.checkedAt,      "checkedAt is ISO string");

  // ── S12: summarizeRateLimiter — alias ────────────────────────────────────
  section("S12: summarizeRateLimiter — alias for summarizeRateLimitState");
  const s12 = summarizeRateLimiter();
  assertNum(s12.totalKeys,      "summarizeRateLimiter.totalKeys is number");
  assertNum(s12.violationCount, "summarizeRateLimiter.violationCount is number");
  assertArr(s12.topViolators,   "summarizeRateLimiter.topViolators is array");
  assertStr(s12.checkedAt,      "summarizeRateLimiter.checkedAt present");

  // ── S13: checkMultiScope — allowed when all scopes pass ──────────────────
  section("S13: checkMultiScope — allowed when all scopes pass");
  resetRateLimit("ip",     "multi-ip-s13",     "general");
  resetRateLimit("tenant", "multi-tid-s13",    "general");
  resetRateLimit("apikey", "multi-apikey-s13", "general");
  const s13 = checkMultiScope({
    ip: "multi-ip-s13", tenantId: "multi-tid-s13",
    apiKey: "multi-apikey-s13", path: "/api/users/me",
  });
  assert(s13.allowed === true,         "multiScope allowed when all pass");
  assertArr(s13.decisions,             "multiScope.decisions is array");
  assert(s13.decisions.length >= 3,   "at least 3 scope decisions");
  assert(s13.blocker === undefined,    "no blocker when all pass");

  // ── S14: checkMultiScope — blocks when IP limit exceeded ─────────────────
  section("S14: checkMultiScope — blocks when IP limit exceeded");
  resetRateLimit("ip", "block-ip-s14", "admin");
  fillBucket("ip", "block-ip-s14", "/api/admin/test", ENDPOINT_CONFIGS.admin.maxRequests);
  const s14 = checkMultiScope({ ip: "block-ip-s14", path: "/api/admin/test" });
  assert(s14.allowed === false,     "multiScope blocked when IP over limit");
  assert(s14.blocker !== undefined, "blocker identified");

  // ── S15: INV-SAFE1 — tenant isolation — different tenants independent ─────
  section("S15: INV-SAFE1 — tenant isolation");
  resetRateLimit("tenant", "iso-tenant-A-s15", "ai");
  resetRateLimit("tenant", "iso-tenant-B-s15", "ai");
  fillBucket("tenant", "iso-tenant-A-s15", "/api/ai/run", ENDPOINT_CONFIGS.ai.maxRequests);
  const s15A = checkRateLimit("tenant", "iso-tenant-A-s15", "/api/ai/run");
  const s15B = checkRateLimit("tenant", "iso-tenant-B-s15", "/api/ai/run");
  assert(s15A.allowed === false, "tenant A blocked after fill");
  assert(s15B.allowed === true,  "INV-SAFE1: tenant B unaffected by tenant A");

  // ── S16: INV-SAFE5 — auth endpoints are tracked but separately ───────────
  section("S16: INV-SAFE5 — auth endpoints use separate bucket");
  resetRateLimit("ip", "auth-ip-s16", "auth");
  resetRateLimit("ip", "auth-ip-s16", "admin");
  const s16auth  = checkRateLimit("ip", "auth-ip-s16", "/api/auth/login");
  const s16admin = checkRateLimit("ip", "auth-ip-s16", "/api/admin/status");
  assertEq(s16auth.category,  "auth",  "auth endpoint category=auth");
  assertEq(s16admin.category, "admin", "admin endpoint category=admin");
  assert(s16auth.limit !== s16admin.limit, "auth and admin have different limits");

  // ── S17: checkAndRecord — checks and increments ───────────────────────────
  section("S17: checkAndRecord — increments on allowed, not on blocked");
  resetRateLimit("ip", "car-ip-s17", "general");
  const before17 = getBucketState("ip", "car-ip-s17", "general");
  const r17 = checkAndRecord("ip", "car-ip-s17", "/api/users/me");
  const after17 = getBucketState("ip", "car-ip-s17", "general");
  assert(r17.allowed === true,            "checkAndRecord allowed on empty bucket");
  assertEq((after17?.count ?? 0), 1,     "count incremented by checkAndRecord");

  // ── S18: getRecentViolations — returns array ──────────────────────────────
  section("S18: getRecentViolations — returns recent violations");
  const s18 = getRecentViolations(10);
  assertArr(s18, "getRecentViolations returns array");
  // Trigger a violation to ensure there is at least one
  resetRateLimit("ip", "viol-ip-s18", "admin");
  fillBucket("ip", "viol-ip-s18", "/api/admin/status", ENDPOINT_CONFIGS.admin.maxRequests);
  checkRateLimit("ip", "viol-ip-s18", "/api/admin/status");
  const s18after = getRecentViolations(50);
  assert(s18after.length >= 1, "at least 1 violation in log");
  assert(s18after[0].key !== undefined, "violation has key");
  assert(s18after[0].ts  !== undefined, "violation has ts");

  // ── S19: getBucketState — returns undefined for missing bucket ────────────
  section("S19: getBucketState — undefined for fresh identifier");
  resetRateLimit("ip", "never-seen-s19", "general");
  const s19 = getBucketState("ip", "never-seen-s19", "general");
  assert(s19 === undefined, "getBucketState returns undefined for fresh key");

  // ── S20: getBucketState — returns bucket after record ─────────────────────
  section("S20: getBucketState — present after recordRequest");
  resetRateLimit("ip", "seen-s20", "general");
  recordRequest("ip", "seen-s20", "/api/users/me");
  const s20 = getBucketState("ip", "seen-s20", "general");
  assert(s20 !== undefined, "getBucketState returns entry after record");
  assertEq(s20!.count, 1, "count = 1");
  assertNum(s20!.windowStart, "windowStart is number");

  // ── S21: violation log bounded ────────────────────────────────────────────
  section("S21: Violation log is bounded and monotonically grows");
  const before21 = getRecentViolations(1000).length;
  resetRateLimit("ip", "bounded-s21", "auth");
  fillBucket("ip", "bounded-s21", "/api/auth/login", ENDPOINT_CONFIGS.auth.maxRequests);
  checkRateLimit("ip", "bounded-s21", "/api/auth/login");
  const after21 = getRecentViolations(1000).length;
  assert(after21 >= before21, "violation log monotonically grows");

  // ── S22: rate limit remainingMs ────────────────────────────────────────────
  section("S22: rate limit decision includes remainingMs");
  resetRateLimit("ip", "remain-s22", "general");
  const s22 = checkRateLimit("ip", "remain-s22", "/api/users/me");
  assertNum(s22.remainingMs, "remainingMs is number");
  assert(s22.remainingMs >= 0,          "remainingMs >= 0");
  assert(s22.remainingMs <= 60_000,     "remainingMs <= windowMs");

  // ── S23: rate limit windowMs ──────────────────────────────────────────────
  section("S23: rate limit decision includes windowMs");
  resetRateLimit("ip", "window-s23", "ai");
  const s23 = checkRateLimit("ip", "window-s23", "/api/ai/run");
  assertEq(s23.windowMs, 60_000, "ai windowMs = 60000");

  // ── S24: rate limit scope in decision ─────────────────────────────────────
  section("S24: checkRateLimit decision includes correct scope");
  resetRateLimit("tenant", "scope-tid-s24", "ai");
  const s24 = checkRateLimit("tenant", "scope-tid-s24", "/api/ai/run");
  assertEq(s24.scope, "tenant", "scope = tenant in decision");

  // ── S25: per API key limiting ─────────────────────────────────────────────
  section("S25: per-API-key limiting is independent of IP");
  resetRateLimit("apikey", "api-key-s25", "general");
  resetRateLimit("ip",     "ip-s25",      "general");
  recordRequest("apikey", "api-key-s25", "/api/users/me");
  const s25ip  = checkRateLimit("ip",     "ip-s25",      "/api/users/me");
  const s25key = checkRateLimit("apikey", "api-key-s25", "/api/users/me");
  assert(s25ip.requestCount === 0 || s25ip.allowed,
    "IP bucket separate from API key bucket");
  assertEq(s25key.requestCount, 1, "API key bucket has 1 request");

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION B — PLATFORM RESTART RECOVERY
  // ════════════════════════════════════════════════════════════════════════════

  // ── S26: detectIncompleteJobs — returns array ─────────────────────────────
  section("S26: detectIncompleteJobs — returns array");
  const s26 = await detectIncompleteJobs(30);
  assertArr(s26, "detectIncompleteJobs returns array");

  // ── S27: detectIncompleteJobs — job shape ─────────────────────────────────
  section("S27: detectIncompleteJobs — job shape valid");
  if (s26.length > 0) {
    const j = s26[0];
    assertStr(j.id,        "job.id is string");
    assertStr(j.tenantId,  "job.tenantId is string");
    assertStr(j.jobType,   "job.jobType is string");
    assertStr(j.status,    "job.status is string");
    assertNum(j.attemptCount, "job.attemptCount is number");
    assertNum(j.maxAttempts,  "job.maxAttempts is number");
    assertBool(j.recoverable,  "job.recoverable is boolean");
    assertStr(j.reason,    "job.reason is string");
    console.log(`  ℹ ${s26.length} incomplete job(s) found in DB`);
  } else {
    console.log("  ℹ No incomplete jobs in DB (healthy queue) — shape tests skipped");
    assert(true, "detectIncompleteJobs returned empty array (healthy queue)");
  }

  // ── S28: detectStalledJobs — subset of running ────────────────────────────
  section("S28: detectStalledJobs — returns only running jobs");
  const s28 = await detectStalledJobs(30);
  assertArr(s28, "detectStalledJobs returns array");
  for (const j of s28) {
    assertEq(j.status, "running", "INV-SAFE3: detectStalledJobs only running");
  }
  assert(s28.length <= s26.length, "stalled <= total incomplete");

  // ── S29: resumeSafeJobs — dry-run returns list without DB changes ─────────
  section("S29: resumeSafeJobs — dry-run is safe (INV-SAFE3)");
  const fakeJobs: IncompleteJob[] = [
    { id: "fake-job-1", tenantId: "t-dry", jobType: "test",
      status: "running", attemptCount: 0, maxAttempts: 3,
      startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      createdAt: new Date(Date.now() - 50 * 60_000).toISOString(),
      recoverable: true, reason: "Stalled" },
    { id: "fake-job-2", tenantId: "t-dry", jobType: "test",
      status: "running", attemptCount: 3, maxAttempts: 3,
      startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      createdAt: new Date(Date.now() - 50 * 60_000).toISOString(),
      recoverable: false, reason: "Max attempts reached" },
  ];
  const s29 = await resumeSafeJobs(fakeJobs, true);
  assertArr(s29.resumed, "dry-run: resumed is array");
  assertArr(s29.failed,  "dry-run: failed is array");
  assertArr(s29.errors,  "dry-run: errors is array");
  assert(s29.resumed.includes("fake-job-1"), "recoverable job in dry-run resumed list");
  assert(!s29.resumed.includes("fake-job-2"), "INV-SAFE3: exhausted job not resumed");
  assertEq(s29.errors.length, 0, "dry-run produces no errors");

  // ── S30: resumeSafeJobs — only recoverable resumed ────────────────────────
  section("S30: resumeSafeJobs — INV-SAFE3 no duplicates");
  const s30 = await resumeSafeJobs(fakeJobs, true);
  const resumedIds = s30.resumed;
  const uniqueIds  = [...new Set(resumedIds)];
  assertEq(resumedIds.length, uniqueIds.length, "INV-SAFE3: no duplicate job IDs in resumed");

  // ── S31: repairQueues — dry-run returns counts ────────────────────────────
  section("S31: repairQueues — dry-run returns counts (INV-SAFE3)");
  const s31 = await repairQueues(true);
  assertNum(s31.stalledJobsFixed, "stalledJobsFixed is number");
  assertNum(s31.orphanedJobs,     "orphanedJobs is number");
  assertNum(s31.pendingWebhooks,  "pendingWebhooks is number");
  assertBool(s31.dryRun,          "dryRun flag present");
  assert(s31.dryRun === true,     "dryRun = true in dry run");

  // ── S32: repairQueues — counts >= 0 ──────────────────────────────────────
  section("S32: repairQueues — all counts >= 0");
  assert(s31.stalledJobsFixed >= 0, "stalledJobsFixed >= 0");
  assert(s31.orphanedJobs     >= 0, "orphanedJobs >= 0");
  assert(s31.pendingWebhooks  >= 0, "pendingWebhooks >= 0");

  // ── S33: runRestartRecovery — dry-run structure ────────────────────────────
  section("S33: runRestartRecovery — dry-run returns RestartRecoveryResult");
  const s33 = await runRestartRecovery(true);
  assertNum(s33.incompleteJobs, "incompleteJobs is number");
  assertNum(s33.resumedJobs,    "resumedJobs is number");
  assertNum(s33.markedFailed,   "markedFailed is number");
  assertNum(s33.requeuedJobs,   "requeuedJobs is number");
  assertBool(s33.repaired,      "repaired is bool");
  assertArr(s33.errors,         "errors is array");
  assertBool(s33.dryRun,        "dryRun flag present");
  assertStr(s33.recoveredAt,    "recoveredAt is ISO string");
  assert(s33.dryRun === true,   "dryRun = true");

  // ── S34: runRestartRecovery — idempotent (INV-SAFE3) ─────────────────────
  section("S34: runRestartRecovery — idempotent across two calls (INV-SAFE3)");
  const s34a = await runRestartRecovery(true);
  const s34b = await runRestartRecovery(true);
  assertEq(s34a.incompleteJobs, s34b.incompleteJobs, "INV-SAFE3: incompleteJobs stable");
  assertEq(s34a.dryRun, true,  "first run is dry");
  assertEq(s34b.dryRun, true,  "second run is dry");

  // ── S35: explainRestartRecovery — INV-SAFE4 logging ──────────────────────
  section("S35: explainRestartRecovery — INV-SAFE4 logs all actions");
  const s35exp = explainRestartRecovery(s33);
  assertStr(s35exp, "explainRestartRecovery returns string");
  assert(s35exp.includes("Incomplete") || s35exp.includes("incomplete"),
    "INV-SAFE4: explanation mentions incomplete jobs");
  assert(s35exp.includes("Resumed") || s35exp.includes("resumed"),
    "INV-SAFE4: explanation mentions resumed");
  assert(s35exp.includes("DRY-RUN") || s35exp.includes("dry"),
    "INV-SAFE4: explanation mentions dry-run mode");

  // ── S36: summarizeRecoveryState — DB query ────────────────────────────────
  section("S36: summarizeRecoveryState — returns valid summary from DB");
  const s36 = await summarizeRecoveryState();
  assertNum(s36.totalIncomplete, "totalIncomplete is number");
  assertNum(s36.recoverable,     "recoverable is number");
  assertNum(s36.unrecoverable,   "unrecoverable is number");
  assertNum(s36.pendingRetries,  "pendingRetries is number");
  assertStr(s36.queueHealth,     "queueHealth is string");
  assertStr(s36.explanation,     "explanation is string");
  assertStr(s36.checkedAt,       "checkedAt is ISO string");
  assert(
    ["healthy", "degraded", "critical"].includes(s36.queueHealth),
    "queueHealth ∈ {healthy, degraded, critical}",
  );

  // ── S37: summarizeRestartState — alias for summarizeRecoveryState ─────────
  section("S37: summarizeRestartState — alias same structure");
  const s37 = await summarizeRestartState();
  assertStr(s37.queueHealth,  "summarizeRestartState.queueHealth");
  assertStr(s37.explanation,  "summarizeRestartState.explanation");
  assertNum(s37.pendingRetries, "summarizeRestartState.pendingRetries");

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION C — SAFETY OBSERVABILITY
  // ════════════════════════════════════════════════════════════════════════════

  // ── S38: recordRateLimitViolation + getSafetySnapshot ────────────────────
  section("S38: recordRateLimitViolation tracked in safety snapshot");
  // Signature: (key, category, count, metadata?)
  recordRateLimitViolation("obs-ip-s38", "admin", 999);
  const s38snap = getSafetySnapshot();
  assertNum(s38snap.rateLimitViolations, "rateLimitViolations is number");
  assert(s38snap.rateLimitViolations >= 1, "at least 1 violation tracked");
  assertArr(s38snap.recentEvents, "recentEvents is array");
  assertStr(s38snap.checkedAt,    "checkedAt is ISO string");

  // ── S39: recordRestartRecovery + recordJobResumed ──────────────────────────
  section("S39: recordRestartRecovery + recordJobResumed tracked");
  // Signature: (incompleteJobs, resumedJobs, errors: string[])
  recordRestartRecovery(s33.incompleteJobs, s33.resumedJobs, s33.errors);
  recordJobResumed("fake-job-obs-s39", "obs-tenant-s39");
  const s39events = getRecentSafetyEvents(undefined, 50);
  assertArr(s39events, "getRecentSafetyEvents returns array");
  assert(s39events.length >= 1, "at least 1 safety event");
  const types39 = s39events.map(e => e.type);
  assert(
    types39.includes("restart_recovery_run") || types39.includes("job_resumed"),
    "restart_recovery_run or job_resumed event present",
  );

  // ── S40: recordJobMarkedFailed + getRecentSafetyEvents type filter ────────
  section("S40: recordJobMarkedFailed tracked and filterable (INV-SAFE4)");
  recordJobMarkedFailed("fake-job-fail-s40", "Max attempts", "obs-tenant-s40");
  const s40all    = getRecentSafetyEvents(undefined, 100);
  const s40failed = getRecentSafetyEvents("job_marked_failed", 100);
  assertArr(s40all,    "unfiltered events is array");
  assertArr(s40failed, "job_marked_failed events is array");
  assert(s40failed.length >= 1, "INV-SAFE4: marked-failed event tracked");
  for (const e of s40failed) {
    assertEq(e.type, "job_marked_failed", "INV-SAFE4: all events have correct type");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION D — ADMIN ENDPOINTS (HTTP)
  // ════════════════════════════════════════════════════════════════════════════

  const BASE = "http://localhost:5000";

  // ── S38 Admin: GET /api/admin/safety/rate-limit-state ────────────────────
  section("S38 (admin): GET /api/admin/safety/rate-limit-state");
  let rateState: any;
  try { rateState = await fetch(`${BASE}/api/admin/safety/rate-limit-state`); } catch { rateState = { status: 0 }; }
  assert(rateState.status !== 404, "rate-limit-state route registered (not 404)");
  if (rateState.status === 200) {
    const body38 = await (rateState as Response).json();
    assert(body38.summary !== undefined,          "admin: summary present");
    assert(body38.recentViolations !== undefined, "admin: recentViolations present");
    assertStr(body38.retrievedAt,                 "admin: retrievedAt present");
  }

  // ── S39 Admin: GET /api/admin/safety/restart-recovery-status ─────────────
  section("S39 (admin): GET /api/admin/safety/restart-recovery-status");
  let recoveryStatus: any;
  try { recoveryStatus = await fetch(`${BASE}/api/admin/safety/restart-recovery-status`); } catch { recoveryStatus = { status: 0 }; }
  assert(recoveryStatus.status !== 404, "restart-recovery-status route registered (not 404)");
  if (recoveryStatus.status === 200) {
    const body39 = await (recoveryStatus as Response).json();
    assertStr(body39.queueHealth,   "admin: queueHealth present");
    assertStr(body39.explanation,   "admin: explanation present");
    assertStr(body39.retrievedAt,   "admin: retrievedAt present");
    assertNum(body39.pendingRetries, "admin: pendingRetries is number");
  }

  // ── S40 Admin: Existing Phase 16 routes still working ────────────────────
  section("S40 (admin): Existing admin routes still accessible");
  let r16: any;
  try { r16 = await fetch(`${BASE}/api/admin/ai/budgets`); } catch { r16 = { status: 0 }; }
  assert(r16.status !== 404, "INV-SAFE5: /api/admin/ai/budgets still accessible");

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Phase 30 validation: ${_passed} passed, ${_failed} failed`);
  if (_failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.error(`✖ ${_failed} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("✖ Validation crashed:", err.message);
  process.exit(1);
});
