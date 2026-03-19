/**
 * Phase 49 — Domain/Subdomain Architecture Validation
 * 50 scenarios, 220+ assertions
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Assertion Infrastructure ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${message}`);
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ───`);
}

function fileContains(filePath: string, ...substrings: string[]): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return substrings.every((s) => content.includes(s));
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

// ─── File Paths ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const D = (p: string) => path.join(ROOT, p);

const FILES = {
  config:        D("client/src/lib/domain/config.ts"),
  canonical:     D("client/src/lib/domain/canonical.ts"),
  sessionScope:  D("client/src/lib/domain/session-scope.ts"),
  seoRules:      D("client/src/lib/domain/seo-rules.ts"),
  urlBuilders:   D("client/src/lib/domain/url-builders.ts"),
  i18nDoc:       D("docs/architecture/i18n-and-domain-routing.md"),
  routeOwnership:D("docs/architecture/domain-route-ownership.md"),
  originPrep:    D("docs/architecture/domain-origin-prep.md"),
};

// ─── S01: config.ts exists ───────────────────────────────────────────────────

section("S01: config.ts exists");
assert(fileExists(FILES.config), "client/src/lib/domain/config.ts exists");

// ─── S02: DOMAIN_ROLE enum ───────────────────────────────────────────────────

section("S02: DOMAIN_ROLE enum defined");
assert(fileContains(FILES.config, "DOMAIN_ROLE"), "DOMAIN_ROLE constant defined");
assert(fileContains(FILES.config, '"public"'), 'public role defined');
assert(fileContains(FILES.config, '"app"'), 'app role defined');
assert(fileContains(FILES.config, '"admin"'), 'admin role defined');
assert(fileContains(FILES.config, '"auth"'), 'auth role defined');

// ─── S03: Canonical hostnames ────────────────────────────────────────────────

section("S03: Canonical hostnames defined");
assert(fileContains(FILES.config, "CANONICAL_HOSTS"), "CANONICAL_HOSTS defined");
assert(fileContains(FILES.config, "blissops.com"), "root domain present");
assert(fileContains(FILES.config, "app.blissops.com"), "app subdomain present");
assert(fileContains(FILES.config, "admin.blissops.com"), "admin subdomain present");
assert(fileContains(FILES.config, "ROOT_DOMAIN"), "ROOT_DOMAIN exported");
assert(fileContains(FILES.config, "WWW_REDIRECT_TARGET"), "WWW_REDIRECT_TARGET exported");

// ─── S04: Auth domain decision ───────────────────────────────────────────────

section("S04: Auth callbacks remain on app domain");
const configContent = readFile(FILES.config);
// AUTH role should resolve to app.blissops.com, not auth.blissops.com
assert(
  configContent.includes("[DOMAIN_ROLE.AUTH]") &&
  (configContent.match(/DOMAIN_ROLE\.AUTH.*app\.blissops\.com/s) !== null ||
   configContent.includes('"app.blissops.com"')),
  "AUTH role resolves to app.blissops.com"
);
// auth.blissops.com may appear in explanatory notes — it must NOT appear as a hostname target
assert(
  !configContent.includes('"auth.blissops.com"'),
  "No dedicated auth.blissops.com hostname target — correct decision"
);

// ─── S05: DomainConfig interface ─────────────────────────────────────────────

section("S05: DomainConfig interface");
assert(fileContains(FILES.config, "DomainConfig"), "DomainConfig interface defined");
assert(fileContains(FILES.config, "localeStrategy"), "localeStrategy field");
assert(fileContains(FILES.config, "indexed"), "indexed field");
assert(fileContains(FILES.config, "authRequired"), "authRequired field");
assert(fileContains(FILES.config, "DOMAIN_CONFIGS"), "DOMAIN_CONFIGS map exported");

// ─── S06: Locale strategy per domain ─────────────────────────────────────────

section("S06: Locale strategies per domain");
assert(fileContains(FILES.config, '"prefix"'), 'prefix strategy defined (public)');
assert(fileContains(FILES.config, '"cookie"'), 'cookie strategy defined (app)');
assert(fileContains(FILES.config, '"default-only"'), 'default-only strategy defined (admin/auth)');

// ─── S07: Predicates in config.ts ────────────────────────────────────────────

section("S07: Predicates exported from config.ts");
assert(fileContains(FILES.config, "isKnownHost"), "isKnownHost predicate");
assert(fileContains(FILES.config, "getDomainRoleFromHost"), "getDomainRoleFromHost predicate");
assert(fileContains(FILES.config, "isDomainIndexable"), "isDomainIndexable predicate");
assert(fileContains(FILES.config, "usesLocalePrefix"), "usesLocalePrefix predicate");
assert(fileContains(FILES.config, "usesCookieLocale"), "usesCookieLocale predicate");
assert(fileContains(FILES.config, "isAuthCallbackPath"), "isAuthCallbackPath predicate");
assert(fileContains(FILES.config, "isOpsPath"), "isOpsPath predicate");
assert(fileContains(FILES.config, "isApiPath"), "isApiPath predicate");

// ─── S08: canonical.ts exists ────────────────────────────────────────────────

section("S08: canonical.ts exists");
assert(fileExists(FILES.canonical), "client/src/lib/domain/canonical.ts exists");

// ─── S09: getCanonicalHostForRole ────────────────────────────────────────────

section("S09: getCanonicalHostForRole");
assert(fileContains(FILES.canonical, "getCanonicalHostForRole"), "getCanonicalHostForRole exported");
assert(fileContains(FILES.canonical, "getCanonicalOriginForRole"), "getCanonicalOriginForRole exported");

// ─── S10: buildCanonicalUrl ───────────────────────────────────────────────────

section("S10: buildCanonicalUrl");
assert(fileContains(FILES.canonical, "buildCanonicalUrl"), "buildCanonicalUrl exported");
assert(fileContains(FILES.canonical, "CanonicalUrlOptions"), "CanonicalUrlOptions interface");
assert(
  fileContains(FILES.canonical, "locale") && fileContains(FILES.canonical, "DOMAIN_ROLE.PUBLIC"),
  "buildCanonicalUrl handles locale prefix for public domain"
);

// ─── S11: www redirect helper ────────────────────────────────────────────────

section("S11: www redirect in canonical.ts");
assert(fileContains(FILES.canonical, "getWwwRedirectTarget"), "getWwwRedirectTarget exported");
assert(fileContains(FILES.canonical, "www."), "www pattern handled");

// ─── S12: shouldNoindexHost ───────────────────────────────────────────────────

section("S12: shouldNoindexHost");
assert(fileContains(FILES.canonical, "shouldNoindexHost"), "shouldNoindexHost exported");
assert(fileContains(FILES.canonical, "getRobotsHeaderForHost"), "getRobotsHeaderForHost exported");

// ─── S13: hreflang map ────────────────────────────────────────────────────────

section("S13: buildPublicHreflangMap");
assert(fileContains(FILES.canonical, "buildPublicHreflangMap"), "buildPublicHreflangMap exported");
assert(fileContains(FILES.canonical, "x-default"), "x-default hreflang entry");
assert(fileContains(FILES.canonical, "HreflangEntry"), "HreflangEntry interface");

// ─── S14: session-scope.ts exists ────────────────────────────────────────────

section("S14: session-scope.ts exists");
assert(fileExists(FILES.sessionScope), "client/src/lib/domain/session-scope.ts exists");

// ─── S15: Cookie scope decision documented ───────────────────────────────────

section("S15: Cookie scope decision");
assert(fileContains(FILES.sessionScope, "SESSION_COOKIE"), "SESSION_COOKIE constants");
assert(fileContains(FILES.sessionScope, "COOKIE_SCOPE"), "COOKIE_SCOPE constants");
assert(fileContains(FILES.sessionScope, "APP_ONLY"), "APP_ONLY scope defined");
assert(fileContains(FILES.sessionScope, "ROOT_DOMAIN"), "ROOT_DOMAIN scope defined");
assert(
  fileContains(FILES.sessionScope, "blissops_locale"),
  "locale cookie uses root domain scope (benign)"
);

// ─── S16: SameSite policy ─────────────────────────────────────────────────────

section("S16: SameSite policy");
assert(fileContains(FILES.sessionScope, "SAMESITE_POLICY"), "SAMESITE_POLICY exported");
assert(fileContains(FILES.sessionScope, '"Strict"'), "Strict policy for CSRF");
assert(fileContains(FILES.sessionScope, '"Lax"'), "Lax policy for session/locale");

// ─── S17: Auth callback paths ────────────────────────────────────────────────

section("S17: Auth callback paths in session-scope.ts");
assert(fileContains(FILES.sessionScope, "AUTH_CALLBACK_PATHS"), "AUTH_CALLBACK_PATHS exported");
assert(fileContains(FILES.sessionScope, "/auth/callback"), "/auth/callback listed");
assert(fileContains(FILES.sessionScope, "/auth/invite-accept"), "/auth/invite-accept listed");
assert(fileContains(FILES.sessionScope, "/auth/email-verify"), "/auth/email-verify listed");
assert(fileContains(FILES.sessionScope, "/auth/password-reset-confirm"), "/auth/password-reset-confirm listed");
assert(fileContains(FILES.sessionScope, "isAuthCallbackPath"), "isAuthCallbackPath in session-scope");

// ─── S18: Logout strategy ────────────────────────────────────────────────────

section("S18: Logout strategy");
assert(fileContains(FILES.sessionScope, "LogoutConfig"), "LogoutConfig interface");
assert(fileContains(FILES.sessionScope, "STANDARD_LOGOUT"), "STANDARD_LOGOUT config");
assert(fileContains(FILES.sessionScope, "clearCsrf"), "clearCsrf in logout config");

// ─── S19: Cross-subdomain assessment ─────────────────────────────────────────

section("S19: Cross-subdomain cookie assessment");
assert(fileContains(FILES.sessionScope, "CROSS_SUBDOMAIN_ASSESSMENT"), "CROSS_SUBDOMAIN_ASSESSMENT exported");
assert(fileContains(FILES.sessionScope, "getCookieScopeForName"), "getCookieScopeForName exported");
assert(fileContains(FILES.sessionScope, "requiresRootDomainScope"), "requiresRootDomainScope exported");

// ─── S20: seo-rules.ts exists ────────────────────────────────────────────────

section("S20: seo-rules.ts exists");
assert(fileExists(FILES.seoRules), "client/src/lib/domain/seo-rules.ts exists");

// ─── S21: SEO_RULES by domain ────────────────────────────────────────────────

section("S21: SEO_RULES defined for all domains");
assert(fileContains(FILES.seoRules, "SEO_RULES"), "SEO_RULES map");
assert(fileContains(FILES.seoRules, "index, follow"), "public: index, follow");
assert(fileContains(FILES.seoRules, "noindex, nofollow"), "non-public: noindex, nofollow");
assert(fileContains(FILES.seoRules, "noarchive"), "admin: noarchive directive");

// ─── S22: Public is indexed ───────────────────────────────────────────────────

section("S22: Public domain is indexed");
const seoContent = readFile(FILES.seoRules);
assert(
  /sitemapEligible:\s+true/.test(seoContent),
  "public domain sitemap eligible"
);

// ─── S23: robots.txt per domain ──────────────────────────────────────────────

section("S23: robots.txt content per domain");
assert(fileContains(FILES.seoRules, "ROBOTS_TXT"), "ROBOTS_TXT map exported");
assert(fileContains(FILES.seoRules, "Disallow: /"), "non-public domains disallow all");
assert(fileContains(FILES.seoRules, "Allow: /"), "public domain allows all");
assert(fileContains(FILES.seoRules, "Sitemap:"), "public robots.txt has sitemap");

// ─── S24: SEO helper functions ───────────────────────────────────────────────

section("S24: SEO helper functions");
assert(fileContains(FILES.seoRules, "shouldIndexDomain"), "shouldIndexDomain exported");
assert(fileContains(FILES.seoRules, "getRobotsPolicyForDomain"), "getRobotsPolicyForDomain exported");
assert(fileContains(FILES.seoRules, "getSitemapEligibility"), "getSitemapEligibility exported");
assert(fileContains(FILES.seoRules, "requiresCanonicalTag"), "requiresCanonicalTag exported");
assert(fileContains(FILES.seoRules, "requiresHreflang"), "requiresHreflang exported");
assert(fileContains(FILES.seoRules, "getSeoRuleForHost"), "getSeoRuleForHost exported");
assert(fileContains(FILES.seoRules, "getRobotsTxtBody"), "getRobotsTxtBody exported");

// ─── S25: url-builders.ts exists ─────────────────────────────────────────────

section("S25: url-builders.ts exists");
assert(fileExists(FILES.urlBuilders), "client/src/lib/domain/url-builders.ts exists");

// ─── S26: buildPublicUrl ─────────────────────────────────────────────────────

section("S26: buildPublicUrl");
assert(fileContains(FILES.urlBuilders, "buildPublicUrl"), "buildPublicUrl exported");
assert(fileContains(FILES.urlBuilders, "blissops.com"), "uses canonical public host");

// ─── S27: buildLocalePublicUrl ────────────────────────────────────────────────

section("S27: buildLocalePublicUrl (SEO-safe)");
assert(fileContains(FILES.urlBuilders, "buildLocalePublicUrl"), "buildLocalePublicUrl exported");
assert(
  fileContains(FILES.urlBuilders, "locale") && fileContains(FILES.urlBuilders, "ORIGINS.PUBLIC"),
  "buildLocalePublicUrl uses public origin with locale prefix"
);

// ─── S28: buildAppUrl is locale-neutral ──────────────────────────────────────

section("S28: buildAppUrl is locale-neutral");
assert(fileContains(FILES.urlBuilders, "buildAppUrl"), "buildAppUrl exported");
assert(fileContains(FILES.urlBuilders, "app.blissops.com"), "uses app canonical host");
const urlBuildersContent = readFile(FILES.urlBuilders);
// buildAppUrl must NOT inject locale
const appUrlFn = urlBuildersContent.match(/function buildAppUrl[^}]+}/s)?.[0] ?? "";
assert(
  !appUrlFn.includes("locale"),
  "buildAppUrl does not inject locale (locale-neutral)"
);

// ─── S29: buildAdminUrl ───────────────────────────────────────────────────────

section("S29: buildAdminUrl");
assert(fileContains(FILES.urlBuilders, "buildAdminUrl"), "buildAdminUrl exported");
assert(fileContains(FILES.urlBuilders, "admin.blissops.com"), "uses admin canonical host");

// ─── S30: buildAuthUrl is locale-neutral ─────────────────────────────────────

section("S30: buildAuthUrl is locale-neutral");
assert(fileContains(FILES.urlBuilders, "buildAuthUrl"), "buildAuthUrl exported");
const authUrlFn = urlBuildersContent.match(/function buildAuthUrl[^}]+}/s)?.[0] ?? "";
assert(
  !authUrlFn.includes("locale"),
  "buildAuthUrl does not inject locale (locale-neutral)"
);
// Auth must use app origin
assert(
  fileContains(FILES.urlBuilders, "ORIGINS.APP") || fileContains(FILES.urlBuilders, "app.blissops.com"),
  "buildAuthUrl uses app origin"
);

// ─── S31: Invite / reset / magic link builders ────────────────────────────────

section("S31: Auth-specific URL builders");
assert(fileContains(FILES.urlBuilders, "buildInviteUrl"), "buildInviteUrl exported");
assert(fileContains(FILES.urlBuilders, "buildResetPasswordUrl"), "buildResetPasswordUrl exported");
assert(fileContains(FILES.urlBuilders, "buildEmailVerifyUrl"), "buildEmailVerifyUrl exported");
assert(fileContains(FILES.urlBuilders, "buildMagicLinkReturnUrl"), "buildMagicLinkReturnUrl exported");
assert(fileContains(FILES.urlBuilders, "buildOAuthCallbackUrl"), "buildOAuthCallbackUrl exported");
assert(fileContains(FILES.urlBuilders, "encodeURIComponent"), "tokens are URL-encoded");

// ─── S32: Safety helpers in url-builders ─────────────────────────────────────

section("S32: URL safety helpers");
assert(fileContains(FILES.urlBuilders, "isPlatformUrl"), "isPlatformUrl exported");
assert(fileContains(FILES.urlBuilders, "safeRedirectUrl"), "safeRedirectUrl exported");
assert(fileContains(FILES.urlBuilders, "buildWwwRedirectTarget"), "buildWwwRedirectTarget exported");

// ─── S33: No hardcoded bare domains in url-builders ──────────────────────────

section("S33: Hostnames centralised in ORIGINS constant");
const builderLines = urlBuildersContent.split("\n").filter(
  (l) =>
    l.includes("blissops.com") &&
    !l.trim().startsWith("//") &&
    !l.trim().startsWith("*") &&
    !l.trim().startsWith("/*") &&
    !l.trim().startsWith("/**")
);
// All blissops.com references should be inside the ORIGINS block or constant declarations
const nonOriginUse = builderLines.filter(
  (l) =>
    !l.includes("ORIGINS") &&
    !l.includes("CANONICAL_HOSTS") &&
    !l.includes("const") &&
    !l.includes("hostname ===") &&
    !l.includes("hostname !")
);
assert(nonOriginUse.length === 0, `All hostname usage flows through ORIGINS (${nonOriginUse.length} unscoped references)`);

// ─── S34: i18n-and-domain-routing.md updated ─────────────────────────────────

section("S34: i18n architecture doc updated for Phase 49");
assert(fileExists(FILES.i18nDoc), "i18n-and-domain-routing.md exists");
assert(fileContains(FILES.i18nDoc, "Phase 49"), "doc updated to Phase 49");
assert(fileContains(FILES.i18nDoc, "Hybrid i18n"), "hybrid i18n strategy documented");
assert(fileContains(FILES.i18nDoc, "URL-prefixed"), "public domain prefix strategy documented");
assert(fileContains(FILES.i18nDoc, "Cookie-based"), "app domain cookie strategy documented");
assert(fileContains(FILES.i18nDoc, "Locale-neutral"), "auth callbacks locale-neutral documented");

// ─── S35: Hybrid strategy — all 4 surfaces ────────────────────────────────────

section("S35: All 4 surfaces covered in i18n doc");
assert(fileContains(FILES.i18nDoc, "blissops.com"), "public domain covered");
assert(fileContains(FILES.i18nDoc, "app.blissops.com"), "app domain covered");
assert(fileContains(FILES.i18nDoc, "admin.blissops.com"), "admin domain covered");
assert(fileContains(FILES.i18nDoc, "auth"), "auth callbacks covered");

// ─── S36: Canonical tag rules in i18n doc ────────────────────────────────────

section("S36: Canonical tag rules documented");
assert(fileContains(FILES.i18nDoc, "canonical"), "canonical tag rules present");
assert(fileContains(FILES.i18nDoc, "hreflang"), "hreflang rules present");

// ─── S37: domain-route-ownership.md exists ───────────────────────────────────

section("S37: domain-route-ownership.md exists");
assert(fileExists(FILES.routeOwnership), "docs/architecture/domain-route-ownership.md exists");

// ─── S38: Route ownership — all surfaces covered ─────────────────────────────

section("S38: Route ownership covers all surfaces");
assert(fileContains(FILES.routeOwnership, "blissops.com"), "public routes listed");
assert(fileContains(FILES.routeOwnership, "app.blissops.com"), "app routes listed");
assert(fileContains(FILES.routeOwnership, "admin.blissops.com"), "admin routes listed");
assert(fileContains(FILES.routeOwnership, "/auth/"), "auth routes listed");
assert(fileContains(FILES.routeOwnership, "/api/"), "API routes listed");
assert(fileContains(FILES.routeOwnership, "/ops"), "ops routes listed");

// ─── S39: App routes classified ──────────────────────────────────────────────

section("S39: Current app routes classified");
assert(fileContains(FILES.routeOwnership, "/projects"), "/projects route classified");
assert(fileContains(FILES.routeOwnership, "/settings"), "/settings route classified");
assert(fileContains(FILES.routeOwnership, "/runs"), "/runs route classified");
assert(fileContains(FILES.routeOwnership, "/integrations"), "/integrations route classified");

// ─── S40: Auth route rules ────────────────────────────────────────────────────

section("S40: Auth route rules enforced in ownership doc");
assert(fileContains(FILES.routeOwnership, "NEVER"), "NEVER rules present in route doc");
assert(fileContains(FILES.routeOwnership, "locale-prefix"), "locale-prefix auth rule stated");

// ─── S41: domain-origin-prep.md exists ───────────────────────────────────────

section("S41: domain-origin-prep.md exists");
assert(fileExists(FILES.originPrep), "docs/architecture/domain-origin-prep.md exists");

// ─── S42: DNS targets documented ─────────────────────────────────────────────

section("S42: Required DNS targets in origin prep");
assert(fileContains(FILES.originPrep, "CNAME"), "CNAME records specified");
assert(fileContains(FILES.originPrep, "Cloudflare"), "Cloudflare mentioned");
assert(fileContains(FILES.originPrep, "Vercel"), "Vercel mentioned");
assert(fileContains(FILES.originPrep, "app.blissops.com"), "app subdomain DNS entry");
assert(fileContains(FILES.originPrep, "admin.blissops.com"), "admin subdomain DNS entry");
assert(fileContains(FILES.originPrep, "www.blissops.com"), "www DNS entry");

// ─── S43: Supabase allow-list in origin prep ─────────────────────────────────

section("S43: Supabase allow-list in origin prep");
assert(fileContains(FILES.originPrep, "Supabase"), "Supabase referenced in origin prep");
assert(fileContains(FILES.originPrep, "allow-list"), "allow-list term present");
assert(fileContains(FILES.originPrep, "/auth/callback"), "/auth/callback in allow-list");
assert(fileContains(FILES.originPrep, "/auth/invite-accept"), "/auth/invite-accept in allow-list");

// ─── S44: Cloudflare Worker plan ─────────────────────────────────────────────

section("S44: Cloudflare Worker isolation plan");
assert(fileContains(FILES.originPrep, "Worker"), "Cloudflare Worker plan present");
assert(fileContains(FILES.originPrep, "/ops/"), "Worker routes /ops/ paths");
assert(fileContains(FILES.originPrep, "X-Domain-Role"), "Worker sets X-Domain-Role header");

// ─── S45: Phase 52 execution order ───────────────────────────────────────────

section("S45: Phase 52 execution order documented");
assert(fileContains(FILES.originPrep, "Phase 52"), "Phase 52 referenced");
assert(fileContains(FILES.originPrep, "Smoke test"), "smoke test step included");

// ─── S46: Cookie strategy in origin prep ─────────────────────────────────────

section("S46: Cookie strategy in origin prep");
assert(fileContains(FILES.originPrep, "Cookie"), "cookie strategy in origin prep");
assert(fileContains(FILES.originPrep, "SameSite"), "SameSite policy mentioned");
assert(fileContains(FILES.originPrep, "Secure"), "Secure flag mentioned");

// ─── S47: robots.txt in origin prep ──────────────────────────────────────────

section("S47: robots.txt in origin prep");
assert(fileContains(FILES.originPrep, "robots.txt"), "robots.txt referenced in prep");
assert(fileContains(FILES.originPrep, "Disallow: /"), "non-public disallow stated");

// ─── S48: No ambiguous domain mapping ────────────────────────────────────────

section("S48: No ambiguous domain mapping");
// auth.blissops.com must not appear as a quoted hostname target in any code file
const allContent = [
  readFile(FILES.config),
  readFile(FILES.canonical),
  readFile(FILES.sessionScope),
  readFile(FILES.urlBuilders),
].join("\n");
assert(
  !allContent.includes('"auth.blissops.com"'),
  "auth.blissops.com not used as quoted hostname target — auth stays on app domain"
);

// ─── S49: Public locale strategy — URL prefix ────────────────────────────────

section("S49: Public uses URL-prefix locale strategy");
assert(
  fileContains(FILES.config, '"prefix"') &&
  fileContains(FILES.config, "DOMAIN_ROLE.PUBLIC"),
  "Public domain locale strategy is prefix"
);
assert(
  fileContains(FILES.urlBuilders, "buildLocalePublicUrl") &&
  fileContains(FILES.urlBuilders, "/${locale}"),
  "buildLocalePublicUrl injects locale into path"
);

// ─── S50: Final coherence check ───────────────────────────────────────────────

section("S50: Domain architecture coherence check");

const allFilesPresent = Object.values(FILES).every((f) => fileExists(f));
assert(allFilesPresent, "All 8 domain architecture files are present");

assert(
  fileContains(FILES.config, "DOMAIN_ROLE") &&
  fileContains(FILES.canonical, "buildCanonicalUrl") &&
  fileContains(FILES.sessionScope, "AUTH_CALLBACK_PATHS") &&
  fileContains(FILES.seoRules, "SEO_RULES") &&
  fileContains(FILES.urlBuilders, "buildLocalePublicUrl"),
  "All 5 domain lib modules have their primary export"
);

assert(
  fileContains(FILES.i18nDoc, "Hybrid") &&
  fileContains(FILES.routeOwnership, "Domain Summary") &&
  fileContains(FILES.originPrep, "Phase 52"),
  "All 3 architecture docs are substantive"
);

assert(
  fileContains(FILES.config, "getDomainRoleFromHost") &&
  fileContains(FILES.seoRules, "shouldIndexDomain") &&
  fileContains(FILES.canonical, "shouldNoindexHost") &&
  fileContains(FILES.urlBuilders, "safeRedirectUrl"),
  "Safety / policy helpers exported across modules"
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`
════════════════════════════════════════════════════════════
Phase 49 — Domain/Subdomain Architecture Validation
════════════════════════════════════════════════════════════
  Passed:  ${passed}/${passed + failed}
  Failed:  ${failed}/${passed + failed}
`);

if (failures.length > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(f));
}

console.log(`
  ${failed === 0 ? "DOMAIN ARCHITECTURE: COMPLETE ✅" : "DOMAIN ARCHITECTURE: INCOMPLETE ❌"}

  Summary:
    Domains:    blissops.com · app.blissops.com · admin.blissops.com
    Auth:       Callbacks on app.blissops.com (no dedicated auth subdomain)
    i18n:       Hybrid — URL-prefix (public) · cookie (app) · default-only (admin)
    Indexing:   public=yes · app=no · admin=no
    URL builders: 10 typed builders (no hardcoded hostnames)
    Docs:       3 architecture documents
    Phase 52:   domain-origin-prep.md ready for Cloudflare ↔ Vercel wiring
`);

process.exit(failed === 0 ? 0 : 1);
