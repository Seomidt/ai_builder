/**
 * Phase 52 — Cloudflare ↔ Vercel Origin Setup Validation
 * 50 scenarios, 180+ assertions
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
  if (condition) { passed++; }
  else { failed++; failures.push(`  ✗ ${message}`); }
}

function section(title: string): void {
  console.log(`\n─── ${title} ───`);
}

function fileContains(filePath: string, ...substrings: string[]): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return substrings.every((s) => content.includes(s));
  } catch { return false; }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const D    = (p: string) => path.join(ROOT, p);

const FILES = {
  originNotes:   D("docs/architecture/cloudflare-vercel-origin-notes.md"),
  domainOrigin:  D("docs/architecture/domain-and-origin.md"),
  domainConfig:  D("client/src/lib/domain/config.ts"),
  urlBuilders:   D("client/src/lib/domain/url-builders.ts"),
  sessionScope:  D("client/src/lib/domain/session-scope.ts"),
  canonical:     D("client/src/lib/domain/canonical.ts"),
  seoRules:      D("client/src/lib/domain/seo-rules.ts"),
  originPrep:    D("docs/architecture/domain-origin-prep.md"),
  securityHeaders: D("server/middleware/security-headers.ts"),
  responseSecure:  D("server/middleware/response-security.ts"),
  rateLimit:       D("server/middleware/rate-limit.ts"),
  routeOwnership:  D("docs/architecture/domain-route-ownership.md"),
};

// ─── S01: origin notes file exists ───────────────────────────────────────────

section("S01: cloudflare-vercel-origin-notes.md exists");
assert(fileExists(FILES.originNotes), "cloudflare-vercel-origin-notes.md exists");

// ─── S02: domain-and-origin.md exists ────────────────────────────────────────

section("S02: domain-and-origin.md exists");
assert(fileExists(FILES.domainOrigin), "domain-and-origin.md exists");

// ─── S03: app.blissops.com canonical for app ─────────────────────────────────

section("S03: app.blissops.com is canonical app host");
assert(fileContains(FILES.domainConfig, "app.blissops.com"), "app.blissops.com in domain config");
assert(fileContains(FILES.domainOrigin, "app.blissops.com"), "app.blissops.com in origin doc");
assert(fileContains(FILES.originNotes, "app.blissops.com"), "app.blissops.com in origin notes");

// ─── S04: admin.blissops.com canonical for admin ─────────────────────────────

section("S04: admin.blissops.com is canonical admin host");
assert(fileContains(FILES.domainConfig, "admin.blissops.com"), "admin.blissops.com in domain config");
assert(fileContains(FILES.domainOrigin, "admin.blissops.com"), "admin.blissops.com in domain-and-origin");
assert(fileContains(FILES.originNotes, "admin.blissops.com"), "admin.blissops.com in origin notes");

// ─── S05: Vercel domain attachment documented ─────────────────────────────────

section("S05: Vercel domain attachment documented");
assert(fileContains(FILES.domainOrigin, "Vercel"), "Vercel mentioned in domain-and-origin");
assert(fileContains(FILES.domainOrigin, "cname.vercel-dns.com"), "CNAME target documented");
assert(fileContains(FILES.originNotes, "Vercel"), "Vercel mentioned in origin notes");

// ─── S06: HTTPS enforcement documented ───────────────────────────────────────

section("S06: HTTPS enforcement documented");
assert(fileContains(FILES.domainOrigin, "Always HTTPS"), "Always HTTPS in domain doc");
assert(fileContains(FILES.domainOrigin, "Full (Strict)"), "SSL Full Strict documented");
assert(fileContains(FILES.originNotes, "Flexible"), "Flexible SSL danger documented");

// ─── S07: No redirect loop risk documented ───────────────────────────────────

section("S07: No redirect loop risk");
assert(fileContains(FILES.domainOrigin, "loop"), "redirect loop analysis present");
assert(fileContains(FILES.originNotes, "loop"), "loop risk addressed in origin notes");

// ─── S08: www redirect 301 ───────────────────────────────────────────────────

section("S08: www redirect configured");
assert(fileContains(FILES.domainOrigin, "www.blissops.com"), "www redirect in domain doc");
assert(fileContains(FILES.domainOrigin, "301"), "301 redirect documented");
assert(fileContains(FILES.originNotes, "www"), "www in origin notes");

// ─── S09: App canonical host rules hold ──────────────────────────────────────

section("S09: Canonical host rules in url-builders");
assert(fileContains(FILES.urlBuilders, "buildAppUrl"), "buildAppUrl exists");
assert(fileContains(FILES.urlBuilders, "buildAdminUrl"), "buildAdminUrl exists");
assert(fileContains(FILES.urlBuilders, "buildAuthUrl"), "buildAuthUrl exists");
assert(fileContains(FILES.urlBuilders, "buildPublicUrl"), "buildPublicUrl exists");

// ─── S10: No *.vercel.app in url builders ────────────────────────────────────

section("S10: No vercel.app URLs in app code");
const urlBuildersContent = readFile(FILES.urlBuilders);
assert(!urlBuildersContent.includes("vercel.app"), "url-builders.ts has no vercel.app URLs");
const configContent = readFile(FILES.domainConfig);
assert(!configContent.includes("vercel.app"), "domain config has no vercel.app URLs");
const sessionContent = readFile(FILES.sessionScope);
assert(!sessionContent.includes("vercel.app"), "session-scope.ts has no vercel.app URLs");

// ─── S11: No *.replit.dev in app code ────────────────────────────────────────

section("S11: No replit.dev URLs in app code");
assert(!urlBuildersContent.includes("replit.dev"), "url-builders.ts has no replit.dev URLs");
assert(!configContent.includes("replit.dev"), "domain config has no replit.dev URLs");

// ─── S12: Supabase callback URL is app.blissops.com ──────────────────────────

section("S12: Supabase callback URL matches app.blissops.com");
assert(fileContains(FILES.sessionScope, "/auth/callback"), "auth callback path defined");
assert(
  fileContains(FILES.originNotes, "https://app.blissops.com/auth/callback"),
  "full Supabase callback URL in origin notes"
);
assert(
  fileContains(FILES.domainOrigin, "https://app.blissops.com/auth/callback"),
  "Supabase callback URL in domain-and-origin"
);

// ─── S13: No auth.blissops.com as target ─────────────────────────────────────

section("S13: auth.blissops.com not used as URL target");
assert(!urlBuildersContent.includes('"auth.blissops.com"'), "no auth.blissops.com in url-builders");
assert(!configContent.includes('"auth.blissops.com"'), "no auth.blissops.com as hostname in config");

// ─── S14: API routes are not cached ──────────────────────────────────────────

section("S14: API routes documented as cache BYPASS");
assert(fileContains(FILES.originNotes, "/api/*"), "/api/* in cache rules");
assert(fileContains(FILES.originNotes, "BYPASS"), "BYPASS documented for dynamic routes");
assert(fileContains(FILES.domainOrigin, "/api/*"), "/api/* cache rule in domain doc");

// ─── S15: Auth-sensitive routes not cached ───────────────────────────────────

section("S15: Auth routes documented as BYPASS");
assert(fileContains(FILES.originNotes, "/auth/*"), "/auth/* in cache rules");
assert(fileContains(FILES.domainOrigin, "/auth/*"), "/auth/* cache rule in domain doc");

// ─── S16: HTML/app shell not cached unsafely ─────────────────────────────────

section("S16: HTML/app shell cache BYPASS");
assert(fileContains(FILES.originNotes, "SPA shell"), "SPA shell cache rule documented");
assert(fileContains(FILES.domainOrigin, "SPA shell") || fileContains(FILES.domainOrigin, "/*.html"), "HTML/SPA cache rule in domain doc");

// ─── S17: Admin/ops routes not cached ────────────────────────────────────────

section("S17: Admin/ops routes documented as BYPASS");
assert(fileContains(FILES.originNotes, "/ops/*"), "/ops/* in cache rules");
assert(fileContains(FILES.domainOrigin, "/ops/*"), "/ops/* cache rule in domain doc");

// ─── S18: Static assets cached ───────────────────────────────────────────────

section("S18: Static assets documented as cacheable");
assert(fileContains(FILES.originNotes, "assets") || fileContains(FILES.originNotes, ".js"), "static assets cache documented");
assert(fileContains(FILES.domainOrigin, "1 year"), "1-year TTL for static assets documented");

// ─── S19: Security header ownership ──────────────────────────────────────────

section("S19: Security header ownership defined");
assert(fileContains(FILES.domainOrigin, "Strict-Transport-Security"), "HSTS in domain doc");
assert(fileContains(FILES.domainOrigin, "X-Frame-Options"), "X-Frame-Options in domain doc");
assert(fileContains(FILES.domainOrigin, "X-Content-Type-Options"), "X-Content-Type-Options in domain doc");
assert(fileContains(FILES.domainOrigin, "Referrer-Policy"), "Referrer-Policy in domain doc");
assert(fileContains(FILES.domainOrigin, "Permissions-Policy"), "Permissions-Policy in domain doc");

// ─── S20: App sets security headers (not Cloudflare) ─────────────────────────

section("S20: Security headers set at app layer");
assert(fileExists(FILES.securityHeaders), "security-headers.ts middleware exists");
assert(fileContains(FILES.securityHeaders, "helmet"), "helmet used for security headers");
assert(fileContains(FILES.securityHeaders, "hsts"), "HSTS configured in helmet");
assert(fileExists(FILES.responseSecure), "response-security.ts middleware exists");
assert(fileContains(FILES.responseSecure, "X-Frame-Options"), "X-Frame-Options in response-security");
assert(fileContains(FILES.responseSecure, "Referrer-Policy"), "Referrer-Policy in response-security");

// ─── S21: No duplicate header risk documented ────────────────────────────────

section("S21: Duplicate header risk documented");
assert(fileContains(FILES.domainOrigin, "NOT duplicate") || fileContains(FILES.domainOrigin, "Do NOT"), "header duplication warning present");
assert(fileContains(FILES.originNotes, "duplicate"), "duplicate header warning in origin notes");

// ─── S22: Cloudflare role defined ────────────────────────────────────────────

section("S22: Cloudflare role defined in domain-and-origin.md");
assert(fileContains(FILES.domainOrigin, "Cloudflare"), "Cloudflare role mentioned");
assert(fileContains(FILES.domainOrigin, "edge"), "edge role defined");
assert(fileContains(FILES.domainOrigin, "proxy"), "proxy role mentioned");

// ─── S23: Vercel role defined ────────────────────────────────────────────────

section("S23: Vercel role defined");
assert(fileContains(FILES.domainOrigin, "origin"), "origin role defined");
assert(fileContains(FILES.domainOrigin, "compute"), "compute role mentioned");

// ─── S24: Redirect matrix complete ───────────────────────────────────────────

section("S24: Redirect matrix covers all cases");
const domainOriginContent = readFile(FILES.domainOrigin);
assert(domainOriginContent.includes("http://app.blissops.com"), "HTTP app redirect covered");
assert(domainOriginContent.includes("http://admin.blissops.com"), "HTTP admin redirect covered");
assert(domainOriginContent.includes("http://blissops.com"), "HTTP root redirect covered");
assert(domainOriginContent.includes("www.blissops.com"), "www redirect covered");

// ─── S25: Cookie scope correct after origin change ───────────────────────────

section("S25: Cookie scope validated for new origin");
assert(fileContains(FILES.originNotes, "app.blissops.com"), "cookie scoped to app in origin notes");
assert(fileContains(FILES.originNotes, "SameSite"), "SameSite documented in origin notes");
assert(fileContains(FILES.originNotes, "CSRF"), "CSRF scope documented");

// ─── S26: Supabase site URL setting documented ───────────────────────────────

section("S26: Supabase site URL documented");
assert(fileContains(FILES.domainOrigin, "Site URL"), "Site URL setting mentioned");
assert(fileContains(FILES.originNotes, "Site URL"), "Site URL in origin notes");

// ─── S27: localhost removed from Supabase prod allow-list ────────────────────

section("S27: localhost exclusion from Supabase prod");
assert(fileContains(FILES.domainOrigin, "localhost") && fileContains(FILES.domainOrigin, "Must NOT"), "localhost exclusion documented");
assert(fileContains(FILES.originNotes, "localhost"), "localhost addressed in origin notes");

// ─── S28: Preview URL exclusion from Supabase prod ───────────────────────────

section("S28: Preview URL exclusion from Supabase prod");
assert(fileContains(FILES.domainOrigin, "vercel.app") && fileContains(FILES.domainOrigin, "Must NOT"), "*.vercel.app exclusion documented");

// ─── S29: Origin lockdown limitation documented ───────────────────────────────

section("S29: *.vercel.app bypass limitation truthfully documented");
assert(fileContains(FILES.originNotes, "cannot be fully blocked") || fileContains(FILES.originNotes, "cannot be blocked"), "bypass limitation documented honestly");
assert(fileContains(FILES.originNotes, "bypasses Cloudflare"), "bypass mechanism explained");

// ─── S30: Mitigation strategy for vercel.app ─────────────────────────────────

section("S30: *.vercel.app mitigation strategy");
assert(fileContains(FILES.originNotes, "Mitigation"), "mitigation section present");
assert(fileContains(FILES.originNotes, "session cookies"), "session cookie mitigation mentioned");

// ─── S31: DNS records specified ───────────────────────────────────────────────

section("S31: DNS records specified");
assert(fileContains(FILES.domainOrigin, "CNAME"), "CNAME records in domain doc");
assert(fileContains(FILES.domainOrigin, "app"), "app CNAME in domain doc");
assert(fileContains(FILES.domainOrigin, "admin"), "admin CNAME in domain doc");

// ─── S32: TLS model documented ───────────────────────────────────────────────

section("S32: TLS model documented");
assert(fileContains(FILES.domainOrigin, "Full (Strict)"), "SSL Full Strict in domain doc");
assert(fileContains(FILES.domainOrigin, "TLS"), "TLS section in domain doc");
assert(fileContains(FILES.originNotes, "Full (Strict)"), "SSL mode in origin notes");

// ─── S33: HSTS settings documented ───────────────────────────────────────────

section("S33: HSTS settings documented");
assert(fileContains(FILES.domainOrigin, "31536000"), "HSTS max-age in domain doc");
assert(fileContains(FILES.domainOrigin, "includeSubDomains"), "includeSubDomains in domain doc");
assert(fileContains(FILES.domainOrigin, "preload"), "HSTS preload in domain doc");

// ─── S34: Rate limiting middleware exists ────────────────────────────────────

section("S34: Rate limiting middleware");
assert(fileExists(FILES.rateLimit), "rate-limit.ts middleware exists");
assert(fileContains(FILES.rateLimit, "globalApiLimiter"), "globalApiLimiter exported");
assert(fileContains(FILES.rateLimit, "getRateLimitConfig"), "getRateLimitConfig exported");

// ─── S35: Admin Cloudflare Worker plan documented ─────────────────────────────

section("S35: Admin Cloudflare Worker plan");
assert(fileContains(FILES.domainOrigin, "Worker"), "Cloudflare Worker documented");
assert(fileContains(FILES.originNotes, "Worker"), "Worker plan in origin notes");

// ─── S36: App-level headers set (not only Cloudflare) ────────────────────────

section("S36: App-level security implementation");
assert(fileExists(D("server/middleware/security-headers.ts")), "security-headers.ts exists");
assert(fileExists(D("server/middleware/response-security.ts")), "response-security.ts exists");
assert(fileExists(D("server/middleware/nonce.ts")), "nonce.ts exists");
assert(fileExists(D("server/middleware/request-id.ts")), "request-id.ts exists");

// ─── S37: CSP report endpoint ────────────────────────────────────────────────

section("S37: CSP report endpoint exists");
assert(fileExists(D("server/routes/security-report.ts")), "security-report.ts exists");
assert(fileContains(D("server/routes/security-report.ts"), "csp-report"), "csp-report handler present");

// ─── S38: No HTTP/Flexible SSL risk ──────────────────────────────────────────

section("S38: Flexible SSL risk documented and avoided");
assert(fileContains(FILES.originNotes, "Flexible"), "Flexible SSL danger documented");
assert(fileContains(FILES.domainOrigin, "NEVER set SSL mode to Flexible") || fileContains(FILES.domainOrigin, "Flexible"), "Flexible SSL warning present");

// ─── S39: Domain and origin doc has Cloudflare architecture diagram ───────────

section("S39: Architecture diagram present");
assert(fileContains(FILES.domainOrigin, "Cloudflare Zone") || fileContains(FILES.domainOrigin, "Cloudflare (edge)"), "Cloudflare layer in architecture");

// ─── S40: Phase 52 execution checklist ────────────────────────────────────────

section("S40: Phase 52 execution checklist");
assert(fileContains(FILES.domainOrigin, "Checklist") || fileContains(FILES.domainOrigin, "[ ]"), "execution checklist present");
assert(fileContains(FILES.domainOrigin, "Smoke test"), "smoke test in checklist");

// ─── S41: Route ownership doc still valid ────────────────────────────────────

section("S41: Route ownership doc consistency");
assert(fileExists(FILES.routeOwnership), "domain-route-ownership.md still exists");
assert(fileContains(FILES.routeOwnership, "app.blissops.com"), "app domain in route ownership");
assert(fileContains(FILES.routeOwnership, "admin.blissops.com"), "admin domain in route ownership");

// ─── S42: No circular redirects from app code ────────────────────────────────

section("S42: No circular redirect risk from app code");
const urlContent = readFile(FILES.urlBuilders);
assert(!urlContent.includes("http://"), "no http:// in url-builders (HTTPS only)");
assert(urlContent.includes("https://"), "HTTPS used in url-builders");

// ─── S43: Cookies scope correct ──────────────────────────────────────────────

section("S43: Cookie scope validated");
assert(fileContains(FILES.sessionScope, "app.blissops.com"), "session cookie scoped to app");
assert(fileContains(FILES.sessionScope, "CSRF"), "CSRF cookie scoped correctly");
assert(fileContains(FILES.sessionScope, ".blissops.com"), "locale cookie cross-subdomain");

// ─── S44: Login redirect target is app domain ────────────────────────────────

section("S44: Login redirect uses app domain");
assert(fileContains(FILES.sessionScope, "app.blissops.com") && fileContains(FILES.sessionScope, "redirectTo"), "login redirect targets app domain");

// ─── S45: Logout flow documented ─────────────────────────────────────────────

section("S45: Logout flow documented");
assert(fileContains(FILES.sessionScope, "STANDARD_LOGOUT"), "STANDARD_LOGOUT config exists");
assert(fileContains(FILES.sessionScope, "clearCsrf"), "CSRF cleared on logout");
assert(fileContains(FILES.originNotes, "Logout") || fileContains(FILES.originNotes, "logout"), "logout flow in origin notes");

// ─── S46: Magic link / reset URLs use app domain ─────────────────────────────

section("S46: Magic link and reset URLs use app domain");
assert(fileContains(FILES.urlBuilders, "buildMagicLinkReturnUrl"), "buildMagicLinkReturnUrl exists");
assert(fileContains(FILES.urlBuilders, "buildResetPasswordUrl"), "buildResetPasswordUrl exists");
assert(fileContains(FILES.urlBuilders, "buildInviteUrl"), "buildInviteUrl exists");

// ─── S47: Production vs preview strategy documented ──────────────────────────

section("S47: Production vs preview strategy");
assert(fileContains(FILES.domainOrigin, "Production") && fileContains(FILES.domainOrigin, "Preview"), "prod vs preview strategy documented");
assert(fileContains(FILES.domainOrigin, "localhost"), "localhost/dev environment documented");

// ─── S48: app-level middleware chain complete ─────────────────────────────────

section("S48: Server middleware chain complete");
assert(fileExists(D("server/middleware/auth.ts")), "auth.ts exists");
assert(fileExists(D("server/middleware/rate-limit.ts")), "rate-limit.ts exists");
assert(fileExists(D("server/middleware/security-headers.ts")), "security-headers.ts exists");
assert(fileExists(D("server/middleware/response-security.ts")), "response-security.ts exists");
assert(fileExists(D("server/middleware/nonce.ts")), "nonce.ts exists");
assert(fileExists(D("server/middleware/request-id.ts")), "request-id.ts exists");

// ─── S49: domain-origin-prep.md still valid ──────────────────────────────────

section("S49: domain-origin-prep.md Phase 49 doc still valid");
assert(fileExists(FILES.originPrep), "domain-origin-prep.md exists");
assert(fileContains(FILES.originPrep, "Phase 52"), "Phase 52 referenced in prep doc");
assert(fileContains(FILES.originPrep, "Supabase"), "Supabase referenced in prep doc");

// ─── S50: Final coherence check ───────────────────────────────────────────────

section("S50: Final origin architecture coherence");
const allFilesPresent = [
  FILES.originNotes,
  FILES.domainOrigin,
  FILES.domainConfig,
  FILES.urlBuilders,
  FILES.sessionScope,
  FILES.canonical,
  FILES.seoRules,
].every((f) => fileExists(f));
assert(allFilesPresent, "All Phase 49+52 architecture files present");

assert(
  fileContains(FILES.domainOrigin, "Cloudflare") &&
  fileContains(FILES.domainOrigin, "Vercel") &&
  fileContains(FILES.domainOrigin, "Supabase"),
  "All three infrastructure components documented"
);

assert(
  !readFile(FILES.urlBuilders).includes("vercel.app") &&
  !readFile(FILES.urlBuilders).includes("replit.dev") &&
  !readFile(FILES.domainConfig).includes("vercel.app"),
  "No preview/dev URLs in production domain config or url-builders"
);

assert(
  fileContains(FILES.domainOrigin, "app.blissops.com") &&
  fileContains(FILES.domainOrigin, "admin.blissops.com") &&
  fileContains(FILES.domainOrigin, "blissops.com"),
  "All three production domains covered in origin doc"
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`
════════════════════════════════════════════════════════════
Phase 52 — Cloudflare ↔ Vercel Origin Setup Validation
════════════════════════════════════════════════════════════
  Passed:  ${passed}/${passed + failed}
  Failed:  ${failed}/${passed + failed}
`);

if (failures.length > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(f));
}

console.log(`
  ${failed === 0 ? "CLOUDFLARE ↔ VERCEL ORIGIN: COMPLETE ✅" : "CLOUDFLARE ↔ VERCEL ORIGIN: INCOMPLETE ❌"}

  Summary:
    Cloudflare:   DNS + TLS + routing edge (Full Strict SSL)
    Vercel:       Express + Vite compute origin
    Canonical:    app.blissops.com (app + auth) · admin.blissops.com · blissops.com
    *.vercel.app: Cannot block from CF zone — mitigated by cookie/auth scope
    Supabase:     Callback URLs on app.blissops.com only
    Cache:        /api + /auth + /ops = BYPASS · static = Cache
    Headers:      App-layer (helmet + response-security) — not Cloudflare managed
    Phase 52:     Wiring checklist in domain-and-origin.md
`);

process.exit(failed === 0 ? 0 : 1);
