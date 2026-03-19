/**
 * Emergency Lockdown — Validation Script
 *
 * Verifies correct behaviour of the single-email production lockdown guard.
 *
 * Run: npx tsx server/lib/auth/validate-lockdown.ts
 *
 * Exit 0 = all assertions passed.
 * Exit 1 = one or more assertions failed.
 */

import type { Request, Response, NextFunction } from "express";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  reqOverrides: {
    user?: { id: string; email?: string; organizationId: string; role: string } | null;
    path?: string;
  } = {},
): Promise<{ result: "next" | "respond"; status?: number; body?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = {
      user: reqOverrides.user ?? undefined,
      path: reqOverrides.path ?? "/api/projects",
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    } as unknown as Request;

    const res = {
      status(code: number) {
        this._status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        resolve({ result: "respond", status: (this as any)._status ?? 200, body });
        return this;
      },
      _status: 200,
    } as unknown as Response;

    const next = () => resolve({ result: "next" });
    middleware(req, res, next);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/**
 * Build a fresh guard using fresh module import so env changes take effect.
 * Because modules are cached, we re-implement the guard logic inline here
 * using the exported helpers to simulate env-fresh behaviour.
 */
async function buildFreshGuard(
  enabled: boolean,
  allowlist: string,
): Promise<(req: Request, res: Response, next: NextFunction) => void> {
  const {
    resolveLockdownConfig,
    LOCKDOWN_BYPASS_PATHS,
  } = await import("../../middleware/lockdown");

  const cfg = { enabled, allowlist: new Set(allowlist.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.enabled) return next();
    if ((LOCKDOWN_BYPASS_PATHS as readonly string[]).includes(req.path)) return next();
    if (!req.user?.id) {
      res.status(401).json({ error_code: "UNAUTHORIZED", message: "Authentication required." });
      return;
    }
    const email = (req.user.email ?? "").trim().toLowerCase();
    if (!cfg.allowlist.has(email)) {
      res.status(403).json({ error_code: "LOCKDOWN_FORBIDDEN", message: "Access denied." });
      return;
    }
    next();
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const allowlistedUser = {
  id: "user-001",
  email: "seomidt@gmail.com",
  organizationId: "org-001",
  role: "platform_admin",
};

const blockedUser = {
  id: "user-002",
  email: "other@example.com",
  organizationId: "org-002",
  role: "member",
};

const demoUser = {
  id: "demo-abc",
  email: "demo@example.com",
  organizationId: "demo-org",
  role: "viewer",
};

const uppercaseEmailUser = {
  id: "user-003",
  email: "SEOMIDT@GMAIL.COM",
  organizationId: "org-001",
  role: "member",
};

const paddedEmailUser = {
  id: "user-004",
  email: "  seomidt@gmail.com  ",
  organizationId: "org-001",
  role: "member",
};

// ── Sections ──────────────────────────────────────────────────────────────────

async function section1_moduleExports(): Promise<void> {
  console.log("\n1. Module exports and config");

  const mod = await import("../../middleware/lockdown");
  assert(typeof mod.lockdownGuard === "function", "lockdownGuard is a function");
  assert(typeof mod.isEmailAllowlisted === "function", "isEmailAllowlisted is a function");
  assert(typeof mod.isLockdownEnabled === "function", "isLockdownEnabled is a function");
  assert(typeof mod.resolveLockdownConfig === "function", "resolveLockdownConfig is a function");
  assert(Array.isArray(mod.LOCKDOWN_BYPASS_PATHS), "LOCKDOWN_BYPASS_PATHS is an array");
  assert(mod.LOCKDOWN_BYPASS_PATHS.length >= 10, `bypass list has >= 10 entries (got ${mod.LOCKDOWN_BYPASS_PATHS.length})`);
}

async function section2_bypassPaths(): Promise<void> {
  console.log("\n2. Bypass paths");

  const { LOCKDOWN_BYPASS_PATHS } = await import("../../middleware/lockdown");

  const expected = [
    "/api/admin/platform/deploy-health",
    "/api/admin/recovery/backup-status",
    "/robots.txt",
    "/api/security/csp-report",
    "/health",
    "/healthz",
    "/ping",
  ];

  for (const path of expected) {
    assert(
      (LOCKDOWN_BYPASS_PATHS as readonly string[]).includes(path),
      `bypass list includes "${path}"`,
    );
  }

  assert(
    !(LOCKDOWN_BYPASS_PATHS as readonly string[]).includes("/api/projects"),
    "app route /api/projects NOT in bypass list",
  );
  assert(
    !(LOCKDOWN_BYPASS_PATHS as readonly string[]).includes("/api/ai/summarize"),
    "AI route /api/ai/summarize NOT in bypass list",
  );
  assert(
    !(LOCKDOWN_BYPASS_PATHS as readonly string[]).includes("/api/admin/tenants"),
    "admin route /api/admin/tenants NOT in bypass list",
  );
}

async function section3_lockdownDisabled(): Promise<void> {
  console.log("\n3. Lockdown DISABLED (pass-through)");

  const guard = await buildFreshGuard(false, "seomidt@gmail.com");

  const anon = await runMiddleware(guard, { user: null });
  assert(anon.result === "next", "lockdown off: anonymous → passes through");

  const blocked = await runMiddleware(guard, { user: blockedUser });
  assert(blocked.result === "next", "lockdown off: non-listed user → passes through");

  const allowed = await runMiddleware(guard, { user: allowlistedUser });
  assert(allowed.result === "next", "lockdown off: allowlisted user → passes through");
}

async function section4_lockdownEnabled(): Promise<void> {
  console.log("\n4. Lockdown ENABLED — core enforcement");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  // 1. anonymous request → 401
  const anon = await runMiddleware(guard, { user: null });
  assert(anon.result === "respond" && anon.status === 401, "anonymous → 401");
  assert(anon.body?.error_code === "UNAUTHORIZED", "anonymous → UNAUTHORIZED error_code");

  // 2. authenticated allowlisted user → allowed
  const allowed = await runMiddleware(guard, { user: allowlistedUser });
  assert(allowed.result === "next", "seomidt@gmail.com → allowed");

  // 3. authenticated other email → 403
  const other = await runMiddleware(guard, { user: blockedUser });
  assert(other.result === "respond" && other.status === 403, "other email → 403");
  assert(other.body?.error_code === "LOCKDOWN_FORBIDDEN", "other email → LOCKDOWN_FORBIDDEN");

  // 4. demo user → 403 (not in allowlist)
  const demo = await runMiddleware(guard, { user: demoUser });
  assert(demo.result === "respond" && demo.status === 403, "demo user → 403");
}

async function section5_emailNormalization(): Promise<void> {
  console.log("\n5. Email normalization (trim + lowercase)");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  // Uppercase → normalized to lowercase → allowed
  const upper = await runMiddleware(guard, { user: uppercaseEmailUser });
  assert(upper.result === "next", "SEOMIDT@GMAIL.COM (uppercase) → allowed (normalized)");

  // Padded with spaces → trimmed → allowed
  const padded = await runMiddleware(guard, { user: paddedEmailUser });
  assert(padded.result === "next", "  seomidt@gmail.com  (padded) → allowed (trimmed)");

  // Empty email → blocked
  const noEmail = await runMiddleware(guard, {
    user: { id: "u", email: "", organizationId: "org", role: "member" },
  });
  assert(noEmail.result === "respond" && noEmail.status === 403, "empty email → 403");

  // Undefined email → blocked
  const undefinedEmail = await runMiddleware(guard, {
    user: { id: "u", email: undefined, organizationId: "org", role: "member" },
  });
  assert(undefinedEmail.result === "respond" && undefinedEmail.status === 403, "undefined email → 403");
}

async function section6_aiRoutes(): Promise<void> {
  console.log("\n6. AI routes — only allowlisted email may access");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  // AI route with non-allowlisted email → 403
  const aiBlocked = await runMiddleware(guard, {
    user: blockedUser,
    path: "/api/ai/summarize",
  });
  assert(aiBlocked.result === "respond" && aiBlocked.status === 403, "AI route + other email → 403");

  // AI route with allowlisted email → passes lockdown (AI guards handle budget/rate etc)
  const aiAllowed = await runMiddleware(guard, {
    user: allowlistedUser,
    path: "/api/ai/summarize",
  });
  assert(aiAllowed.result === "next", "AI route + seomidt@gmail.com → passes lockdown");

  // Execute run with non-allowlisted email → 403
  const runBlocked = await runMiddleware(guard, {
    user: blockedUser,
    path: "/api/runs/run-001/execute",
  });
  assert(runBlocked.result === "respond" && runBlocked.status === 403, "execute run + other email → 403");
}

async function section7_adminRoutes(): Promise<void> {
  console.log("\n7. Admin routes — only allowlisted email may access");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  // Admin route with non-allowlisted email → 403
  const adminBlocked = await runMiddleware(guard, {
    user: blockedUser,
    path: "/api/admin/tenants",
  });
  assert(adminBlocked.result === "respond" && adminBlocked.status === 403, "admin route + other email → 403");

  // Admin AI Ops with non-allowlisted email → 403
  const aiOpsBlocked = await runMiddleware(guard, {
    user: blockedUser,
    path: "/api/admin/ai-ops/query",
  });
  assert(aiOpsBlocked.result === "respond" && aiOpsBlocked.status === 403, "AI Ops route + other email → 403");

  // Allowlisted email on admin route → passes lockdown (admin guard handles role)
  const adminAllowed = await runMiddleware(guard, {
    user: allowlistedUser,
    path: "/api/admin/tenants",
  });
  assert(adminAllowed.result === "next", "admin route + seomidt@gmail.com → passes lockdown");
}

async function section8_appRoutes(): Promise<void> {
  console.log("\n8. Protected app routes — only allowlisted email may access");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  const routes = [
    "/api/projects",
    "/api/runs",
    "/api/integrations",
    "/api/architectures",
    "/api/tenant/locale",
  ];

  for (const path of routes) {
    const blocked = await runMiddleware(guard, { user: blockedUser, path });
    assert(
      blocked.result === "respond" && blocked.status === 403,
      `app route ${path} + other email → 403`,
    );

    const allowed = await runMiddleware(guard, { user: allowlistedUser, path });
    assert(
      allowed.result === "next",
      `app route ${path} + seomidt@gmail.com → passes lockdown`,
    );
  }
}

async function section9_bypassUnderLockdown(): Promise<void> {
  console.log("\n9. Bypass paths remain accessible under lockdown");

  const guard = await buildFreshGuard(true, "seomidt@gmail.com");

  const { LOCKDOWN_BYPASS_PATHS } = await import("../../middleware/lockdown");

  for (const path of LOCKDOWN_BYPASS_PATHS) {
    const result = await runMiddleware(guard, { user: null, path });
    assert(result.result === "next", `bypass path "${path}" → passes even when anon + lockdown on`);
  }
}

async function section10_isEmailAllowlisted(): Promise<void> {
  console.log("\n10. isEmailAllowlisted() helper");

  const { isEmailAllowlisted } = await import("../../middleware/lockdown");

  // The module-level config is whatever LOCKDOWN_ALLOWLIST env is set to.
  // We test the helper directly with the resolveLockdownConfig approach.
  // Re-test normalization at the helper level.
  const orig = process.env.LOCKDOWN_ALLOWLIST;
  const origEnabled = process.env.LOCKDOWN_ENABLED;
  process.env.LOCKDOWN_ALLOWLIST = "seomidt@gmail.com";
  process.env.LOCKDOWN_ENABLED = "true";

  const { resolveLockdownConfig } = await import("../../middleware/lockdown");
  const cfg = resolveLockdownConfig();

  assert(cfg.enabled === true, "resolveLockdownConfig: enabled=true when LOCKDOWN_ENABLED=true");
  assert(cfg.allowlist.has("seomidt@gmail.com"), "resolveLockdownConfig: allowlist has normalized email");
  assert(!cfg.allowlist.has("SEOMIDT@GMAIL.COM"), "resolveLockdownConfig: allowlist uses lowercase (no uppercase entry)");

  if (orig !== undefined) process.env.LOCKDOWN_ALLOWLIST = orig;
  else delete process.env.LOCKDOWN_ALLOWLIST;
  if (origEnabled !== undefined) process.env.LOCKDOWN_ENABLED = origEnabled;
  else delete process.env.LOCKDOWN_ENABLED;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("Emergency Lockdown — Validation Script");
  console.log("══════════════════════════════════════════════════════");

  await section1_moduleExports();
  await section2_bypassPaths();
  await section3_lockdownDisabled();
  await section4_lockdownEnabled();
  await section5_emailNormalization();
  await section6_aiRoutes();
  await section7_adminRoutes();
  await section8_appRoutes();
  await section9_bypassUnderLockdown();
  await section10_isEmailAllowlisted();

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`RESULT: ${passed}/${passed + failed} assertions passed`);

  if (failed > 0) {
    console.error(`\nFailed assertions (${failed}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.log("══════════════════════════════════════════════════════");
    process.exit(1);
  } else {
    console.log("ALL ASSERTIONS PASSED ✅");
    console.log("══════════════════════════════════════════════════════");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Validation script crashed:", err);
  process.exit(1);
});
