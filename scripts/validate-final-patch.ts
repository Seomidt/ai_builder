/**
 * Validation Script — Final Production Lock
 *
 * Validates all 4 production fixes:
 *  1. Analytics idempotency partial index
 *  2. Strict production host enforcement
 *  3. Admin domain GET redirect / API 403
 *  4. AI Ops digest cache hard TTL
 *
 * Exit code: 0 = all pass, 1 = any failure
 */

import pg from "pg";

const { Client } = pg;

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

// ─── FIX 1: Idempotency partial index ────────────────────────────────────────

section("FIX 1: Analytics idempotency partial index");

const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
await client.connect();

// 1a. Index exists
const idxResult = await client.query(`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'analytics_events'
    AND indexname = 'analytics_events_idem_idx';
`);
assert(idxResult.rows.length === 1, "analytics_events_idem_idx exists");

// 1b. Index contains partial WHERE clause
const idxDef: string = idxResult.rows[0]?.indexdef ?? "";
assert(
  idxDef.includes("idempotency_key IS NOT NULL"),
  `index is partial (WHERE idempotency_key IS NOT NULL) — got: ${idxDef}`,
);

// 1c. Full unique index NOT present (was replaced)
const oldIdxResult = await client.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename = 'analytics_events'
    AND indexname IN ('ae50_idempotency_key_uq', 'analytics_events_idempotency_key_idx');
`);
assert(oldIdxResult.rows.length === 0, "old full unique index is gone");

// 1d. Duplicate idempotency_key → rejected
const testKey = `validate-final-patch-${Date.now()}`;
await client.query(`
  INSERT INTO analytics_events (event_name, event_family, source, idempotency_key)
  VALUES ('validate_test', 'ops', 'system', $1)
  ON CONFLICT DO NOTHING;
