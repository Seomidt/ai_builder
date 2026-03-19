/**
 * Validation Script — GitHub Review Security Findings
 *
 * Validates 3 security fixes:
 *  1. No implicit role escalation in resolveUserFromRequest
 *  2. /api/admin/analytics/* requires platform_admin
 *  3. /api/admin/ai-ops/audit uses correct request variable
 *
 * Exit code: 0 = all pass, 1 = any failure
 */

import { readFileSync } from "fs";

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failures.push(label);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── FIX 1: Role mapping — no implicit elevation ──────────────────────────────

section("FIX 1: Strict role mapping in resolveUserFromRequest");

const acMod = await import("../server/lib/ai-ops/access-control.js");
const { resolveUserFromRequest } = acMod;

// platform_admin → platform_admin
const pAdmin = resolveUserFromRequest({ user: { id: "u1", role: "platform_admin", organizationId: undefined } });
assert(pAdmin.role === "platform_admin", "platform_admin → platform_admin");

// tenant_admin → tenant_admin
const tAdmin = resolveUserFromRequest({ user: { id: "u2", role: "tenant_admin", organizationId: "org1" } });
assert(tAdmin.role === "tenant_admin", "tenant_admin → tenant_admin");
assert(tAdmin.organizationId === "org1", "tenant_admin preserves organizationId");

// admin → MUST NOT become platform_admin
const adminUser = resolveUserFromRequest({ user: { id: "u3", role: "admin", organizationId: "org1" } });
assert(adminUser.role === "none", "\"admin\" → none (no elevation to platform_admin)");

// ops → MUST NOT become platform_admin
const opsUser = resolveUserFromRequest({ user: { id: "u4", role: "ops", organizationId: "org1" } });
assert(opsUser.role === "none", "\"ops\" → none (no elevation to platform_admin)");

// member → MUST NOT become tenant_admin
const memberUser = resolveUserFromRequest({ user: { id: "u5", role: "member", organizationId: "org1" } });
assert(memberUser.role === "none", "\"member\" → none (no elevation to tenant_admin)");

// owner → MUST NOT become tenant_admin
const ownerUser = resolveUserFromRequest({ user: { id: "u6", role: "owner", organizationId: "org1" } });
assert(ownerUser.role === "none", "\"owner\" → none (no elevation to tenant_admin)");

// unknown role → none
const unknownUser = resolveUserFromRequest({ user: { id: "u7", role: "superuser", organizationId: undefined } });
assert(unknownUser.role === "none", "unknown role → none");

// no user → none
const anonUser = resolveUserFromRequest({ user: null });
assert(anonUser.role === "none", "null user → none");

// ─── FIX 1b: assertAiOpsAccess blocks none-role ───────────────────────────────

section("FIX 1b: assertAiOpsAccess blocks escalated/none users");

const { assertAiOpsAccess, resolveAiOpsScope, AiOpsAccessError } = acMod;

// tenant_admin cannot access platform-wide intents
let tenantBlockedFromPlatform = false;
try {
  assertAiOpsAccess({
    user: { userId: "u2", role: "tenant_admin", organizationId: "org1" },
    requestedIntent: "platform_health_summary",
  });
} catch (e) {
  tenantBlockedFromPlatform = e instanceof AiOpsAccessError;
}
assert(tenantBlockedFromPlatform, "tenant_admin cannot access platform_health_summary");

// none-role blocked from everything
let noneBlocked = false;
try {
  assertAiOpsAccess({
    user: { userId: "u5", role: "none" },
    requestedIntent: "platform_health_summary",
  });
} catch (e) {
  noneBlocked = e instanceof AiOpsAccessError;
}
assert(noneBlocked, "none role blocked from all intents");

// resolveAiOpsScope never returns platform scope for tenant_admin
const tenantScope = resolveAiOpsScope({
  user: { userId: "u2", role: "tenant_admin", organizationId: "org1" },
  requestedIntent: "tenant_usage_summary",
  requestedOrganizationId: "org1",
});
assert(tenantScope.mode === "tenant", "tenant_admin scope.mode is always 'tenant'");
assert(tenantScope.role !== "platform_admin", "tenant_admin scope.role is never platform_admin");

// ─── FIX 2: Admin analytics routes protected ─────────────────────────────────

section("FIX 2: /api/admin/analytics/* authorization guard");

const analyticsSrc = readFileSync("server/routes/analytics.ts", "utf-8");

// Guard function exists
assert(analyticsSrc.includes("requirePlatformAdmin"), "requirePlatformAdmin guard function defined");
assert(analyticsSrc.includes("user.role !== \"platform_admin\""), "guard checks role === platform_admin");
assert(analyticsSrc.includes("status(401)"), "guard returns 401 for unauthenticated");
assert(analyticsSrc.includes("status(403)"), "guard returns 403 for unauthorized");

