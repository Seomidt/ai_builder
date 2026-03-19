/**
 * Domain Architecture Validation Script
 * Phase Next — Domain/Subdomain/Auth Architecture Hardening
 *
 * Run with: npx tsx server/lib/domain/validate-phase-domain.ts
 *
 * Validates:
 *   - Canonical host configuration
 *   - Host allowlist matrix (production vs dev vs preview)
 *   - Admin isolation rules
 *   - Auth domain strategy
 *   - Cookie scope policy
 *   - SEO/indexing rules
 *   - Robots.txt behavior by host
 *   - www redirect configuration
 *   - Preview host safety
 *   - Tenant subdomain readiness docs exist
 */

import {
  PRODUCTION_ALLOWED_HOSTS,
  PUBLIC_CANONICAL_HOST,
  APP_CANONICAL_HOST,
  ADMIN_CANONICAL_HOST,
  WWW_HOST,
  ROOT_DOMAIN,
  DEV_ALLOWED_HOST_PATTERNS,
  PREVIEW_ALLOWED_HOST_PATTERNS,
  ADMIN_CONFIG,
  AUTH_CONFIG,
  COOKIE_POLICY,
  SEO_CONFIG,
  WWW_REDIRECT_CONFIG,
  TENANT_SUBDOMAIN_CONFIG,
  RESERVED_SUBDOMAINS,
  HOST_ALLOWLIST_CONFIG,
} from "../platform/platform-hardening-config";

