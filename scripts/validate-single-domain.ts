/**
 * scripts/validate-single-domain.ts
 *
 * Validates that single-domain production mode is correctly enforced.
 * Fails loudly if any assertion is wrong.
 *
 * Run: npx tsx scripts/validate-single-domain.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failures.push(label);
    failed++;
  }
}

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, "..", rel), "utf-8");
}

console.log("\nSingle-Domain Production Mode — Validation");
console.log("=".repeat(60));

// ─── 1. DOMAIN_CONFIG.mode is "single" ────────────────────────────────────────

console.log('\n─── 1. DOMAIN_CONFIG.mode is "single"');
{
  const { DOMAIN_CONFIG } = await import("../server/lib/platform/domain-config");
  assert(DOMAIN_CONFIG.mode === "single", 'DOMAIN_CONFIG.mode === "single"');
  assert(DOMAIN_CONFIG.primaryDomain === "blissops.com", 'primaryDomain === "blissops.com"');
  assert(DOMAIN_CONFIG.allowHosts.includes("blissops.com"), "blissops.com in allowHosts");
  assert(DOMAIN_CONFIG.allowHosts.includes("www.blissops.com"), "www.blissops.com in allowHosts");
  assert(!DOMAIN_CONFIG.allowHosts.includes("app.blissops.com"), "app.blissops.com NOT in allowHosts");
  assert(!DOMAIN_CONFIG.allowHosts.includes("admin.blissops.com"), "admin.blissops.com NOT in allowHosts");
  assert(DOMAIN_CONFIG.blockPreviewHosts === true, "blockPreviewHosts === true");
}

// ─── 2. blissops.com is allowed ───────────────────────────────────────────────

console.log("\n─── 2. Host allowlist — blissops.com allowed");
{
  const { PRODUCTION_ALLOWED_HOSTS } = await import("../server/lib/platform/platform-hardening-config");
  assert(PRODUCTION_ALLOWED_HOSTS.has("blissops.com"), "PRODUCTION_ALLOWED_HOSTS has blissops.com");
  assert(PRODUCTION_ALLOWED_HOSTS.has("www.blissops.com"), "PRODUCTION_ALLOWED_HOSTS has www.blissops.com");
  assert(!PRODUCTION_ALLOWED_HOSTS.has("app.blissops.com"), "app.blissops.com NOT in PRODUCTION_ALLOWED_HOSTS");
  assert(!PRODUCTION_ALLOWED_HOSTS.has("admin.blissops.com"), "admin.blissops.com NOT in PRODUCTION_ALLOWED_HOSTS");
}

// ─── 3. www.blissops.com redirects to blissops.com ────────────────────────────

console.log("\n─── 3. www redirect configuration");
{
  const { WWW_REDIRECT_CONFIG, PUBLIC_CANONICAL_HOST } = await import("../server/lib/platform/platform-hardening-config");
  assert(WWW_REDIRECT_CONFIG.from === "www.blissops.com", "WWW_REDIRECT_CONFIG.from === www.blissops.com");
  assert(WWW_REDIRECT_CONFIG.to === "blissops.com", "WWW_REDIRECT_CONFIG.to === blissops.com");
  assert(WWW_REDIRECT_CONFIG.statusCode === 301, "WWW redirect uses 301");
  assert(PUBLIC_CANONICAL_HOST === "blissops.com", "PUBLIC_CANONICAL_HOST === blissops.com");

  const wwwSrc = readSrc("server/middleware/www-redirect.ts");
  assert(wwwSrc.includes("301"), "www-redirect middleware uses 301");
  assert(wwwSrc.includes("blissops.com"), "www-redirect references blissops.com");
}

// ─── 4. *.vercel.app blocked in production ────────────────────────────────────

console.log("\n─── 4. Preview host blocking");
{
  const { isAllowedHost } = await import("../server/middleware/host-allowlist");
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const testHosts = [
    "my-project.vercel.app",
    "blissops-git-main.vercel.app",
    "random.netlify.app",
  ];

  for (const host of testHosts) {
    assert(!isAllowedHost(host), `${host} is blocked in production`);
  }

  assert(isAllowedHost("blissops.com"), "blissops.com is allowed in production");

  process.env.NODE_ENV = originalNodeEnv;
}

// ─── 5. No active runtime code depends on app.blissops.com ───────────────────

console.log("\n─── 5. No active runtime code depends on app.blissops.com");
{
  const filesToCheck = [
    "server/middleware/host-allowlist.ts",
    "server/middleware/admin-domain.ts",
    "server/middleware/auth.ts",
    "server/lib/platform/platform-hardening-config.ts",
    "server/routes/robots.ts",
    "server/app.ts",
  ];

  const activePatterns = [
    /PRODUCTION_ALLOWED_HOSTS.*app\.blissops/,
    /redirect.*app\.blissops/,
    /canonicalHost.*app\.blissops/,
    /cookieScope.*app\.blissops/,
    /callbackHost.*app\.blissops/,
  ];

  for (const file of filesToCheck) {
    const src = readSrc(file);
    for (const pattern of activePatterns) {
      assert(
        !pattern.test(src),
        `${file}: no active runtime ref to app.blissops.com (pattern: ${pattern.source})`,
      );
    }
  }
}

// ─── 6. No active runtime code depends on admin.blissops.com ─────────────────

console.log("\n─── 6. No active runtime code depends on admin.blissops.com");
{
  const filesToCheck = [
    "server/middleware/host-allowlist.ts",
    "server/middleware/admin-domain.ts",
    "server/lib/platform/platform-hardening-config.ts",
    "server/app.ts",
  ];

  const activePatterns = [
    /PRODUCTION_ALLOWED_HOSTS.*admin\.blissops/,
    /redirect.*admin\.blissops/,
    /canonicalHost.*['"]admin\.blissops/,
  ];

  for (const file of filesToCheck) {
    const src = readSrc(file);
    for (const pattern of activePatterns) {
      assert(
        !pattern.test(src),
        `${file}: no active runtime ref to admin.blissops.com (pattern: ${pattern.source})`,
      );
    }
  }
}

// ─── 7. Protected app routes require auth ────────────────────────────────────

console.log("\n─── 7. Protected app routes require auth");
{
  const authSrc = readSrc("server/middleware/auth.ts");
  assert(authSrc.includes("UNAUTHORIZED"), "auth middleware returns 401 UNAUTHORIZED");
  assert(authSrc.includes("Bearer"), "auth middleware checks Bearer token");
  assert(authSrc.includes("/api/auth/config"), "/api/auth/config is in public bypass list");

  const appSrc = readSrc("server/app.ts");
  assert(appSrc.includes("authMiddleware"), "server/app.ts applies authMiddleware");
  assert(appSrc.includes("lockdownGuard"), "server/app.ts applies lockdownGuard");
}

// ─── 8. Admin/ops routes require platform_admin ──────────────────────────────

console.log("\n─── 8. Admin/ops routes require platform_admin role");
{
  const adminDomainSrc = readSrc("server/middleware/admin-domain.ts");
  assert(
    !adminDomainSrc.includes("redirect(302") && !adminDomainSrc.includes("redirect(301"),
    "admin-domain middleware does NOT redirect to admin.blissops.com",
  );
  assert(
    adminDomainSrc.includes("hostBasedAccess") || !adminDomainSrc.includes("ADMIN_HOST_REQUIRED"),
    "admin-domain middleware does not enforce host-based 403",
  );

  const appSrc = readSrc("server/app.ts");
  assert(appSrc.includes("adminGuardMiddleware"), "server/app.ts applies adminGuardMiddleware for /api/admin");

  const { ADMIN_CONFIG } = await import("../server/lib/platform/platform-hardening-config");
  assert(ADMIN_CONFIG.requiresRoleGuard === true, "ADMIN_CONFIG.requiresRoleGuard === true");
  assert(ADMIN_CONFIG.hostBasedAccess === false, "ADMIN_CONFIG.hostBasedAccess === false");
}

// ─── 9. Bypass paths function ────────────────────────────────────────────────

console.log("\n─── 9. Bypass paths");
{
  const authSrc = readSrc("server/middleware/auth.ts");
  assert(authSrc.includes("/api/auth/config"), "/api/auth/config bypasses auth");
  assert(authSrc.includes("/api/admin/platform/deploy-health"), "deploy-health bypasses auth");

  const hostSrc = readSrc("server/middleware/host-allowlist.ts");
  assert(hostSrc.includes("/health"), "/health bypasses host check");
  assert(hostSrc.includes("/ping"), "/ping bypasses host check");
}

// ─── 10. Robots/indexing matches "protected app on root domain" ───────────────

console.log("\n─── 10. Robots / indexing policy");
{
  const robotsSrc = readSrc("server/routes/robots.ts");
  assert(robotsSrc.includes("Disallow: /"), "robots.txt serves Disallow: /");
  assert(!robotsSrc.includes("Allow: /\n"), "robots.txt does NOT serve Allow: / for any host");
  assert(!robotsSrc.includes("sitemap"), "robots.txt does NOT reference sitemap (app is not public)");

  const { SEO_CONFIG } = await import("../server/lib/platform/platform-hardening-config");
  assert(SEO_CONFIG.indexedHosts.size === 0, "SEO_CONFIG.indexedHosts is empty (no indexed hosts)");
  assert(SEO_CONFIG.noindexHosts.has("blissops.com"), "blissops.com is in noindexHosts");
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("Single-Domain Validation Complete");
console.log("=".repeat(60));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error("\n❌ FAILING ASSERTIONS:");
  failures.forEach((f) => console.error(`  • ${f}`));
  console.error("\nSINGLE DOMAIN MODE: INCOMPLETE ❌");
  process.exit(1);
} else {
  console.log("\n✅ ALL ASSERTIONS PASSED");
  console.log("SINGLE DOMAIN MODE: COMPLETE ✅");
}
