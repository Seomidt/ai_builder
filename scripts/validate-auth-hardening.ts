/**
 * scripts/validate-auth-hardening.ts
 *
 * Validates Auth + Session Hardening for single-domain production (blissops.com).
 *
 * Run: npx tsx scripts/validate-auth-hardening.ts
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

console.log("\nAuth + Session Hardening — Validation");
console.log("=".repeat(60));

// ─── 1. Supabase client — single instance, correct config ─────────────────────

console.log("\n─── 1. Supabase client configuration");
{
  const src = readSrc("client/src/lib/supabase.ts");
  assert(src.includes("createClient"), "Uses createClient() (standard browser client)");
  assert(src.includes("persistSession: true"), "persistSession: true");
  assert(src.includes("autoRefreshToken: true"), "autoRefreshToken: true");
  assert(src.includes("detectSessionInUrl: true"), "detectSessionInUrl: true");
  assert(src.includes("blissops_auth"), "storageKey: blissops_auth");
  assert(!src.includes("createServerClient"), "NO createServerClient() (SSR client — wrong for React SPA)");
  assert(!src.includes("createBrowserClient"), "Uses createClient not createBrowserClient (react SPA)");
  assert(src.includes("initSupabaseFromConfig"), "initSupabaseFromConfig() awaited before React renders");
  assert(src.includes("/api/auth/config"), "Config fetched from /api/auth/config");
  assert(src.includes("getSessionToken"), "getSessionToken() exported for Bearer token use");
}

// ─── 2. main.tsx — init before render ─────────────────────────────────────────

console.log("\n─── 2. main.tsx — Supabase init before React renders");
{
  const src = readSrc("client/src/main.tsx");
  assert(src.includes("await initSupabaseFromConfig()"), "await initSupabaseFromConfig() before createRoot");
  assert(src.includes("createRoot"), "createRoot renders after init");
}

// ─── 3. queryClient — Bearer token on all requests ────────────────────────────

console.log("\n─── 3. queryClient — Bearer token forwarding");
{
  const src = readSrc("client/src/lib/queryClient.ts");
  assert(src.includes("getSessionToken"), "getSessionToken imported");
  assert(src.includes("Bearer"), "Bearer token injected into request headers");
  assert(src.includes("Authorization"), "Authorization header set");
  assert(src.includes("credentials: \"include\""), "credentials: include on all requests");
}

// ─── 4. use-auth hook — race-condition-free session detection ─────────────────

console.log("\n─── 4. useAuth hook — onAuthStateChange-driven");
{
  const src = readSrc("client/src/hooks/use-auth.ts");
  assert(src.includes("onAuthStateChange"), "Uses onAuthStateChange (not polling)");
  assert(src.includes("supabaseReady"), "supabaseReady gate prevents early queries");
  assert(src.includes("enabled: supabaseReady"), "useQuery only runs after Supabase is ready");
  assert(src.includes("/api/auth/session"), "Validates session against backend");
  assert(src.includes("staleTime: 30_000"), "staleTime 30s (not Infinity — sessions can expire)");
  assert(src.includes("refetchOnWindowFocus: true"), "Refetches on window focus");
}

// ─── 5. ProtectedRoute — correct redirect logic ───────────────────────────────

console.log("\n─── 5. ProtectedRoute — auth guard");
{
  const src = readSrc("client/src/components/auth/ProtectedRoute.tsx");
  assert(src.includes("isLoading"), "Shows loading state while session resolves");
  assert(src.includes("/auth/login"), "Redirects to /auth/login when not authed");
  assert(src.includes("isLockdown"), "Handles 403 lockdown state");
  assert(src.includes("isAuthed"), "Only renders children when isAuthed === true");
}

// ─── 6. /auth/callback route exists ───────────────────────────────────────────

console.log("\n─── 6. /auth/callback page");
{
  const appSrc = readSrc("client/src/App.tsx");
  assert(appSrc.includes("/auth/callback"), "App.tsx has /auth/callback route");
  assert(appSrc.includes("AuthCallback"), "AuthCallback component imported and registered");

  const callbackSrc = readSrc("client/src/pages/auth/callback.tsx");
  assert(callbackSrc.includes("onAuthStateChange"), "Callback page uses onAuthStateChange");
  assert(callbackSrc.includes("SIGNED_IN"), "Handles SIGNED_IN event");
  assert(callbackSrc.includes("PASSWORD_RECOVERY"), "Handles PASSWORD_RECOVERY event");
  assert(callbackSrc.includes("setLocation"), "Redirects after session established");
  assert(callbackSrc.includes("data-testid"), "Has data-testid attributes");
}

// ─── 7. All auth routes public (no ProtectedRoute) ────────────────────────────

console.log("\n─── 7. Auth routes are public (no ProtectedRoute wrapper)");
{
  const appSrc = readSrc("client/src/App.tsx");
  const authRouteBlock = appSrc.match(/Public auth routes[\s\S]*?\/auth\/mfa-challenge/)?.[0] ?? "";
  assert(authRouteBlock.length > 0, "Auth route block found");
  assert(!authRouteBlock.includes("ProtectedRoute"), "Auth routes NOT wrapped in ProtectedRoute");
  assert(appSrc.includes("/auth/login"), "/auth/login route registered");
  assert(appSrc.includes("/auth/callback"), "/auth/callback route registered");
  assert(appSrc.includes("/auth/password-reset-confirm"), "/auth/password-reset-confirm registered");
  assert(appSrc.includes("/auth/invite-accept"), "/auth/invite-accept registered");
  assert(appSrc.includes("/auth/email-verify"), "/auth/email-verify registered");
}

// ─── 8. Backend — getUser() not JWT parsing ───────────────────────────────────

console.log("\n─── 8. Backend auth — getUser() via Supabase Admin");
{
  const authSrc = readSrc("server/middleware/auth.ts");
  assert(authSrc.includes("supabaseAdmin.auth.getUser"), "Backend uses supabaseAdmin.auth.getUser()");
  assert(!authSrc.includes("jwt.verify"), "Backend does NOT use manual jwt.verify()");
  assert(!authSrc.includes("jsonwebtoken"), "Backend does NOT import jsonwebtoken");
  assert(authSrc.includes("Bearer"), "Extracts Bearer token from Authorization header");
  assert(authSrc.includes("UNAUTHORIZED"), "Returns 401 UNAUTHORIZED when no valid token");
  assert(authSrc.includes("/api/auth/config"), "/api/auth/config is in PUBLIC_PATHS bypass");
}

// ─── 9. /api/auth/config — returns real Supabase credentials ─────────────────

console.log("\n─── 9. /api/auth/config endpoint");
{
  const src = readSrc("server/routes/auth-platform.ts");
  assert(src.includes("/api/auth/config"), "Route /api/auth/config registered");
  assert(src.includes("supabaseUrl"), "Returns supabaseUrl");
  assert(src.includes("supabaseAnonKey"), "Returns supabaseAnonKey");
  assert(src.includes("SUPABASE_URL"), "Reads SUPABASE_URL from env");
  assert(src.includes("SUPABASE_ANON_KEY"), "Reads SUPABASE_ANON_KEY from env");
}

// ─── 10. Domain config — single-domain (blissops.com) ────────────────────────

console.log("\n─── 10. Client domain config — single-domain");
{
  const { CANONICAL_HOSTS, DOMAIN_ROLE, ROOT_DOMAIN } = await import(
    "../client/src/lib/domain/config"
  );
  assert(ROOT_DOMAIN === "blissops.com", "ROOT_DOMAIN === blissops.com");
  assert(CANONICAL_HOSTS[DOMAIN_ROLE.PUBLIC] === "blissops.com", "PUBLIC host === blissops.com");
  assert(CANONICAL_HOSTS[DOMAIN_ROLE.APP] === "blissops.com", "APP host === blissops.com (single-domain)");
  assert(CANONICAL_HOSTS[DOMAIN_ROLE.AUTH] === "blissops.com", "AUTH host === blissops.com");
  assert(CANONICAL_HOSTS[DOMAIN_ROLE.ADMIN] === "blissops.com", "ADMIN host === blissops.com");
  assert(
    !Object.values(CANONICAL_HOSTS).includes("app.blissops.com"),
    "app.blissops.com NOT in any canonical host",
  );
}

// ─── 11. URL builders — auth URLs target blissops.com ────────────────────────

console.log("\n─── 11. URL builders — auth URLs target blissops.com");
{
  const { buildAuthUrl, buildOAuthCallbackUrl, buildMagicLinkReturnUrl, buildInviteUrl } =
    await import("../client/src/lib/domain/url-builders");

  const authUrl = buildAuthUrl("/login");
  assert(authUrl.includes("blissops.com"), `buildAuthUrl → ${authUrl}`);
  assert(!authUrl.includes("app.blissops.com"), "buildAuthUrl NOT app.blissops.com");

  const callbackUrl = buildOAuthCallbackUrl();
  assert(callbackUrl === "https://blissops.com/auth/callback", `buildOAuthCallbackUrl → ${callbackUrl}`);

  const magicLink = buildMagicLinkReturnUrl("/dashboard");
  assert(magicLink.startsWith("https://blissops.com"), `buildMagicLinkReturnUrl → ${magicLink}`);
  assert(magicLink.includes("/auth/callback"), "Magic link targets /auth/callback");

  const inviteUrl = buildInviteUrl("test-token");
  assert(inviteUrl.startsWith("https://blissops.com"), `buildInviteUrl → ${inviteUrl}`);
}

// ─── 12. Session scope — correct logout redirect ──────────────────────────────

console.log("\n─── 12. Session scope — logout redirect");
{
  const { STANDARD_LOGOUT, COOKIE_SCOPE, SESSION_COOKIE } = await import(
    "../client/src/lib/domain/session-scope"
  );
  assert(
    STANDARD_LOGOUT.redirectTo === "https://blissops.com/auth/login",
    `STANDARD_LOGOUT.redirectTo === https://blissops.com/auth/login (got: ${STANDARD_LOGOUT.redirectTo})`,
  );
  assert(STANDARD_LOGOUT.clearCsrf === true, "STANDARD_LOGOUT.clearCsrf === true");
  assert(COOKIE_SCOPE.APP_ONLY === "blissops.com", "COOKIE_SCOPE.APP_ONLY === blissops.com");
  assert(SESSION_COOKIE.SUPABASE_SESSION === "blissops_auth", "storageKey === blissops_auth");
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("Auth + Session Hardening — Validation Complete");
console.log("=".repeat(60));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error("\n❌ FAILING ASSERTIONS:");
  failures.forEach((f) => console.error(`  • ${f}`));
  console.error("\nAUTH HARDENING: INCOMPLETE ❌");
  process.exit(1);
} else {
  console.log("\n✅ ALL ASSERTIONS PASSED");
  console.log("AUTH HARDENING: COMPLETE ✅");
}