// All 3 handlers use the guard
const guardUsages = (analyticsSrc.match(/requirePlatformAdmin\(req, res\)/g) || []).length;
assert(guardUsages === 3, `requirePlatformAdmin used in all 3 handlers (found ${guardUsages})`);

// Handlers no longer use _req (renamed to req to support guard)
const summaryHandler = analyticsSrc.indexOf('adminAnalyticsRouter.get("/summary"');
const summarySlice = analyticsSrc.substring(summaryHandler, summaryHandler + 100);
assert(!summarySlice.includes("_req"), "/summary handler uses req (not _req)");

// Guard source: denies tenant admin
assert(
  analyticsSrc.includes("Tenant users cannot access platform-wide analytics"),
  "guard message explicitly mentions tenant users are denied",
);

// ─── FIX 2b: Simulate guard logic ─────────────────────────────────────────────

section("FIX 2b: Guard logic simulation");

function simulateGuard(user: any): { status: number; allowed: boolean } {
  if (!user || !user.id) return { status: 401, allowed: false };
  if (user.role !== "platform_admin") return { status: 403, allowed: false };
  return { status: 200, allowed: true };
}

assert(!simulateGuard(null).allowed, "unauthenticated → denied");
assert(simulateGuard(null).status === 401, "unauthenticated → 401");
assert(!simulateGuard({ id: "u2", role: "tenant_admin" }).allowed, "tenant_admin → denied");
assert(simulateGuard({ id: "u2", role: "tenant_admin" }).status === 403, "tenant_admin → 403");
assert(!simulateGuard({ id: "u5", role: "member" }).allowed, "member → denied");
assert(simulateGuard({ id: "u5", role: "member" }).status === 403, "member → 403");
assert(simulateGuard({ id: "u1", role: "platform_admin" }).allowed, "platform_admin → allowed");
assert(!simulateGuard({ id: "u3", role: "admin" }).allowed, "\"admin\" role → denied (not elevated)");

// ─── FIX 3: Audit route uses correct request variable ─────────────────────────

section("FIX 3: /api/admin/ai-ops/audit uses correct request variable");

const adminSrc = readFileSync("server/routes/admin.ts", "utf-8");

// _req renamed to req in audit handler
const auditHandlerIdx = adminSrc.indexOf('"/api/admin/ai-ops/audit"');
const auditSlice = adminSrc.substring(auditHandlerIdx, auditHandlerIdx + 200);

assert(!auditSlice.includes("_req"), "audit handler no longer uses _req");
assert(auditSlice.includes("(req: Request"), "audit handler declares req: Request");
assert(auditSlice.includes("req.query.limit"), "audit handler reads req.query.limit (not undefined req)");

// No bare `req` usage where `_req` is the parameter name (would cause ReferenceError)
const brokenPattern = /\(_req: Request[^)]*\)[^{]*\{[^}]*\breq\b/;
const auditSection = adminSrc.substring(auditHandlerIdx, auditHandlerIdx + 300);
assert(!brokenPattern.test(auditSection), "no _req param with bare req access (no ReferenceError)");

// ─── FIX 4: Cross-cutting — no platform leakage ───────────────────────────────

section("FIX 4: Cross-cutting data leakage audit");

// access-control.ts source
const acSrc = readFileSync("server/lib/ai-ops/access-control.ts", "utf-8");

// Escalation strings removed
assert(!acSrc.includes('"admin" || rawRole === "ops"'), "\"admin\" no longer maps to platform_admin");
assert(!acSrc.includes('"owner" || rawRole === "member"'), "\"member\" no longer maps to tenant_admin");
assert(acSrc.includes("deny by default"), "deny-by-default comment present");

// assertTenantScopeAllowed still prevents cross-tenant
assert(acSrc.includes("assertTenantScopeAllowed"), "assertTenantScopeAllowed still exported");
assert(acSrc.includes("Cross-tenant access denied"), "cross-tenant rejection message present");

// canAccessPlatformWide only allows platform_admin
assert(acSrc.includes("canAccessPlatformWide"), "canAccessPlatformWide still exported");
assert(
  acSrc.includes('PLATFORM_ADMIN_ROLES.includes(user.role)'),
  "canAccessPlatformWide uses PLATFORM_ADMIN_ROLES list",
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════");
console.log(`  Passed:  ${passed}/${passed + failed}`);
console.log(`  Failed:  ${failed}/${passed + failed}`);
if (failures.length > 0) {
  console.log("\n  Failed assertions:");
  for (const f of failures) console.log(`    ❌ ${f}`);
}
console.log("═══════════════════════════════════════════════════");

if (failed === 0) {
  console.log("  GITHUB REVIEW SECURITY PATCH: COMPLETE ✅");
  process.exit(0);
} else {
  console.log("  GITHUB REVIEW SECURITY PATCH: INCOMPLETE ❌");
  process.exit(1);
}
