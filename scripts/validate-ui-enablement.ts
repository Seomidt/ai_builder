/**
 * scripts/validate-ui-enablement.ts
 * Validates that backend capabilities are correctly wired into the UI.
 */

import { readFileSync } from "fs";
import path from "path";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function readPage(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

function section(name: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${name}`);
  console.log("─".repeat(60));
}

// ── S1: Ops pages no longer stubs ────────────────────────────────────────────

section("S1: Ops pages — no longer stubs");
const OPS_PAGES = [
  "client/src/pages/ops/dashboard.tsx",
  "client/src/pages/ops/tenants.tsx",
  "client/src/pages/ops/ai.tsx",
  "client/src/pages/ops/billing.tsx",
  "client/src/pages/ops/security.tsx",
  "client/src/pages/ops/auth.tsx",
  "client/src/pages/ops/storage.tsx",
  "client/src/pages/ops/recovery.tsx",
  "client/src/pages/ops/release.tsx",
];
for (const p of OPS_PAGES) {
  const src = readPage(p);
  assert(src.includes("useQuery"), `${path.basename(p, ".tsx")}: uses useQuery`);
  assert(src.includes("isLoading"), `${path.basename(p, ".tsx")}: has loading state`);
  assert(src.includes("data-testid"), `${path.basename(p, ".tsx")}: has testIds`);
}

// ── S2: Ops dashboard uses correct endpoints ─────────────────────────────────

section("S2: Ops dashboard endpoints");
const opsDash = readPage("client/src/pages/ops/dashboard.tsx");
assert(opsDash.includes("/api/admin/ai-ops/health-summary"), "dashboard queries health-summary");
assert(opsDash.includes("/api/admin/ai-ops/weekly-digest"), "dashboard queries weekly-digest");
assert(opsDash.includes("failedChecks"), "dashboard shows failed checks");

// ── S3: AI governance page ────────────────────────────────────────────────────

section("S3: Ops AI governance page");
const opsAi = readPage("client/src/pages/ops/ai.tsx");
assert(opsAi.includes("/api/admin/governance/alerts"), "AI page queries alerts");
assert(opsAi.includes("/api/admin/governance/budgets"), "AI page queries budgets");
assert(opsAi.includes("/api/admin/ai-ops/audit"), "AI page queries audit");
assert(opsAi.includes("useMutation"), "AI page has action mutation");
assert(opsAi.includes("generate/budget"), "AI page can trigger budget check");

// ── S4: Security page endpoints ───────────────────────────────────────────────

section("S4: Ops security page");
const opsSec = readPage("client/src/pages/ops/security.tsx");
assert(opsSec.includes("/api/admin/security/health"), "security page queries health");
assert(opsSec.includes("/api/admin/security/events/recent"), "security page queries recent events");

// ── S5: Recovery + Release endpoints ─────────────────────────────────────────

section("S5: Ops recovery + release pages");
const opsRec = readPage("client/src/pages/ops/recovery.tsx");
const opsRel = readPage("client/src/pages/ops/release.tsx");
assert(opsRec.includes("/api/admin/platform/deploy-health"), "recovery queries deploy-health");
assert(opsRel.includes("/api/admin/platform/deploy-health"), "release queries deploy-health");
assert(opsRec.includes("refetchInterval"), "recovery auto-refreshes");

// ── S6: Deferred pages — explicit state ──────────────────────────────────────

section("S6: Deferred pages — explicit state");
const opsJobs = readPage("client/src/pages/ops/jobs.tsx");
const opsHooks = readPage("client/src/pages/ops/webhooks.tsx");
assert(opsJobs.includes("deferred"), "jobs page shows deferred state");
assert(opsHooks.includes("deferred"), "webhooks page shows deferred state");
assert(!opsJobs.includes("useQuery"), "jobs page has no wired query (intentional)");
assert(!opsHooks.includes("useQuery"), "webhooks page has no wired query (intentional)");

// ── S7: Tenant pages already wired ───────────────────────────────────────────

section("S7: Tenant pages — already wired");
const TENANT_PAGES: [string, string][] = [
  ["client/src/pages/tenant/dashboard.tsx", "/api/tenant/dashboard"],
  ["client/src/pages/tenant/ai.tsx",        "/api/tenant/ai/runs"],
  ["client/src/pages/tenant/usage.tsx",     "/api/tenant/usage"],
  ["client/src/pages/tenant/billing.tsx",   "/api/tenant/billing"],
  ["client/src/pages/tenant/audit.tsx",     "/api/tenant/audit"],
];
for (const [file, endpoint] of TENANT_PAGES) {
  const src = readPage(file);
  assert(src.includes(endpoint), `${path.basename(file, ".tsx")}: queries ${endpoint}`);
  assert(src.includes("isLoading"), `${path.basename(file, ".tsx")}: has loading state`);
}

// ── S8: No admin data exposed in tenant pages ─────────────────────────────────

section("S8: No admin data in tenant pages");
const tenantFiles = [
  "client/src/pages/tenant/dashboard.tsx",
  "client/src/pages/tenant/usage.tsx",
  "client/src/pages/tenant/billing.tsx",
  "client/src/pages/tenant/audit.tsx",
];
for (const f of tenantFiles) {
  const src = readPage(f);
  assert(!src.includes("/api/admin/"), `${path.basename(f, ".tsx")}: no /api/admin/ calls`);
}

// ── S9: No tenant data in ops pages ──────────────────────────────────────────

section("S9: No tenant-scoped data in ops pages");
for (const p of OPS_PAGES) {
  const src = readPage(p);
  assert(!src.includes("/api/tenant/"), `${path.basename(p, ".tsx")}: no /api/tenant/ calls`);
}

// ── S10: Responsibility map exists ────────────────────────────────────────────

section("S10: Architecture documentation");
const respMap = readPage("docs/architecture/responsibility-map.md");
assert(respMap.includes("SUPABASE"), "responsibility map mentions Supabase");
assert(respMap.includes("VERCEL"), "responsibility map mentions Vercel");
assert(respMap.includes("CLOUDFLARE"), "responsibility map mentions Cloudflare");
assert(respMap.includes("FLOW OVERVIEW"), "responsibility map has flow section");

// ── S11: Env validation file ──────────────────────────────────────────────────

section("S11: Env validation module");
const envTs = readPage("server/lib/env.ts");
assert(envTs.includes("SUPABASE_URL"), "env.ts validates SUPABASE_URL");
assert(envTs.includes("SUPABASE_SERVICE_ROLE_KEY"), "env.ts validates SERVICE_ROLE_KEY");
assert(envTs.includes("OPENAI_API_KEY"), "env.ts validates OPENAI_API_KEY");
assert(envTs.includes("APP_ENV"), "env.ts validates APP_ENV");
assert(envTs.includes("throw new Error"), "env.ts throws on missing vars");

// ── S12: UI enablement report exists ─────────────────────────────────────────

section("S12: UI enablement report");
const report = readPage("docs/product/ui-enablement-report.md");
assert(report.includes("Gap Analysis"), "report has gap analysis");
assert(report.includes("Deferred"), "report documents deferred items");
assert(report.includes("ops/dashboard"), "report covers ops/dashboard");

// ── RESULTS ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("UI Enablement Validation Complete");
console.log("═".repeat(60));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log("═".repeat(60));

if (failed > 0) {
  console.error(`\n❌ ${failed} ASSERTION(S) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅ ALL ${passed} ASSERTIONS PASSED`);
}
