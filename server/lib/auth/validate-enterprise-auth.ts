/**
 * Enterprise Auth Lockdown — Validation Script
 *
 * Verifies the enforcement of auth, tenant scope, AI protection,
 * role model, rate limiting, feature flags, and public route safety.
 *
 * Run: npx tsx server/lib/auth/validate-enterprise-auth.ts
 *
 * Exit 0 = all assertions passed.
 * Exit 1 = one or more assertions failed.
 */

import {
  requireAuth,
  requireActiveMembership,
  requireTenantScope,
  requireFeatureFlag,
  requirePlatformAdmin,
  adminGuardMiddleware,
  isAiEnabled,
  ADMIN_PUBLIC_PATHS,
  aiRouteChain,
  adminRouteChain,
} from "../../middleware/ai-guards";
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

/**
 * Simulates middleware execution.
 * Returns { status, body } from the simulated response, or "next" if middleware called next().
 */
function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
  reqOverrides: Partial<{
    user: { id: string; email: string; organizationId: string; role: string } | null;
    body: Record<string, unknown>;
    query: Record<string, string>;
    path: string;
    ip: string;
  }> = {},
): Promise<{ result: "next" | "respond"; status?: number; body?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = {
      user: reqOverrides.user ?? undefined,
      body: reqOverrides.body ?? {},
      query: reqOverrides.query ?? {},
      path: reqOverrides.path ?? "/api/test",
      ip: reqOverrides.ip ?? "127.0.0.1",
      headers: {},
    } as unknown as Request;

    const res = {
      _status: 200,
      _body: {},
      status(code: number) {
        this._status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        this._body = body;
        resolve({ result: "respond", status: this._status, body });
        return this;
      },
    } as unknown as Response & { _status: number; _body: Record<string, unknown> };

    const next = () => resolve({ result: "next" });

    Promise.resolve(middleware(req, res, next)).catch(() =>
      resolve({ result: "respond", status: 500, body: { error: "middleware threw" } }),
    );
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const anonymousUser = null;
const demoUser = { id: "demo-abc", email: "demo@example.com", organizationId: "demo-org", role: "viewer" };
const memberUser = { id: "user-001", email: "alice@tenant.com", organizationId: "org-001", role: "member" };
const tenantAdminUser = { id: "user-002", email: "admin@tenant.com", organizationId: "org-001", role: "tenant_admin" };
const platformAdminUser = { id: "user-003", email: "ops@blissops.com", organizationId: "org-internal", role: "platform_admin" };
const superadminUser = { id: "user-004", email: "root@blissops.com", organizationId: "org-internal", role: "superadmin" };
const unknownRoleUser = { id: "user-005", email: "x@y.com", organizationId: "org-001", role: "ops" };
const legacyOwnerUser = { id: "user-006", email: "owner@tenant.com", organizationId: "org-001", role: "owner" };
const wrongTenantUser = { id: "user-007", email: "bob@other.com", organizationId: "org-002", role: "member" };

// ── Section 1: requireAuth ────────────────────────────────────────────────────

async function section1_requireAuth(): Promise<void> {
  console.log("\n1. requireAuth");

  const anon = await runMiddleware(requireAuth, { user: anonymousUser });
  assert(anon.result === "respond" && anon.status === 401, "anonymous → 401");
  assert(anon.body?.error_code === "UNAUTHORIZED", "anonymous → UNAUTHORIZED error_code");

  const demo = await runMiddleware(requireAuth, { user: demoUser });
  assert(demo.result === "next", "demo user (has id) → passes requireAuth");

  const member = await runMiddleware(requireAuth, { user: memberUser });
  assert(member.result === "next", "authenticated member → passes requireAuth");

  const admin = await runMiddleware(requireAuth, { user: platformAdminUser });
  assert(admin.result === "next", "platform admin → passes requireAuth");
}

// ── Section 2: requireActiveMembership ───────────────────────────────────────

async function section2_requireActiveMembership(): Promise<void> {
  console.log("\n2. requireActiveMembership");

  const demo = await runMiddleware(requireActiveMembership, { user: demoUser });
  assert(demo.result === "respond" && demo.status === 403, "demo-org → 403");
  assert(demo.body?.error_code === "FORBIDDEN", "demo-org → FORBIDDEN error_code");

  const noOrg = await runMiddleware(requireActiveMembership, {
    user: { id: "u", email: "e", organizationId: "", role: "member" },
  });
  assert(noOrg.result === "respond" && noOrg.status === 403, "empty org → 403");

  const member = await runMiddleware(requireActiveMembership, { user: memberUser });
  assert(member.result === "next", "real org member → passes");

  const admin = await runMiddleware(requireActiveMembership, { user: platformAdminUser });
  assert(admin.result === "next", "platform admin → passes membership check");
}

// ── Section 3: requireTenantScope ────────────────────────────────────────────

async function section3_requireTenantScope(): Promise<void> {
  console.log("\n3. requireTenantScope");

  const noConflict = await runMiddleware(requireTenantScope, { user: memberUser, body: {} });
  assert(noConflict.result === "next", "no organizationId in body → passes");

  const ownOrg = await runMiddleware(requireTenantScope, {
    user: memberUser,
    body: { organizationId: "org-001" },
  });
  assert(ownOrg.result === "next", "matching org in body → passes");

  const crossTenant = await runMiddleware(requireTenantScope, {
    user: memberUser,
    body: { organizationId: "org-999" },
  });
  assert(crossTenant.result === "respond" && crossTenant.status === 403, "cross-tenant body → 403");
  assert(crossTenant.body?.error_code === "TENANT_SCOPE_VIOLATION", "cross-tenant → TENANT_SCOPE_VIOLATION");

  const crossTenantQuery = await runMiddleware(requireTenantScope, {
    user: memberUser,
    query: { organizationId: "org-999" },
  });
  assert(crossTenantQuery.result === "respond" && crossTenantQuery.status === 403, "cross-tenant query → 403");

  const platformCross = await runMiddleware(requireTenantScope, {
    user: platformAdminUser,
    body: { organizationId: "org-999" },
  });
  assert(platformCross.result === "next", "platform admin → cross-tenant allowed");

  const superCross = await runMiddleware(requireTenantScope, {
    user: superadminUser,
    body: { organizationId: "org-999" },
  });
  assert(superCross.result === "next", "superadmin → cross-tenant allowed");
}

// ── Section 4: requireFeatureFlag ────────────────────────────────────────────

async function section4_requireFeatureFlag(): Promise<void> {
  console.log("\n4. requireFeatureFlag");

  const originalKillSwitch = process.env.AI_KILL_SWITCH;
  const originalEnabled = process.env.AI_ENABLED;

  // AI enabled (default)
  delete process.env.AI_KILL_SWITCH;
  delete process.env.AI_ENABLED;
  const enabled = await runMiddleware(requireFeatureFlag("ai"), { user: memberUser });
  assert(enabled.result === "next", "AI enabled (no env vars) → passes");
  assert(isAiEnabled() === true, "isAiEnabled() true when no kill switch");

  // AI kill switch active
  process.env.AI_KILL_SWITCH = "true";
  const killed = await runMiddleware(requireFeatureFlag("ai"), { user: memberUser });
  assert(killed.result === "respond" && killed.status === 503, "AI_KILL_SWITCH=true → 503");
  assert(killed.body?.error_code === "FEATURE_DISABLED", "kill switch → FEATURE_DISABLED");
  assert(isAiEnabled() === false, "isAiEnabled() false when kill switch on");
  delete process.env.AI_KILL_SWITCH;

  // AI soft disabled
  process.env.AI_ENABLED = "false";
  const softOff = await runMiddleware(requireFeatureFlag("ai"), { user: memberUser });
  assert(softOff.result === "respond" && softOff.status === 503, "AI_ENABLED=false → 503");
  assert(isAiEnabled() === false, "isAiEnabled() false when AI_ENABLED=false");
  delete process.env.AI_ENABLED;

  // Non-AI flag always passes
  const otherFlag = await runMiddleware(requireFeatureFlag("some_other_flag"), { user: memberUser });
  assert(otherFlag.result === "next", "non-AI flag → passes (not checked)");

  // Restore
  if (originalKillSwitch !== undefined) process.env.AI_KILL_SWITCH = originalKillSwitch;
  if (originalEnabled !== undefined) process.env.AI_ENABLED = originalEnabled;
}

// ── Section 5: requirePlatformAdmin ──────────────────────────────────────────

async function section5_requirePlatformAdmin(): Promise<void> {
  console.log("\n5. requirePlatformAdmin");

  const anon = await runMiddleware(requirePlatformAdmin, { user: anonymousUser });
  assert(anon.result === "respond" && anon.status === 401, "anonymous → 401");

  const member = await runMiddleware(requirePlatformAdmin, { user: memberUser });
  assert(member.result === "respond" && member.status === 403, "member → 403");
  assert(member.body?.error_code === "FORBIDDEN", "member → FORBIDDEN error_code");

  const tenantAdmin = await runMiddleware(requirePlatformAdmin, { user: tenantAdminUser });
  assert(tenantAdmin.result === "respond" && tenantAdmin.status === 403, "tenant_admin → 403");

  const unknown = await runMiddleware(requirePlatformAdmin, { user: unknownRoleUser });
  assert(unknown.result === "respond" && unknown.status === 403, "unknown role 'ops' → 403");

  const legacy = await runMiddleware(requirePlatformAdmin, { user: legacyOwnerUser });
  assert(legacy.result === "respond" && legacy.status === 403, "legacy 'owner' role → 403");

  const platformAdmin = await runMiddleware(requirePlatformAdmin, { user: platformAdminUser });
  assert(platformAdmin.result === "next", "platform_admin → passes");

  const superadmin = await runMiddleware(requirePlatformAdmin, { user: superadminUser });
  assert(superadmin.result === "next", "superadmin → passes");
}

// ── Section 6: adminGuardMiddleware (bypass logic) ────────────────────────────

async function section6_adminGuardMiddleware(): Promise<void> {
  console.log("\n6. adminGuardMiddleware (public bypass)");

  assert(
    (ADMIN_PUBLIC_PATHS as readonly string[]).includes("/api/admin/platform/deploy-health"),
    "ADMIN_PUBLIC_PATHS contains deploy-health",
  );
  assert(
    (ADMIN_PUBLIC_PATHS as readonly string[]).includes("/api/admin/recovery/backup-status"),
    "ADMIN_PUBLIC_PATHS contains backup-status",
  );

  const healthAnon = await runMiddleware(
    (req, res, next) => adminGuardMiddleware({ ...req, path: "/api/admin/platform/deploy-health" } as Request, res, next),
    { user: anonymousUser },
  );
  assert(healthAnon.result === "next", "deploy-health bypasses admin guard (anonymous)");

  const regularAnon = await runMiddleware(
    (req, res, next) => adminGuardMiddleware({ ...req, path: "/api/admin/tenants" } as Request, res, next),
    { user: anonymousUser },
  );
  assert(regularAnon.result === "respond" && regularAnon.status === 401, "admin route anon → 401");

  const regularMember = await runMiddleware(
    (req, res, next) => adminGuardMiddleware({ ...req, path: "/api/admin/tenants" } as Request, res, next),
    { user: memberUser },
  );
  assert(regularMember.result === "respond" && regularMember.status === 403, "admin route member → 403");

  const regularAdmin = await runMiddleware(
    (req, res, next) => adminGuardMiddleware({ ...req, path: "/api/admin/tenants" } as Request, res, next),
    { user: platformAdminUser },
  );
  assert(regularAdmin.result === "next", "admin route platform_admin → passes");
}

// ── Section 7: Role model — no implicit elevation ─────────────────────────────

async function section7_roleModel(): Promise<void> {
  console.log("\n7. Role model — no implicit elevation");

  const rolesToTest = [
    { role: "viewer",         shouldPassAdmin: false },
    { role: "member",         shouldPassAdmin: false },
    { role: "owner",          shouldPassAdmin: false },
    { role: "admin",          shouldPassAdmin: false },  // Not in PLATFORM_ADMIN_ROLES
    { role: "tenant_admin",   shouldPassAdmin: false },
    { role: "ops",            shouldPassAdmin: false },
    { role: "platform_admin", shouldPassAdmin: true  },
    { role: "superadmin",     shouldPassAdmin: true  },
  ];

  for (const { role, shouldPassAdmin } of rolesToTest) {
    const user = { id: "u", email: "e@e.com", organizationId: "org-x", role };
    const result = await runMiddleware(requirePlatformAdmin, { user });
    const passed = shouldPassAdmin ? result.result === "next" : result.status === 403 || result.status === 401;
    assert(
      passed,
      `role="${role}" shouldPassAdmin=${shouldPassAdmin} → ${shouldPassAdmin ? "next" : "403"}`,
    );
  }
}

// ── Section 8: aiRouteChain structure ────────────────────────────────────────

async function section8_aiRouteChain(): Promise<void> {
  console.log("\n8. aiRouteChain structure");

  assert(Array.isArray(aiRouteChain), "aiRouteChain is an array");
  assert(aiRouteChain.length === 6, `aiRouteChain has 6 guards (got ${aiRouteChain.length})`);
  assert(aiRouteChain[0] === requireAuth, "aiRouteChain[0] = requireAuth");
  assert(aiRouteChain[1] === requireActiveMembership, "aiRouteChain[1] = requireActiveMembership");
  assert(aiRouteChain[2] === requireTenantScope, "aiRouteChain[2] = requireTenantScope");
  assert(typeof aiRouteChain[3] === "function", "aiRouteChain[3] = requireFeatureFlag('ai') fn");
  assert(typeof aiRouteChain[4] === "function", "aiRouteChain[4] = requireBudgetAvailable fn");
  assert(typeof aiRouteChain[5] === "function", "aiRouteChain[5] = aiExpensiveRateLimit fn");

  assert(Array.isArray(adminRouteChain), "adminRouteChain is an array");
  assert(adminRouteChain.length === 2, `adminRouteChain has 2 guards (got ${adminRouteChain.length})`);
  assert(adminRouteChain[0] === requireAuth, "adminRouteChain[0] = requireAuth");
  assert(adminRouteChain[1] === requirePlatformAdmin, "adminRouteChain[1] = requirePlatformAdmin");
}

// ── Section 9: Public path safety ────────────────────────────────────────────

async function section9_publicPaths(): Promise<void> {
  console.log("\n9. Public path safety");

  const publicPaths = [
    "/api/admin/platform/deploy-health",
    "/api/admin/recovery/backup-status",
    "/api/admin/recovery/trigger-backup",
    "/api/admin/recovery/restore-tenant",
    "/api/admin/recovery/restore-table",
    "/api/admin/recovery/job-recovery",
    "/api/admin/recovery/job-recovery/requeue",
    "/api/admin/recovery/webhook-replay",
    "/api/admin/recovery/stripe-reconcile",
    "/api/admin/recovery/pressure",
    "/api/admin/recovery/brownout",
    "/api/admin/recovery/brownout-history",
  ];

  for (const path of publicPaths) {
    assert(
      (ADMIN_PUBLIC_PATHS as readonly string[]).includes(path),
      `ADMIN_PUBLIC_PATHS includes "${path}"`,
    );
  }

  assert(
    !(ADMIN_PUBLIC_PATHS as readonly string[]).includes("/api/admin/ai-ops/query"),
    "AI Ops query NOT in public paths (must be protected)",
  );
  assert(
    !(ADMIN_PUBLIC_PATHS as readonly string[]).includes("/api/admin/governance/budgets"),
    "Governance budgets NOT in public paths (must be protected)",
  );
}

// ── Section 10: isAiEnabled semantics ────────────────────────────────────────

async function section10_aiKillSwitch(): Promise<void> {
  console.log("\n10. AI kill switch semantics");

  const orig_ks = process.env.AI_KILL_SWITCH;
  const orig_en = process.env.AI_ENABLED;

  delete process.env.AI_KILL_SWITCH;
  delete process.env.AI_ENABLED;
  assert(isAiEnabled() === true, "default → AI enabled");

  process.env.AI_KILL_SWITCH = "true";
  assert(isAiEnabled() === false, "AI_KILL_SWITCH=true → disabled");
  delete process.env.AI_KILL_SWITCH;

  process.env.AI_KILL_SWITCH = "false";
  assert(isAiEnabled() === true, "AI_KILL_SWITCH=false → enabled");
  delete process.env.AI_KILL_SWITCH;

  process.env.AI_ENABLED = "false";
  assert(isAiEnabled() === false, "AI_ENABLED=false → disabled");
  delete process.env.AI_ENABLED;

  process.env.AI_ENABLED = "true";
  assert(isAiEnabled() === true, "AI_ENABLED=true → enabled");
  delete process.env.AI_ENABLED;

  // Kill switch takes priority over AI_ENABLED
  process.env.AI_KILL_SWITCH = "true";
  process.env.AI_ENABLED = "true";
  assert(isAiEnabled() === false, "AI_KILL_SWITCH=true beats AI_ENABLED=true");
  delete process.env.AI_KILL_SWITCH;
  delete process.env.AI_ENABLED;

  if (orig_ks !== undefined) process.env.AI_KILL_SWITCH = orig_ks;
  if (orig_en !== undefined) process.env.AI_ENABLED = orig_en;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("Enterprise Auth Lockdown — Validation Script");
  console.log("══════════════════════════════════════════════════════");

  await section1_requireAuth();
  await section2_requireActiveMembership();
  await section3_requireTenantScope();
  await section4_requireFeatureFlag();
  await section5_requirePlatformAdmin();
  await section6_adminGuardMiddleware();
  await section7_roleModel();
  await section8_aiRouteChain();
  await section9_publicPaths();
  await section10_aiKillSwitch();

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