import { isAllowedHost } from "../../middleware/host-allowlist";

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, value: boolean): void {
  if (value) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─── 1. Canonical host config ─────────────────────────────────────────────────

section("1. Canonical host configuration");
ok("ROOT_DOMAIN is blissops.com",               ROOT_DOMAIN === "blissops.com");
ok("PUBLIC_CANONICAL_HOST is blissops.com",     PUBLIC_CANONICAL_HOST === "blissops.com");
ok("APP_CANONICAL_HOST is app.blissops.com",    APP_CANONICAL_HOST === "app.blissops.com");
ok("ADMIN_CANONICAL_HOST is admin.blissops.com",ADMIN_CANONICAL_HOST === "admin.blissops.com");
ok("WWW_HOST is www.blissops.com",              WWW_HOST === "www.blissops.com");

// ─── 2. Production host allowlist ─────────────────────────────────────────────

section("2. Production host allowlist");
ok("blissops.com in PRODUCTION_ALLOWED_HOSTS",       PRODUCTION_ALLOWED_HOSTS.has("blissops.com"));
ok("www.blissops.com in PRODUCTION_ALLOWED_HOSTS",   PRODUCTION_ALLOWED_HOSTS.has("www.blissops.com"));
ok("app.blissops.com in PRODUCTION_ALLOWED_HOSTS",   PRODUCTION_ALLOWED_HOSTS.has("app.blissops.com"));
ok("admin.blissops.com in PRODUCTION_ALLOWED_HOSTS", PRODUCTION_ALLOWED_HOSTS.has("admin.blissops.com"));
ok("PRODUCTION_ALLOWED_HOSTS has exactly 4 hosts",   PRODUCTION_ALLOWED_HOSTS.size === 4);

// ─── 3. Host allowlist middleware behaviour ───────────────────────────────────

section("3. Host allowlist — non-production (dev) allows all");

// Non-production: should allow dev/preview hosts
const origNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";

ok("dev: localhost allowed",               isAllowedHost("localhost"));
ok("dev: 127.0.0.1 allowed",              isAllowedHost("127.0.0.1"));
ok("dev: blissops.com allowed",           isAllowedHost("blissops.com"));
ok("dev: *.replit.dev allowed",           isAllowedHost("abc.replit.dev"));
ok("dev: *.vercel.app allowed in dev",    isAllowedHost("ai-builder-xyz.vercel.app"));

process.env.NODE_ENV = "production";

section("3b. Host allowlist — production blocks non-canonical");
ok("prod: blissops.com allowed",                isAllowedHost("blissops.com"));
ok("prod: www.blissops.com allowed",            isAllowedHost("www.blissops.com"));
ok("prod: app.blissops.com allowed",            isAllowedHost("app.blissops.com"));
ok("prod: admin.blissops.com allowed",          isAllowedHost("admin.blissops.com"));
ok("prod: *.vercel.app BLOCKED",               !isAllowedHost("ai-builder-xyz.vercel.app"));
ok("prod: *.replit.dev BLOCKED",               !isAllowedHost("abc.replit.dev"));
ok("prod: localhost BLOCKED",                  !isAllowedHost("localhost"));
ok("prod: unknown host BLOCKED",               !isAllowedHost("evil.example.com"));
ok("prod: *.netlify.app BLOCKED",              !isAllowedHost("xyz.netlify.app"));

process.env.NODE_ENV = origNodeEnv ?? "development";

// ─── 4. Admin isolation ───────────────────────────────────────────────────────

section("4. Admin domain isolation config");
ok("ADMIN_CONFIG.canonicalHost is admin.blissops.com",    ADMIN_CONFIG.canonicalHost === "admin.blissops.com");
ok("ADMIN_CONFIG has /ops prefix",                        ADMIN_CONFIG.adminPathPrefixes.includes("/ops"));
ok("ADMIN_CONFIG has /api/admin prefix",                  ADMIN_CONFIG.adminPathPrefixes.includes("/api/admin"));
ok("ADMIN_CONFIG.noindex is true",                        ADMIN_CONFIG.noindex === true);
ok("ADMIN_CONFIG.robotsHeaderValue is noindex, nofollow", ADMIN_CONFIG.robotsHeaderValue === "noindex, nofollow");

// ─── 5. Auth domain strategy ──────────────────────────────────────────────────

section("5. Auth domain strategy");
ok("AUTH_CONFIG.canonicalCallbackHost is app.blissops.com",  AUTH_CONFIG.canonicalCallbackHost === "app.blissops.com");
ok("AUTH_CONFIG.callbackBasePath is /auth",                   AUTH_CONFIG.callbackBasePath === "/auth");
ok("AUTH_CONFIG.cookieScope is app.blissops.com",             AUTH_CONFIG.cookieScope === "app.blissops.com");
ok("AUTH_CONFIG.rootDomainCookieScope is .blissops.com",      AUTH_CONFIG.rootDomainCookieScope === ".blissops.com");
ok("AUTH_CONFIG.logoutRedirect targets app.blissops.com",     AUTH_CONFIG.logoutRedirect.startsWith("https://app.blissops.com"));
ok("AUTH_CONFIG.logoutRedirect does NOT target preview",
   !AUTH_CONFIG.logoutRedirect.includes("vercel.app") &&
   !AUTH_CONFIG.logoutRedirect.includes("replit"));

// ─── 6. Cookie / session policy ───────────────────────────────────────────────

section("6. Cookie / session policy");
ok("COOKIE_POLICY.privilegedScope is app.blissops.com", COOKIE_POLICY.privilegedScope === "app.blissops.com");
ok("COOKIE_POLICY.localeScope is .blissops.com",        COOKIE_POLICY.localeScope === ".blissops.com");
ok("COOKIE_POLICY.sameSite is Lax",                     COOKIE_POLICY.sameSite === "Lax");
ok("COOKIE_POLICY.secure is true",                      COOKIE_POLICY.secure === true);
ok("Cookie NOT using root domain for privileges",
   COOKIE_POLICY.privilegedScope !== `.${ROOT_DOMAIN}`);

// ─── 7. SEO / indexing ────────────────────────────────────────────────────────

section("7. SEO / indexing policy");
ok("SEO: blissops.com is indexed",           SEO_CONFIG.indexedHosts.has("blissops.com"));
ok("SEO: app.blissops.com is noindex",       SEO_CONFIG.noindexHosts.has("app.blissops.com"));
ok("SEO: admin.blissops.com is noindex",     SEO_CONFIG.noindexHosts.has("admin.blissops.com"));
ok("SEO: www.blissops.com is noindex",       SEO_CONFIG.noindexHosts.has("www.blissops.com"));
ok("SEO: preview note exists",               SEO_CONFIG.previewHostNote.length > 0);
ok("SEO: canonical note says blissops.com",  SEO_CONFIG.canonicalNote.includes("blissops.com"));
ok("SEO: canonical never points to preview",
   !SEO_CONFIG.canonicalNote.includes("vercel.app"));

// ─── 8. www redirect config ───────────────────────────────────────────────────

section("8. www redirect configuration");
ok("WWW_REDIRECT_CONFIG.from is www.blissops.com",   WWW_REDIRECT_CONFIG.from === "www.blissops.com");
ok("WWW_REDIRECT_CONFIG.to is blissops.com",         WWW_REDIRECT_CONFIG.to === "blissops.com");
ok("WWW_REDIRECT_CONFIG.statusCode is 301",          WWW_REDIRECT_CONFIG.statusCode === 301);

// ─── 9. Preview host safety ───────────────────────────────────────────────────

section("9. Preview host safety");
ok("PREVIEW patterns include .vercel.app",   PREVIEW_ALLOWED_HOST_PATTERNS.includes(".vercel.app"));
ok("DEV patterns include .replit.dev",       DEV_ALLOWED_HOST_PATTERNS.includes(".replit.dev"));
ok("HOST_ALLOWLIST_CONFIG.blockVercelAppInProduction is true",
   HOST_ALLOWLIST_CONFIG.blockVercelAppInProduction === true);
ok("No preview URL appears in AUTH_CONFIG.logoutRedirect",
   !AUTH_CONFIG.logoutRedirect.includes("vercel"));
ok("No preview URL appears in AUTH_CONFIG.canonicalCallbackHost",
   !AUTH_CONFIG.canonicalCallbackHost.includes("vercel"));

// ─── 10. Tenant subdomain readiness ──────────────────────────────────────────

section("10. Tenant subdomain readiness");
ok("TENANT_SUBDOMAIN_CONFIG exists",               typeof TENANT_SUBDOMAIN_CONFIG === "object");
ok("Tenant subdomains NOT yet enabled (safe)",     TENANT_SUBDOMAIN_CONFIG.enabled === false);
ok("Wildcard DNS requirement documented",           TENANT_SUBDOMAIN_CONFIG.wildcardDnsRequired === true);
ok("Wildcard pattern documented",                   TENANT_SUBDOMAIN_CONFIG.wildcardPattern === "*.blissops.com");
ok("RESERVED_SUBDOMAINS set exists",               RESERVED_SUBDOMAINS.size > 0);
ok("'app' is reserved",                            RESERVED_SUBDOMAINS.has("app"));
ok("'admin' is reserved",                          RESERVED_SUBDOMAINS.has("admin"));
ok("'api' is reserved",                            RESERVED_SUBDOMAINS.has("api"));
ok("'www' is reserved",                            RESERVED_SUBDOMAINS.has("www"));
ok("'auth' is reserved",                           RESERVED_SUBDOMAINS.has("auth"));
ok("Host parsing note documented",                 TENANT_SUBDOMAIN_CONFIG.hostParsingNote.length > 10);
ok("Cookie note documented",                       TENANT_SUBDOMAIN_CONFIG.cookieNote.length > 10);
ok("Migration note documented",                    TENANT_SUBDOMAIN_CONFIG.migrationNote.length > 10);

// ─── 11. Redirect canonical logic ────────────────────────────────────────────

section("11. Canonical URL correctness");
ok("canonical public origin is https://blissops.com",
   `https://${PUBLIC_CANONICAL_HOST}` === "https://blissops.com");
ok("canonical app origin is https://app.blissops.com",
   `https://${APP_CANONICAL_HOST}` === "https://app.blissops.com");
ok("canonical admin origin is https://admin.blissops.com",
   `https://${ADMIN_CANONICAL_HOST}` === "https://admin.blissops.com");
ok("No preview host appears as canonical anywhere",
   ![PUBLIC_CANONICAL_HOST, APP_CANONICAL_HOST, ADMIN_CANONICAL_HOST]
     .some(h => h.includes("vercel") || h.includes("replit")));

// ─── Final summary ────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"═".repeat(64)}`);
console.log(`  Domain Architecture Validation — Phase Next`);
console.log(`  ${passed}/${total} assertions passed`);
if (failures.length > 0) {
  console.log(`\n  Failed assertions:`);
  failures.forEach(f => console.log(`    ✗ ${f}`));
}
console.log(`${"═".repeat(64)}\n`);

if (failed > 0) {
  process.exit(1);
}
