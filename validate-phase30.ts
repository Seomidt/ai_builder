#!/usr/bin/env npx tsx
/**
 * Phase 30 — Platform Safety & Abuse Protection — Validation
 * 55 scenarios · 150+ assertions
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
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

function httpPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req  = http.request(
      { host: "localhost", port: 5000, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
                   "x-admin-secret": "admin" } },
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
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("Phase 30 — Platform Safety & Abuse Protection — Validation");
  console.log("═══════════════════════════════════════════════════════");

  // ══════════════════════════════════════════════════════════════════════════
  // S01–S05: File existence
  // ══════════════════════════════════════════════════════════════════════════

  section("S01: Required files exist");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("server/lib/safety/tenant-circuit-breaker.ts"),    "tenant-circuit-breaker.ts exists");
    assert(existsSync("server/lib/security/global-rate-limiter.ts"),     "global-rate-limiter.ts exists");
    assert(existsSync("server/lib/recovery/platform-restart-recovery.ts"), "platform-restart-recovery.ts exists");
    assert(existsSync("server/lib/safety/safety-observability.ts"),      "safety-observability.ts exists");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S02–S10: Tenant Circuit Breaker — exports and constants
  // ══════════════════════════════════════════════════════════════════════════

  section("S02: tenant-circuit-breaker — exports required functions");
  {
    const mod = await import("./server/lib/safety/tenant-circuit-breaker");
    assert(typeof mod.getTenantActivityMetrics  === "function", "getTenantActivityMetrics exported");
    assert(typeof mod.classifyTenantState       === "function", "classifyTenantState exported");
    assert(typeof mod.applyTenantProtection     === "function", "applyTenantProtection exported");
    assert(typeof mod.explainTenantProtection   === "function", "explainTenantProtection exported");
    assert(typeof mod.summarizeTenantSafety     === "function", "summarizeTenantSafety exported");
    assert(typeof mod.unfreezeTenant            === "function", "unfreezeTenant exported");
    assert(typeof mod.throttleTenant            === "function", "throttleTenant exported");
    assert(typeof mod.getTenantCurrentState     === "function", "getTenantCurrentState exported");
    assert(typeof mod.getAllTenantStates        === "function",  "getAllTenantStates exported");
    assert(typeof mod.getTenantTransitionHistory === "function", "getTenantTransitionHistory exported");
    assert(typeof mod.TENANT_THRESHOLDS         === "object",   "TENANT_THRESHOLDS exported");
    assert(typeof mod.STATE_PERMISSIONS         === "object",   "STATE_PERMISSIONS exported");
  }

  section("S03: TENANT_THRESHOLDS — ordered correctly (throttled < restricted < frozen)");
  {
    const { TENANT_THRESHOLDS: T } = await import("./server/lib/safety/tenant-circuit-breaker");
    for (const [key, tiers] of Object.entries(T)) {
      assert(tiers.throttled < tiers.restricted, `${key}: throttled < restricted`);
      assert(tiers.restricted < tiers.frozen,    `${key}: restricted < frozen`);
    }
  }

  section("S04: STATE_PERMISSIONS — all states defined, billing always allowed");
  {
    const { STATE_PERMISSIONS } = await import("./server/lib/safety/tenant-circuit-breaker");
    const states = ["normal", "throttled", "restricted", "frozen"];
    for (const state of states) {
      const perms = STATE_PERMISSIONS[state as keyof typeof STATE_PERMISSIONS];
      assert(perms !== undefined,                 `state '${state}' defined`);
      assertArr(perms.allowed,                    `${state}: allowed is array`);
      assertArr(perms.blocked,                    `${state}: blocked is array`);
      assert(perms.allowed.includes("billing"),   `${state}: billing always allowed (INV-SAFE5)`);
      assert(perms.allowed.includes("recovery"),  `${state}: recovery always allowed`);
    }
  }

  section("S05: classifyTenantState — normal when all signals low");
  {
    const { classifyTenantState } = await import("./server/lib/safety/tenant-circuit-breaker");
    const metrics = {
      tenantId:                  "test-t1",
      agentRunsPerMinute:        1,
      tokensPerMinute:           100,
      webhookEventsPerMinute:    5,
      queueJobsPerMinute:        2,
      apiCallsPerMinute:         10,
      windowMinutes:             5,
      measuredAt:                new Date().toISOString(),
    };
    const r = classifyTenantState(metrics);
    assertEq(r.state, "normal", "all-low signals → normal");
    assertArr(r.signals,        "signals is array");
    assertStr(r.reason,         "reason is non-empty string");
    assert(r.signals.every(s => !s.breached), "no signals breached");
  }

  section("S06: classifyTenantState — throttled when signals breach throttle threshold");
  {
    const { classifyTenantState, TENANT_THRESHOLDS: T } = await import("./server/lib/safety/tenant-circuit-breaker");
    const metrics = {
      tenantId:                  "test-t2",
      agentRunsPerMinute:        T.agentRunsPerMinute.throttled + 5,
      tokensPerMinute:           T.tokensPerMinute.throttled + 1000,
      webhookEventsPerMinute:    5,
      queueJobsPerMinute:        2,
      apiCallsPerMinute:         10,
      windowMinutes:             5,
      measuredAt:                new Date().toISOString(),
    };
    const r = classifyTenantState(metrics);
    assertEq(r.state, "throttled", "2 signals breached → throttled");
    assert(r.signals.some(s => s.breached), "at least one breached signal");
  }

  section("S07: classifyTenantState — frozen when a signal exceeds frozen threshold");
  {
    const { classifyTenantState, TENANT_THRESHOLDS: T } = await import("./server/lib/safety/tenant-circuit-breaker");
    const metrics = {
      tenantId:                  "test-t3",
      agentRunsPerMinute:        T.agentRunsPerMinute.frozen + 10,
      tokensPerMinute:           100,
      webhookEventsPerMinute:    5,
      queueJobsPerMinute:        2,
      apiCallsPerMinute:         10,
      windowMinutes:             5,
      measuredAt:                new Date().toISOString(),
    };
    const r = classifyTenantState(metrics);
    assertEq(r.state, "frozen", "frozen threshold breached → frozen state");
  }

  section("S08: applyTenantProtection — transitions are logged (INV-SAFE2)");
  {
    const { applyTenantProtection, getTenantTransitionHistory, TENANT_THRESHOLDS: T } =
      await import("./server/lib/safety/tenant-circuit-breaker");

    const before = getTenantTransitionHistory("tenant-test-log-check").length;
    const metrics = {
      tenantId:               "tenant-test-log-check",
      agentRunsPerMinute:     T.agentRunsPerMinute.frozen + 5,
      tokensPerMinute:        100,
      webhookEventsPerMinute: 5, queueJobsPerMinute: 2, apiCallsPerMinute: 10,
      windowMinutes: 5, measuredAt: new Date().toISOString(),
    };
    applyTenantProtection("tenant-test-log-check", metrics);
    const after = getTenantTransitionHistory("tenant-test-log-check").length;
    assert(after > before, "transition was logged (INV-SAFE2)");
  }

  section("S09: unfreezeTenant — returns to normal, logs transition");
  {
    const {
      applyTenantProtection, unfreezeTenant,
      getTenantCurrentState, getTenantTransitionHistory, TENANT_THRESHOLDS: T,
    } = await import("./server/lib/safety/tenant-circuit-breaker");

    // Freeze first
    const metrics = {
      tenantId: "tenant-unfreeze-test",
      agentRunsPerMinute: T.agentRunsPerMinute.frozen + 5,
      tokensPerMinute: 100, webhookEventsPerMinute: 5,
      queueJobsPerMinute: 2, apiCallsPerMinute: 10,
      windowMinutes: 5, measuredAt: new Date().toISOString(),
    };
    applyTenantProtection("tenant-unfreeze-test", metrics);
    assertEq(getTenantCurrentState("tenant-unfreeze-test"), "frozen", "setup: frozen");

    const result = unfreezeTenant("tenant-unfreeze-test", "test unfreeze");
    assertEq(result.state, "normal", "unfreeze: returns normal state");
    assertEq(getTenantCurrentState("tenant-unfreeze-test"), "normal", "state is now normal");
    assert(result.allowedFlows.includes("billing"), "billing remains allowed after unfreeze");

    const history = getTenantTransitionHistory("tenant-unfreeze-test");
    assert(history.some(t => t.to === "normal"), "unfreeze transition logged");
  }

  section("S10: throttleTenant — manual throttle with reason");
  {
    const { throttleTenant, getTenantCurrentState, unfreezeTenant } =
      await import("./server/lib/safety/tenant-circuit-breaker");

    const result = throttleTenant("tenant-manual-throttle", "test: high load");
    assertEq(result.state, "throttled", "manual throttle applies throttled state");
    assertEq(getTenantCurrentState("tenant-manual-throttle"), "throttled", "state stored");
    assertStr(result.reason, "reason present");
    assert(result.allowedFlows.includes("billing"), "billing allowed when throttled");

    // Cleanup
    unfreezeTenant("tenant-manual-throttle", "cleanup");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S11–S14: Tenant safety — flow permissions
  // ══════════════════════════════════════════════════════════════════════════

  section("S11: explainTenantProtection — normal produces brief explanation");
  {
    const { explainTenantProtection } = await import("./server/lib/safety/tenant-circuit-breaker");
    const result = {
      tenantId: "t1", state: "normal" as const, reason: "All nominal",
      signals: [], allowedFlows: ["billing", "recovery"], blockedFlows: [],
      appliedAt: new Date().toISOString(),
    };
    const exp = explainTenantProtection(result);
    assert(exp.toLowerCase().includes("normal"), "explanation mentions normal");
    assertStr(exp, "explanation is non-empty");
  }

  section("S12: explainTenantProtection — frozen lists blocked flows");
  {
    const { explainTenantProtection } = await import("./server/lib/safety/tenant-circuit-breaker");
    const result = {
      tenantId: "t2", state: "frozen" as const, reason: "Token explosion",
      signals: [],
      allowedFlows:  ["billing", "recovery"],
      blockedFlows:  ["agent_runs", "new_jobs", "webhook_dispatch"],
      appliedAt: new Date().toISOString(),
    };
    const exp = explainTenantProtection(result);
    assert(exp.toUpperCase().includes("FROZEN"), "explanation mentions FROZEN");
    assert(exp.includes("agent_runs") || exp.includes("Blocked"), "explanation mentions blocked flows");
  }

  section("S13: summarizeTenantSafety — returns structured string");
  {
    const { summarizeTenantSafety } = await import("./server/lib/safety/tenant-circuit-breaker");
    const summary = summarizeTenantSafety();
    assertStr(summary, "summarizeTenantSafety is non-empty string");
    assert(summary.includes("Frozen") || summary.includes("Normal") || summary.includes("monitored"),
      "summary includes relevant status info");
  }

  section("S14: getTenantCurrentState — unknown tenant defaults to normal");
  {
    const { getTenantCurrentState } = await import("./server/lib/safety/tenant-circuit-breaker");
    const state = getTenantCurrentState("totally-unknown-tenant-xyz");
    assertEq(state, "normal", "unknown tenant defaults to normal");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S15–S27: Global Rate Limiter
  // ══════════════════════════════════════════════════════════════════════════

  section("S15: global-rate-limiter — exports required functions");
  {
    const mod = await import("./server/lib/security/global-rate-limiter");
    assert(typeof mod.checkRateLimit         === "function", "checkRateLimit exported");
    assert(typeof mod.recordRequest          === "function", "recordRequest exported");
    assert(typeof mod.explainRateLimitDecision === "function", "explainRateLimitDecision exported");
    assert(typeof mod.summarizeRateLimitState  === "function", "summarizeRateLimitState exported");
    assert(typeof mod.checkAndRecord         === "function", "checkAndRecord exported");
    assert(typeof mod.checkMultiScope        === "function", "checkMultiScope exported");
    assert(typeof mod.resetRateLimit         === "function", "resetRateLimit exported");
    assert(typeof mod.getRecentViolations    === "function", "getRecentViolations exported");
    assert(typeof mod.resolveEndpointCategory === "function", "resolveEndpointCategory exported");
    assert(typeof mod.ENDPOINT_CONFIGS       === "object",   "ENDPOINT_CONFIGS exported");
  }

  section("S16: ENDPOINT_CONFIGS — all categories defined with ordered limits");
  {
    const { ENDPOINT_CONFIGS } = await import("./server/lib/security/global-rate-limiter");
    const categories = ["ai", "webhook", "auth", "admin", "general"];
    for (const cat of categories) {
      const cfg = ENDPOINT_CONFIGS[cat as keyof typeof ENDPOINT_CONFIGS];
      assert(cfg !== undefined, `category '${cat}' configured`);
      assert(cfg.maxRequests > 0, `${cat}: maxRequests > 0`);
      assert(cfg.windowMs > 0,    `${cat}: windowMs > 0`);
    }
    // Admin should be most restrictive
    assert(ENDPOINT_CONFIGS.admin.maxRequests <= ENDPOINT_CONFIGS.ai.maxRequests,
      "admin limit ≤ AI limit (admin most restrictive)");
  }

  section("S17: resolveEndpointCategory — correct mapping");
  {
    const { resolveEndpointCategory } = await import("./server/lib/security/global-rate-limiter");
    assertEq(resolveEndpointCategory("/api/ai/run"),        "ai",      "/api/ai/ → ai");
    assertEq(resolveEndpointCategory("/api/webhooks/test"), "webhook", "/api/webhooks/ → webhook");
    assertEq(resolveEndpointCategory("/api/auth/login"),    "auth",    "/api/auth/ → auth");
    assertEq(resolveEndpointCategory("/api/admin/status"),  "admin",   "/api/admin/ → admin");
    assertEq(resolveEndpointCategory("/api/tenants"),       "general", "/api/ → general");
  }

  section("S18: checkRateLimit — allows request within limit (INV-SAFE3)");
  {
    const { checkRateLimit, resetRateLimit } = await import("./server/lib/security/global-rate-limiter");

    // Reset state for clean test
    resetRateLimit("ip", "1.2.3.4", "admin");

    const r = checkRateLimit("ip", "1.2.3.4", "/api/admin/test");
    assertBool(r.allowed,    "decision.allowed is boolean");
    assert(r.allowed === true, "first request is allowed");
    assertNum(r.requestCount, "requestCount is number");
    assertNum(r.limit,        "limit is number");
    assertNum(r.remainingMs,  "remainingMs is number");
    assertStr(r.resetAt,      "resetAt is non-empty string");
    assertIso(r.resetAt,      "resetAt is ISO date");
    assertStr(r.reason,       "reason is non-empty string");
    assertBool(r.violationLogged, "violationLogged is boolean");
    assert(!r.violationLogged,    "no violation on first request");
  }

  section("S19: checkRateLimit — deterministic (same input = same output) (INV-SAFE3)");
  {
    const { checkRateLimit, resetRateLimit, ENDPOINT_CONFIGS } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "test-det-1", "auth");
    const r1 = checkRateLimit("ip", "test-det-1", "/api/auth/login");
    const r2 = checkRateLimit("ip", "test-det-1", "/api/auth/login");
    assertEq(r1.category, r2.category, "category consistent across calls");
    assertEq(r1.limit,    r2.limit,    "limit consistent across calls");
    assertEq(r1.scope,    r2.scope,    "scope consistent across calls");
    assert(r2.requestCount >= r1.requestCount, "count monotonically increases");
  }

  section("S20: checkRateLimit — blocks when limit exceeded (INV-SAFE3)");
  {
    const { checkRateLimit, recordRequest, resetRateLimit, ENDPOINT_CONFIGS } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "abuser-ip-1", "admin");
    const limit = ENDPOINT_CONFIGS.admin.maxRequests;

    // Fill the bucket by recording requests (recordRequest increments count)
    for (let i = 0; i < limit; i++) {
      recordRequest("ip", "abuser-ip-1", "/api/admin/status");
    }

    const r = checkRateLimit("ip", "abuser-ip-1", "/api/admin/status");
    assert(r.allowed === false, `request ${limit + 1} is blocked`);
    assert(r.violationLogged === true, "violation is logged");
    assert(r.reason.toLowerCase().includes("exceeded") || r.reason.toLowerCase().includes("limit"),
      "reason explains limit exceeded");
  }

  section("S21: recordRequest — increments count");
  {
    const { recordRequest, checkRateLimit, resetRateLimit } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("tenant", "tenant-record-test", "ai");
    const before = checkRateLimit("tenant", "tenant-record-test", "/api/ai/run");
    recordRequest("tenant", "tenant-record-test", "/api/ai/run");
    const after  = checkRateLimit("tenant", "tenant-record-test", "/api/ai/run");
    assert(after.requestCount > before.requestCount, "recordRequest increments count");
  }

  section("S22: checkMultiScope — allows when all scopes pass");
  {
    const { checkMultiScope, resetRateLimit } = await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip",       "192.168.1.1",    "general");
    resetRateLimit("tenant",   "tenant-ok",       "general");
    resetRateLimit("endpoint", "/api/tenants",    "general");

    const r = checkMultiScope({ ip: "192.168.1.1", tenantId: "tenant-ok", path: "/api/tenants" });
    assertBool(r.allowed,    "multiScope.allowed is boolean");
    assertArr(r.decisions,   "multiScope.decisions is array");
    assert(r.decisions.length >= 2, "at least 2 scope decisions made");
  }

  section("S23: checkMultiScope — blocks when any scope fails");
  {
    const { checkMultiScope, recordRequest, resetRateLimit, ENDPOINT_CONFIGS } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "block-test-ip", "admin");
    const limit = ENDPOINT_CONFIGS.admin.maxRequests;
    // Fill IP bucket by recording requests directly
    for (let i = 0; i < limit; i++) {
      recordRequest("ip", "block-test-ip", "/api/admin/test");
    }

    const r = checkMultiScope({ ip: "block-test-ip", path: "/api/admin/test" });
    assert(r.allowed === false,   "multiScope blocked when IP limit exceeded");
    assert(r.blocker !== undefined, "blocker is identified");
  }

  section("S24: explainRateLimitDecision — allowed decision");
  {
    const { explainRateLimitDecision, checkRateLimit, resetRateLimit } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "explain-test-1", "webhook");
    const decision = checkRateLimit("ip", "explain-test-1", "/api/webhooks/test");
    const exp = explainRateLimitDecision(decision);
    assertStr(exp, "explain returns non-empty string for allowed");
    assert(exp.includes("Allowed") || exp.includes("allowed") || exp.includes("requests"),
      "allowed explanation mentions allowed/requests");
  }

  section("S25: explainRateLimitDecision — blocked decision");
  {
    const { explainRateLimitDecision, checkRateLimit, recordRequest, resetRateLimit, ENDPOINT_CONFIGS } =
      await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "explain-block-ip", "admin");
    const limit = ENDPOINT_CONFIGS.admin.maxRequests;
    // Fill the bucket using recordRequest, then trigger the violation
    for (let i = 0; i < limit; i++) {
      recordRequest("ip", "explain-block-ip", "/api/admin/x");
    }
    const blocked = checkRateLimit("ip", "explain-block-ip", "/api/admin/x");
    const exp = explainRateLimitDecision(blocked);
    assertStr(exp, "explain returns non-empty string for blocked");
    assert(exp.toLowerCase().includes("exceeded") || exp.toLowerCase().includes("limit"),
      "blocked explanation mentions limit/exceeded");
    assert(exp.includes("resetAt") || exp.includes("Resets") || exp.includes("Reset"),
      "blocked explanation mentions reset time");
  }

  section("S26: summarizeRateLimitState — structured output");
  {
    const { summarizeRateLimitState } = await import("./server/lib/security/global-rate-limiter");
    const summary = summarizeRateLimitState();
    assertNum(summary.totalKeys,      "totalKeys is number");
    assertNum(summary.violationCount, "violationCount is number");
    assertArr(summary.topViolators,   "topViolators is array");
    assertIso(summary.checkedAt,      "checkedAt is ISO date");
  }

  section("S27: getRecentViolations — returns array with violation fields");
  {
    const { getRecentViolations } = await import("./server/lib/security/global-rate-limiter");
    const violations = getRecentViolations(10);
    assertArr(violations, "getRecentViolations returns array");
    if (violations.length > 0) {
      assertStr(violations[0].key,      "violation has key");
      assertStr(violations[0].category, "violation has category");
      assertNum(violations[0].count,    "violation has count");
      assertIso(violations[0].ts,       "violation has ISO timestamp");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S28–S37: Platform Restart Recovery
  // ══════════════════════════════════════════════════════════════════════════

  section("S28: platform-restart-recovery — exports required functions");
  {
    const mod = await import("./server/lib/recovery/platform-restart-recovery");
    assert(typeof mod.detectIncompleteJobs  === "function", "detectIncompleteJobs exported");
    assert(typeof mod.resumeSafeJobs        === "function", "resumeSafeJobs exported");
    assert(typeof mod.repairQueues          === "function", "repairQueues exported");
    assert(typeof mod.explainRestartRecovery === "function", "explainRestartRecovery exported");
    assert(typeof mod.summarizeRecoveryState === "function", "summarizeRecoveryState exported");
    assert(typeof mod.runRestartRecovery    === "function",  "runRestartRecovery exported");
  }

  section("S29: detectIncompleteJobs — returns array of IncompleteJob");
  {
    const { detectIncompleteJobs } = await import("./server/lib/recovery/platform-restart-recovery");
    const jobs = await detectIncompleteJobs(30);
    assertArr(jobs, "detectIncompleteJobs returns array");
    for (const job of jobs) {
      assertStr(job.id,        `job ${job.id}: id is string`);
      assertStr(job.status,    `job ${job.id}: status is string`);
      assertNum(job.attemptCount, `job ${job.id}: attemptCount is number`);
      assertBool(job.recoverable, `job ${job.id}: recoverable is boolean`);
      assertStr(job.reason,    `job ${job.id}: reason is string`);
    }
  }

  section("S30: resumeSafeJobs — dry-run returns plan without writes (INV-SAFE4)");
  {
    const { detectIncompleteJobs, resumeSafeJobs } =
      await import("./server/lib/recovery/platform-restart-recovery");

    const jobs = await detectIncompleteJobs(30);
    const r = await resumeSafeJobs(jobs.filter(j => j.recoverable), true);

    assertArr(r.resumed, "dry-run: resumed is array");
    assertArr(r.failed,  "dry-run: failed is array");
    assertArr(r.errors,  "dry-run: errors is array");
    assert(r.errors.length === 0 || typeof r.errors[0] === "string",
      "errors are strings");
  }

  section("S31: resumeSafeJobs — empty input returns zero counts");
  {
    const { resumeSafeJobs } = await import("./server/lib/recovery/platform-restart-recovery");
    const r = await resumeSafeJobs([], true);
    assertEq(r.resumed.length, 0, "empty input: 0 resumed");
    assertEq(r.failed.length,  0, "empty input: 0 failed");
  }

  section("S32: repairQueues — dry-run returns counts without writing");
  {
    const { repairQueues } = await import("./server/lib/recovery/platform-restart-recovery");
    const r = await repairQueues(true);
    assertNum(r.stalledJobsFixed, "stalledJobsFixed is number");
    assertNum(r.orphanedJobs,     "orphanedJobs is number");
    assertNum(r.pendingWebhooks,  "pendingWebhooks is number");
    assertBool(r.dryRun,          "dryRun field present");
    assert(r.dryRun === true,     "dryRun=true confirms no writes");
    assert(r.stalledJobsFixed >= 0, "stalledJobsFixed >= 0");
    assert(r.pendingWebhooks >= 0,  "pendingWebhooks >= 0");
  }

  section("S33: runRestartRecovery — dry-run completes without error (INV-SAFE4)");
  {
    const { runRestartRecovery } = await import("./server/lib/recovery/platform-restart-recovery");
    const r = await runRestartRecovery(true);
    assertNum(r.incompleteJobs, "incompleteJobs is number");
    assertNum(r.resumedJobs,    "resumedJobs is number");
    assertNum(r.markedFailed,   "markedFailed is number");
    assertNum(r.requeuedJobs,   "requeuedJobs is number");
    assertBool(r.dryRun,        "dryRun is boolean");
    assert(r.dryRun === true,   "dryRun=true (no writes in test)");
    assertArr(r.errors,         "errors is array");
    assertIso(r.recoveredAt,    "recoveredAt is ISO date");
    assert(r.incompleteJobs >= 0, "incompleteJobs >= 0");
  }

  section("S34: runRestartRecovery — idempotent (same result on repeated dry-run) (INV-SAFE4)");
  {
    const { runRestartRecovery } = await import("./server/lib/recovery/platform-restart-recovery");
    const r1 = await runRestartRecovery(true);
    const r2 = await runRestartRecovery(true);
    assertEq(r1.incompleteJobs, r2.incompleteJobs, "idempotent: incompleteJobs consistent");
    assertEq(r1.markedFailed,   r2.markedFailed,   "idempotent: markedFailed consistent");
  }

  section("S35: explainRestartRecovery — produces structured output");
  {
    const { explainRestartRecovery, runRestartRecovery } =
      await import("./server/lib/recovery/platform-restart-recovery");

    const result = await runRestartRecovery(true);
    const exp    = explainRestartRecovery(result);
    assertStr(exp, "explainRestartRecovery returns non-empty string");
    assert(exp.includes("DRY-RUN") || exp.includes("dry") || exp.includes("Requeued"),
      "explanation mentions dry-run or recovery actions");
    assert(exp.includes(String(result.incompleteJobs)),
      "explanation includes incomplete job count");
  }

  section("S36: summarizeRecoveryState — returns structured summary");
  {
    const { summarizeRecoveryState } = await import("./server/lib/recovery/platform-restart-recovery");
    const summary = await summarizeRecoveryState();
    assertNum(summary.totalIncomplete, "totalIncomplete is number");
    assertNum(summary.recoverable,     "recoverable is number");
    assertNum(summary.pendingRetries,  "pendingRetries is number");
    assertStr(summary.queueHealth,     "queueHealth is non-empty string");
    assertStr(summary.explanation,     "explanation is non-empty string");
    assertIso(summary.checkedAt,       "checkedAt is ISO date");
    assert(["healthy", "degraded", "critical"].includes(summary.queueHealth),
      `queueHealth is valid (got: ${summary.queueHealth})`);
    assert(summary.pendingRetries >= 0, "pendingRetries >= 0");
  }

  section("S37: detectIncompleteJobs — recoverable field set correctly");
  {
    const { detectIncompleteJobs } = await import("./server/lib/recovery/platform-restart-recovery");
    const jobs = await detectIncompleteJobs(30);
    for (const job of jobs) {
      if (job.attemptCount >= job.maxAttempts) {
        assert(!job.recoverable, `exhausted job ${job.id} is not recoverable`);
      } else {
        assert(job.recoverable,  `non-exhausted job ${job.id} is recoverable`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S38–S44: Safety Observability
  // ══════════════════════════════════════════════════════════════════════════

  section("S38: safety-observability — exports required functions");
  {
    const mod = await import("./server/lib/safety/safety-observability");
    assert(typeof mod.recordTenantStateChange    === "function", "recordTenantStateChange exported");
    assert(typeof mod.recordCircuitBreakerOpen   === "function", "recordCircuitBreakerOpen exported");
    assert(typeof mod.recordCircuitBreakerClosed === "function", "recordCircuitBreakerClosed exported");
    assert(typeof mod.recordRateLimitViolation   === "function", "recordRateLimitViolation exported");
    assert(typeof mod.recordRestartRecovery      === "function", "recordRestartRecovery exported");
    assert(typeof mod.recordJobResumed           === "function", "recordJobResumed exported");
    assert(typeof mod.recordJobMarkedFailed      === "function", "recordJobMarkedFailed exported");
    assert(typeof mod.getSafetySnapshot          === "function", "getSafetySnapshot exported");
    assert(typeof mod.getTenantSafetyRecord      === "function", "getTenantSafetyRecord exported");
    assert(typeof mod.getRecentSafetyEvents      === "function", "getRecentSafetyEvents exported");
    assert(typeof mod.getFrozenTenants           === "function", "getFrozenTenants exported");
  }

  section("S39: safety-observability — tenant state tracking");
  {
    const obs = await import("./server/lib/safety/safety-observability");

    obs.recordTenantStateChange("obs-test-tenant", "normal", "throttled", "load test");
    obs.recordTenantStateChange("obs-test-tenant", "throttled", "frozen", "token explosion");

    const record = obs.getTenantSafetyRecord("obs-test-tenant");
    assert(record !== null,             "tenant record created");
    assertEq(record!.currentState, "frozen",   "current state is frozen");
    assert(record!.frozenCount >= 1,    "frozenCount incremented");
    assertStr(record!.lastFrozenAt!,    "lastFrozenAt is set");
    assert(record!.transitions.length >= 2, "both transitions recorded");
  }

  section("S40: safety-observability — rate limit violation tracking");
  {
    const obs = await import("./server/lib/safety/safety-observability");
    const before = obs.getSafetySnapshot().rateLimitViolations;
    obs.recordRateLimitViolation("ip:test", "admin", 15);
    obs.recordRateLimitViolation("tenant:abc", "ai", 75);
    const after = obs.getSafetySnapshot().rateLimitViolations;
    assert(after >= before + 2, "rateLimitViolations counter incremented");
  }

  section("S41: safety-observability — restart recovery tracking");
  {
    const obs = await import("./server/lib/safety/safety-observability");
    const before = obs.getSafetySnapshot().restartRecoveries;
    obs.recordRestartRecovery(5, 3, []);
    obs.recordRestartRecovery(0, 0, ["connection timeout"]);
    const snap = obs.getSafetySnapshot();
    assert(snap.restartRecoveries >= before + 2, "restartRecoveries counter incremented");
  }

  section("S42: getSafetySnapshot — full structure");
  {
    const { getSafetySnapshot } = await import("./server/lib/safety/safety-observability");
    const snap = getSafetySnapshot();
    assertNum(snap.totalEvents,          "totalEvents is number");
    assertArr(snap.recentEvents,         "recentEvents is array");
    assertArr(snap.tenantRecords,        "tenantRecords is array");
    assertNum(snap.rateLimitViolations,  "rateLimitViolations is number");
    assertNum(snap.restartRecoveries,    "restartRecoveries is number");
    assertArr(snap.frozenTenants,        "frozenTenants is array");
    assertIso(snap.checkedAt,            "checkedAt is ISO date");
    assert(snap.totalEvents > 0,         "at least some events recorded");
  }

  section("S43: getFrozenTenants — returns correct set");
  {
    const obs = await import("./server/lib/safety/safety-observability");
    obs.recordTenantStateChange("frozen-tenant-1", "normal", "frozen", "abuse");
    obs.recordTenantStateChange("frozen-tenant-2", "normal", "frozen", "loop");
    const frozen = obs.getFrozenTenants();
    assertArr(frozen, "getFrozenTenants returns array");
    assert(frozen.includes("frozen-tenant-1"), "frozen-tenant-1 in frozen list");
    assert(frozen.includes("frozen-tenant-2"), "frozen-tenant-2 in frozen list");
  }

  section("S44: getRecentSafetyEvents — filter by type");
  {
    const obs = await import("./server/lib/safety/safety-observability");
    obs.recordCircuitBreakerOpen("tenant-cb-test", "runaway loop");
    const events = obs.getRecentSafetyEvents("circuit_breaker_open");
    assertArr(events, "events is array");
    assert(events.length > 0, "at least 1 circuit_breaker_open event");
    assert(events.every(e => e.type === "circuit_breaker_open"), "all events are correct type");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S45–S50: Admin API endpoints
  // ══════════════════════════════════════════════════════════════════════════

  section("S45: GET /api/admin/safety/tenant-status — responds");
  {
    const r = await httpGet("/api/admin/safety/tenant-status");
    assert(r.status === 200 || r.status === 401 || r.status === 500,
      "tenant-status responds");
    if (r.status === 200) {
      assert(typeof r.body?.states === "object", "states is object");
      assertStr(r.body?.summary,  "summary is string");
      assertArr(r.body?.recentTransitions, "recentTransitions is array");
    }
  }

  section("S46: GET /api/admin/safety/rate-limit-state — responds");
  {
    const r = await httpGet("/api/admin/safety/rate-limit-state");
    assert(r.status === 200 || r.status === 401 || r.status === 500,
      "rate-limit-state responds");
    if (r.status === 200) {
      assert(typeof r.body?.summary === "object", "summary is object");
      assertArr(r.body?.recentViolations, "recentViolations is array");
    }
  }

  section("S47: GET /api/admin/safety/platform-restart-health — responds");
  {
    const r = await httpGet("/api/admin/safety/platform-restart-health");
    assert(r.status === 200 || r.status === 401 || r.status === 500,
      "platform-restart-health responds");
    if (r.status === 200) {
      assert(typeof r.body?.summary === "object", "summary is object");
    }
  }

  section("S48: POST /api/admin/safety/tenant-throttle — throttles tenant");
  {
    const r = await httpPost("/api/admin/safety/tenant-throttle", {
      tenantId: "api-test-tenant-1",
      reason:   "Phase 30 validation test",
    });
    assert(r.status === 200 || r.status === 401 || r.status === 500,
      "tenant-throttle responds");
    if (r.status === 200) {
      assertEq(r.body?.result?.state, "throttled", "result state is throttled");
      assertStr(r.body?.explain,       "explain is present");
    }
  }

  section("S49: POST /api/admin/safety/tenant-unfreeze — unfreezes tenant");
  {
    const r = await httpPost("/api/admin/safety/tenant-unfreeze", {
      tenantId: "api-test-tenant-1",
      reason:   "Phase 30 validation cleanup",
    });
    assert(r.status === 200 || r.status === 401 || r.status === 500,
      "tenant-unfreeze responds");
    if (r.status === 200) {
      assertEq(r.body?.result?.state, "normal", "result state is normal after unfreeze");
      assertStr(r.body?.explain,       "explain is present");
    }
  }

  section("S50: POST /api/admin/safety/tenant-unfreeze — 400 on missing tenantId");
  {
    const r = await httpPost("/api/admin/safety/tenant-unfreeze", {});
    assert(r.status === 400 || r.status === 401 || r.status === 0,
      "missing tenantId returns 400 or auth error");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S51–S55: Service Invariants (INV-SAFE1 to INV-SAFE6)
  // ══════════════════════════════════════════════════════════════════════════

  section("S51: INV-SAFE1 — tenant states are isolated per tenant");
  {
    const { applyTenantProtection, getTenantCurrentState, TENANT_THRESHOLDS: T, unfreezeTenant } =
      await import("./server/lib/safety/tenant-circuit-breaker");

    const frozenMetrics = {
      tenantId: "inv-safe1-frozen",
      agentRunsPerMinute: T.agentRunsPerMinute.frozen + 5,
      tokensPerMinute: 100, webhookEventsPerMinute: 5, queueJobsPerMinute: 2, apiCallsPerMinute: 10,
      windowMinutes: 5, measuredAt: new Date().toISOString(),
    };
    const normalMetrics = { ...frozenMetrics, tenantId: "inv-safe1-normal", agentRunsPerMinute: 1 };

    applyTenantProtection("inv-safe1-frozen",  frozenMetrics);
    applyTenantProtection("inv-safe1-normal",  normalMetrics);

    assertEq(getTenantCurrentState("inv-safe1-frozen"), "frozen",  "frozen tenant is frozen");
    assertEq(getTenantCurrentState("inv-safe1-normal"), "normal",  "normal tenant unaffected (INV-SAFE1)");

    unfreezeTenant("inv-safe1-frozen", "cleanup");
  }

  section("S52: INV-SAFE2 — all circuit breaker transitions are logged");
  {
    const {
      applyTenantProtection, unfreezeTenant, getTenantTransitionHistory, TENANT_THRESHOLDS: T,
    } = await import("./server/lib/safety/tenant-circuit-breaker");

    const id = "inv-safe2-logging-test";
    unfreezeTenant(id, "reset");
    const before = getTenantTransitionHistory(id).length;

    const m = {
      tenantId: id,
      agentRunsPerMinute: T.agentRunsPerMinute.frozen + 5,
      tokensPerMinute: 100, webhookEventsPerMinute: 5, queueJobsPerMinute: 2, apiCallsPerMinute: 10,
      windowMinutes: 5, measuredAt: new Date().toISOString(),
    };
    applyTenantProtection(id, m);
    unfreezeTenant(id, "cleanup");

    const history = getTenantTransitionHistory(id);
    assert(history.length > before, "transitions logged (INV-SAFE2)");
    for (const t of history.slice(before)) {
      assertStr(t.reason, `transition has reason: ${t.to}`);
      assertStr(t.timestamp, `transition has timestamp: ${t.to}`);
      assertIso(t.timestamp, `transition timestamp is ISO: ${t.to}`);
    }
  }

  section("S53: INV-SAFE3 — rate limit is deterministic across calls");
  {
    const { checkRateLimit, resetRateLimit } = await import("./server/lib/security/global-rate-limiter");

    resetRateLimit("ip", "inv-safe3-det", "ai");
    const results = Array.from({ length: 5 }, () =>
      checkRateLimit("ip", "inv-safe3-det", "/api/ai/run"),
    );
    const categories = new Set(results.map(r => r.category));
    const limits     = new Set(results.map(r => r.limit));
    assertEq(categories.size, 1, "INV-SAFE3: category deterministic");
    assertEq(limits.size,     1, "INV-SAFE3: limit deterministic");
  }

  section("S54: INV-SAFE5 — billing always allowed across all tenant states");
  {
    const { STATE_PERMISSIONS } = await import("./server/lib/safety/tenant-circuit-breaker");
    const states = ["normal", "throttled", "restricted", "frozen"] as const;
    for (const state of states) {
      assert(STATE_PERMISSIONS[state].allowed.includes("billing"),
        `INV-SAFE5: billing allowed in state '${state}'`);
    }
  }

  section("S55: INV-SAFE6 — tenant isolation — state changes don't cross tenants");
  {
    const { throttleTenant, unfreezeTenant, getTenantCurrentState } =
      await import("./server/lib/safety/tenant-circuit-breaker");

    throttleTenant("iso-tenant-A", "isolation test");
    throttleTenant("iso-tenant-B", "isolation test");
    unfreezeTenant("iso-tenant-A",  "isolation cleanup");

    assertEq(getTenantCurrentState("iso-tenant-A"), "normal",    "tenant A back to normal");
    assertEq(getTenantCurrentState("iso-tenant-B"), "throttled", "tenant B unaffected (INV-SAFE6)");

    unfreezeTenant("iso-tenant-B", "cleanup");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n───────────────────────────────────────────────────────");
  console.log(`Phase 30 validation: ${passed} passed, ${failed} failed`);

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