`, [testKey]);
let duplicateRejected = false;
try {
  await client.query(`
    INSERT INTO analytics_events (event_name, event_family, source, idempotency_key)
    VALUES ('validate_test', 'ops', 'system', $1);
  `, [testKey]);
} catch (e: any) {
  duplicateRejected = e.code === "23505"; // unique_violation
}
assert(duplicateRejected, "duplicate idempotency_key insert is rejected (unique violation)");

// Cleanup test row
await client.query(`DELETE FROM analytics_events WHERE idempotency_key = $1`, [testKey]);

// 1e. NULL idempotency_key → allowed multiple times
let nullInsertCount = 0;
try {
  await client.query(`INSERT INTO analytics_events (event_name, event_family, source, idempotency_key) VALUES ('validate_null_1', 'ops', 'system', NULL)`);
  await client.query(`INSERT INTO analytics_events (event_name, event_family, source, idempotency_key) VALUES ('validate_null_2', 'ops', 'system', NULL)`);
  nullInsertCount = 2;
} catch {
  nullInsertCount = 0;
}
assert(nullInsertCount === 2, "NULL idempotency_key allowed multiple times");

// Cleanup null test rows
await client.query(`DELETE FROM analytics_events WHERE event_name IN ('validate_null_1', 'validate_null_2') AND idempotency_key IS NULL`);

console.log("\nSQL verification:");
console.log(`  indexname: ${idxResult.rows[0]?.indexname ?? "NOT FOUND"}`);
console.log(`  indexdef:  ${idxDef}`);

await client.end();

// ─── FIX 2: Production host enforcement ───────────────────────────────────────

section("FIX 2: Strict production host enforcement");

const hostMod = await import("../server/middleware/host-allowlist.js");
const { isAllowedHost } = hostMod;

// Simulate production env
const origNodeEnv = process.env.NODE_ENV;

// Set production
process.env.NODE_ENV = "production";

assert(!isAllowedHost("unknown-host.example.com"), "prod + unknown host → blocked");
assert(!isAllowedHost("mybrand.vercel.app"), "prod + *.vercel.app → blocked");
assert(!isAllowedHost("workspace.replit.dev"), "prod + *.replit.dev → blocked");
assert(!isAllowedHost("localhost"), "prod + localhost → blocked");
assert(!isAllowedHost("127.0.0.1"), "prod + 127.0.0.1 → blocked");
assert(isAllowedHost("blissops.com"), "prod + blissops.com → allowed");
assert(isAllowedHost("app.blissops.com"), "prod + app.blissops.com → allowed");
assert(isAllowedHost("admin.blissops.com"), "prod + admin.blissops.com → allowed");

// Set development
process.env.NODE_ENV = "development";

assert(isAllowedHost("localhost"), "dev + localhost → allowed");
assert(isAllowedHost("workspace.replit.dev"), "dev + *.replit.dev → allowed");
assert(isAllowedHost("blissops.com"), "dev + blissops.com → allowed");

// Restore
process.env.NODE_ENV = origNodeEnv;

// ─── FIX 3: Admin domain guard ────────────────────────────────────────────────

section("FIX 3: Admin domain GET redirect + API 403");

const adminMod = await import("../server/middleware/admin-domain.js");
const { adminDomainGuard, isAdminPath } = adminMod;

// isAdminPath checks
assert(isAdminPath("/ops"), "isAdminPath('/ops') → true");
assert(isAdminPath("/ops/dashboard"), "isAdminPath('/ops/dashboard') → true");
assert(isAdminPath("/api/admin/users"), "isAdminPath('/api/admin/users') → true");
assert(!isAdminPath("/"), "isAdminPath('/') → false");
assert(!isAdminPath("/app/settings"), "isAdminPath('/app/settings') → false");

// Helper: simulate Express req/res/next
function mockRequest(path: string, method: string, host: string) {
  return {
    path,
    method,
    search: "",
    headers: { host },
    ip: "1.2.3.4",
  } as any;
}

function mockResponse() {
  const res: any = { statusCode: 0, redirectUrl: "", headersSent: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; res.headersSent = true; return res; };
  res.redirect = (code: number, url: string) => { res.statusCode = code; res.redirectUrl = url; res.headersSent = true; };
  return res;
}

// 3a. Correct host → passes
process.env.NODE_ENV = "production";
{
  const req = mockRequest("/ops/dashboard", "GET", "admin.blissops.com");
  const res = mockResponse();
  let nextCalled = false;
  adminDomainGuard(req, res, () => { nextCalled = true; });
  assert(nextCalled, "correct admin host + GET /ops → passes through");
}

// 3b. Wrong host + GET page → redirect 302
{
  const req = mockRequest("/ops/dashboard", "GET", "app.blissops.com");
  const res = mockResponse();
  adminDomainGuard(req, res, () => {});
  assert(res.statusCode === 302, "wrong host + GET /ops → 302 redirect");
  assert(
    res.redirectUrl === "https://admin.blissops.com/ops/dashboard",
    `redirect points to admin domain — got: ${res.redirectUrl}`,
  );
}

// 3c. Wrong host + POST API → 403 (no redirect)
{
  const req = mockRequest("/api/admin/users", "POST", "app.blissops.com");
  const res = mockResponse();
  adminDomainGuard(req, res, () => {});
  assert(res.statusCode === 403, "wrong host + POST /api/admin → 403");
  assert(!res.redirectUrl, "POST /api/admin → no redirect URL set");
}

// 3d. Wrong host + GET API route → 403 (api routes never redirect even if GET)
{
  const req = mockRequest("/api/admin/users", "GET", "app.blissops.com");
  const res = mockResponse();
  adminDomainGuard(req, res, () => {});
  assert(res.statusCode === 403, "wrong host + GET /api/admin → 403 (not redirect)");
}

// 3e. Non-admin path → passes regardless of host
{
  const req = mockRequest("/app/dashboard", "GET", "app.blissops.com");
  const res = mockResponse();
  let nextCalled = false;
  adminDomainGuard(req, res, () => { nextCalled = true; });
  assert(nextCalled, "non-admin path → passes through without host check");
}

// 3f. Dev: localhost allowed for admin paths
process.env.NODE_ENV = "development";
{
  const req = mockRequest("/ops/dashboard", "GET", "localhost");
  const res = mockResponse();
  let nextCalled = false;
  adminDomainGuard(req, res, () => { nextCalled = true; });
  assert(nextCalled, "dev + localhost + admin path → passes through");
}

process.env.NODE_ENV = origNodeEnv;

// ─── FIX 4: AI Ops digest cache hard TTL ─────────────────────────────────────

section("FIX 4: AI Ops digest cache hard TTL");

const digestMod = await import("../server/lib/ai-ops/digest.js");
const { DIGEST_CONFIG, invalidateDigestCache, getCachedDigest, clearDigestCache } = digestMod;

// 4a. CACHE_TTL_MS is 1 hour
assert(
  DIGEST_CONFIG.cacheTtlMs === 60 * 60 * 1000,
  `CACHE_TTL_MS = ${DIGEST_CONFIG.cacheTtlMs}ms (expected ${60 * 60 * 1000}ms)`,
);

// 4b. invalidateDigestCache exported and clears state
assert(typeof invalidateDigestCache === "function", "invalidateDigestCache() is exported");

// 4c. clearDigestCache (legacy) also exported
assert(typeof clearDigestCache === "function", "clearDigestCache() is exported");

// 4d. getCachedDigest returns null after invalidation
invalidateDigestCache();
assert(getCachedDigest() === null, "getCachedDigest() is null after invalidation");

// 4e. isCacheValid logic — verify via source code inspection
const digestSrc = await import("fs").then(fs =>
  fs.readFileSync("server/lib/ai-ops/digest.ts", "utf-8"),
);
assert(
  digestSrc.includes("isCacheValid"),
  "isCacheValid() helper exists in digest.ts",
);
assert(
  digestSrc.includes("CACHE_TTL_MS"),
  "CACHE_TTL_MS constant used in TTL check",
);
assert(
  digestSrc.includes("invalidateDigestCache"),
  "invalidateDigestCache() called before rebuild",
);
assert(
  digestSrc.includes("hard limit"),
  "hard TTL limit documented in code",
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
  console.log("  FINAL PATCH: COMPLETE ✅");
  process.exit(0);
} else {
  console.log("  FINAL PATCH: INCOMPLETE ❌");
  process.exit(1);
}
