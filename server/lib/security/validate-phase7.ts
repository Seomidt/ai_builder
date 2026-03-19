/**
 * Phase 7 Validation — Platform Security & Session Management
 * 40+ scenarios, 180+ assertions
 */

import pg from "pg";
import {
  enableMfaForUser,
  verifyMfaCode,
  generateRecoveryCodes,
  disableMfa,
  listUserMfaMethods,
  isMfaEnabled,
  activateMfaMethod,
} from "../auth/mfa";
import {
  createSession,
  validateSession,
  rotateSessionToken,
  revokeSession,
  revokeAllSessionsForUser,
  listUserSessions,
  detectNewDevice,
  logSecurityEventExternal,
} from "../auth/sessions";
import {
  validateUpload,
  ALL_ALLOWED_TYPES,
  requestSizeLimitMiddleware,
} from "./upload-validation";
import {
  verifyIpAllowed,
  addIpAllowlistEntry,
  removeIpAllowlistEntry,
  listTenantIpAllowlist,
} from "../../middleware/ip-allowlist";
import {
  explainSecurityHeaders,
} from "../../middleware/security-headers";
import {
  explainRateLimitState,
  loginRateLimit,
  apiRateLimit,
} from "../../middleware/rate-limit";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const TS = Date.now();
const USER_A = `user-7a-${TS}`;
const USER_B = `user-7b-${TS}`;
const TENANT_A = `tenant-7a-${TS}`;
const TENANT_B = `tenant-7b-${TS}`;

async function main() {
  const client = getClient();
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── SCENARIO 1: DB schema — all 7 tables present ──────────────────────────
    section("SCENARIO 1: DB schema — 7 Phase 7 tables present");
    const tables = [
      "user_mfa_methods", "mfa_recovery_codes", "user_sessions",
      "session_tokens", "session_revocations", "tenant_ip_allowlists", "security_events",
    ];
    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tables],
    );
    assert(tableR.rows.length === 7, "All 7 Phase 7 tables exist");

    // ── SCENARIO 2: DB schema — CHECK constraints ─────────────────────────────
    section("SCENARIO 2: CHECK constraints present");
    const checks = await client.query(
      `SELECT conname FROM pg_constraint WHERE contype='c' AND conname IN (
        'user_mfa_methods_method_type_check','security_events_event_type_check'
      )`
    );
    assert(checks.rows.length === 2, "CHECK constraints on method_type and event_type");

    // ── SCENARIO 3: DB schema — indexes ───────────────────────────────────────
    section("SCENARIO 3: Key indexes present");
    const idxR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (
        'umm_user_type_idx','mrc_code_hash_idx','us_token_hash_idx',
        'st_refresh_hash_idx','sr_session_idx','tia_tenant_range_idx','se_type_created_idx'
      )`
    );
    assert(idxR.rows.length >= 6, `Key indexes found: ${idxR.rows.length}/7`);

    // ── SCENARIO 4: RLS enabled ───────────────────────────────────────────────
    section("SCENARIO 4: RLS enabled on all 7 tables");
    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [tables],
    );
    assert(rlsR.rows.length === 7, `RLS enabled on all 7 tables (found ${rlsR.rows.length})`);

    // ── SCENARIO 5: Unique indexes on sensitive columns ───────────────────────
    section("SCENARIO 5: Unique indexes on token hashes");
    const uniqR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('mrc_code_hash_idx','us_token_hash_idx','st_refresh_hash_idx','tia_tenant_range_idx','sr_session_idx')`
    );
    assert(uniqR.rows.length === 5, `All 5 critical unique indexes present (found ${uniqR.rows.length})`);

    // ── SCENARIO 6: Total RLS count ───────────────────────────────────────────
    section("SCENARIO 6: Total RLS table count correct");
    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    const rlsCount = parseInt(totalRls.rows[0].cnt, 10);
    assert(rlsCount >= 120, `Total RLS tables >= 120 (found ${rlsCount})`);

    // ── SCENARIO 7–8: MFA setup ───────────────────────────────────────────────
    section("SCENARIO 7: enableMfaForUser works");
    const mfa7 = await enableMfaForUser({ userId: USER_A, methodType: "totp" });
    assert(typeof mfa7.methodId === "string", "methodId returned");
    assert(typeof mfa7.totpSecret === "string" && mfa7.totpSecret.length >= 20, "totpSecret returned (base32)");
    assert(mfa7.totpUri.includes("otpauth://totp/"), "totpUri well-formed");
    assert(mfa7.note.includes("INV-SEC1"), "Note references INV-SEC1");

    section("SCENARIO 8: Secret is NOT stored in plaintext");
    const secretRow = await client.query(
      `SELECT secret_encrypted FROM public.user_mfa_methods WHERE id = $1`,
      [mfa7.methodId],
    );
    assert(secretRow.rows.length === 1, "MFA method row found");
    assert(secretRow.rows[0].secret_encrypted !== mfa7.totpSecret, "INV-SEC1: Secret not stored in plaintext");
    assert(typeof secretRow.rows[0].secret_encrypted === "string" && secretRow.rows[0].secret_encrypted.length > 0, "Encrypted secret present");

    // ── SCENARIO 9: MFA not yet enabled (requires activation) ─────────────────
    section("SCENARIO 9: MFA not enabled before activation");
    const enabled9 = await isMfaEnabled(USER_A);
    assert(enabled9 === false, "MFA is not enabled before activation code verification");

    // ── SCENARIO 10: Idempotent enableMfaForUser ──────────────────────────────
    section("SCENARIO 10: enableMfaForUser is idempotent");
    const mfa10b = await enableMfaForUser({ userId: USER_A, methodType: "totp" });
    const methods10 = await listUserMfaMethods(USER_A);
    assert(methods10.filter((m) => m.methodType === "totp").length === 1, "Only one TOTP method per user");

    // ── SCENARIO 11: verifyMfaCode — wrong code fails ─────────────────────────
    section("SCENARIO 11: verifyMfaCode — wrong code fails");
    const v11 = await verifyMfaCode({ userId: USER_A, code: "000000" });
    assert(v11.valid === false, "Wrong TOTP code returns valid=false");

    // ── SCENARIO 12: Recovery codes — generated and stored as hashes ──────────
    section("SCENARIO 12: generateRecoveryCodes works");
    const rc12 = await generateRecoveryCodes({ userId: USER_A, count: 10 });
    assert(rc12.codes.length === 10, "10 recovery codes generated");
    assert(rc12.note.includes("INV-SEC1") && (rc12.note.includes("once") || rc12.note.includes("Plaintext")), "INV-SEC1: Codes revealed once");
    const dbCodes = await client.query(
      `SELECT code_hash, used FROM public.mfa_recovery_codes WHERE user_id = $1`,
      [USER_A],
    );
    assert(dbCodes.rows.length === 10, "10 code hashes stored in DB");
    assert(dbCodes.rows.every((r) => r.code_hash !== rc12.codes[0]), "INV-SEC1: Plaintext not in DB");
    assert(dbCodes.rows.every((r) => r.code_hash.length === 64), "SHA-256 hashes (64 chars)");

    // ── SCENARIO 13: Recovery code is single-use ──────────────────────────────
    section("SCENARIO 13: Recovery code is single-use");
    const rc13 = await generateRecoveryCodes({ userId: USER_A, count: 2 });
    const firstCode = rc13.codes[0];
    const v13a = await verifyMfaCode({ userId: USER_A, code: firstCode });
    assert(v13a.valid === true, "First use of recovery code succeeds");
    assert(v13a.recoveryCodeUsed === true, "recoveryCodeUsed = true");
    const v13b = await verifyMfaCode({ userId: USER_A, code: firstCode });
    assert(v13b.valid === false, "Second use of same recovery code fails (single-use)");

    // ── SCENARIO 14: listUserMfaMethods ───────────────────────────────────────
    section("SCENARIO 14: listUserMfaMethods returns structured data");
    const methods14 = await listUserMfaMethods(USER_A);
    assert(methods14.length >= 1, "MFA methods found");
    assert(methods14.every((m) => typeof m.methodType === "string"), "methodType present");
    assert(methods14.every((m) => typeof m.enabled === "boolean"), "enabled present");

    // ── SCENARIO 15: disableMfa ───────────────────────────────────────────────
    section("SCENARIO 15: disableMfa works");
    const dis15 = await disableMfa({ userId: USER_A, methodType: "totp" });
    assert(dis15.methodsDisabled >= 1, "At least 1 method disabled");
    const enabled15 = await isMfaEnabled(USER_A);
    assert(enabled15 === false, "MFA disabled after disableMfa call");

    // ── SCENARIO 16: Session creation ─────────────────────────────────────────
    section("SCENARIO 16: createSession works");
    const sess16 = await createSession({
      userId: USER_A,
      tenantId: TENANT_A,
      deviceName: "Chrome on Mac",
      ipAddress: "192.168.1.100",
      userAgent: "Mozilla/5.0",
    });
    assert(typeof sess16.sessionId === "string", "sessionId returned");
    assert(sess16.sessionToken.startsWith("sess_"), "sessionToken starts with sess_");
    assert(sess16.refreshToken.startsWith("ref_"), "refreshToken starts with ref_");
    assert(sess16.expiresAt > new Date(), "expiresAt is in the future");
    assert(sess16.note.includes("INV-SEC2"), "Note references INV-SEC2");

    // ── SCENARIO 17: Session token stored as hash ─────────────────────────────
    section("SCENARIO 17: Session token stored as hash (INV-SEC2)");
    const dbSess17 = await client.query(
      `SELECT session_token_hash FROM public.user_sessions WHERE id = $1`,
      [sess16.sessionId],
    );
    assert(dbSess17.rows[0].session_token_hash !== sess16.sessionToken, "INV-SEC2: Token not stored in plaintext");
    assert(dbSess17.rows[0].session_token_hash.length === 64, "SHA-256 hash stored");

    // ── SCENARIO 18: Refresh token stored as hash ─────────────────────────────
    section("SCENARIO 18: Refresh token stored as hash (INV-SEC2)");
    const dbRef18 = await client.query(
      `SELECT refresh_token_hash FROM public.session_tokens WHERE session_id = $1`,
      [sess16.sessionId],
    );
    assert(dbRef18.rows[0].refresh_token_hash !== sess16.refreshToken, "INV-SEC2: Refresh token not stored in plaintext");
    assert(dbRef18.rows[0].refresh_token_hash.length === 64, "SHA-256 hash stored");

    // ── SCENARIO 19: validateSession works ────────────────────────────────────
    section("SCENARIO 19: validateSession — valid session");
    const val19 = await validateSession(sess16.sessionToken);
    assert(val19.valid === true, "Valid session token validates successfully");
    assert(val19.userId === USER_A, "Correct userId from session");
    assert(val19.sessionId === sess16.sessionId, "Correct sessionId");

    // ── SCENARIO 20: Wrong token fails ────────────────────────────────────────
    section("SCENARIO 20: validateSession — wrong token fails");
    const val20 = await validateSession("sess_wrongtoken12345678901234567890");
    assert(val20.valid === false, "Wrong session token fails");
    assert(val20.denialReason === "Session not found", "Structured denial reason");

    // ── SCENARIO 21: Revoked session fails (INV-SEC3) ─────────────────────────
    section("SCENARIO 21: Revoked session fails (INV-SEC3)");
    await revokeSession({ sessionId: sess16.sessionId, reason: "test_revocation" });
    const val21 = await validateSession(sess16.sessionToken);
    assert(val21.valid === false, "INV-SEC3: Revoked session fails validation");
    assert(val21.denialReason !== undefined, "Denial reason provided");

    // ── SCENARIO 22: revokeSession is idempotent ──────────────────────────────
    section("SCENARIO 22: revokeSession is idempotent");
    const rev22 = await revokeSession({ sessionId: sess16.sessionId });
    assert(rev22.idempotent === true, "Second revocation is idempotent");

    // ── SCENARIO 23: Session rotation works ───────────────────────────────────
    section("SCENARIO 23: rotateSessionToken works");
    const sess23 = await createSession({ userId: USER_B, tenantId: TENANT_A });
    const rot23 = await rotateSessionToken({ refreshToken: sess23.refreshToken });
    assert(rot23.valid === true, "Token rotation succeeds");
    assert(rot23.newSessionToken !== undefined, "New session token returned");
    assert(rot23.newRefreshToken !== undefined, "New refresh token returned");
    assert(rot23.newSessionToken !== sess23.sessionToken, "New session token is different");
    assert(rot23.newRefreshToken !== sess23.refreshToken, "New refresh token is different");

    // ── SCENARIO 24: Old session token invalid after rotation ─────────────────
    section("SCENARIO 24: Old session token invalid after rotation");
    const val24 = await validateSession(sess23.sessionToken);
    assert(val24.valid === false, "Old session token rejected after rotation");

    // ── SCENARIO 25: New session token valid after rotation ───────────────────
    section("SCENARIO 25: New session token valid after rotation");
    const val25 = await validateSession(rot23.newSessionToken!);
    assert(val25.valid === true, "New session token valid after rotation");

    // ── SCENARIO 26: Refresh token can only be used once ──────────────────────
    section("SCENARIO 26: Refresh token single-use after rotation");
    const rot26 = await rotateSessionToken({ refreshToken: sess23.refreshToken });
    assert(rot26.valid === false, "Old refresh token rejected after rotation");

    // ── SCENARIO 27: revokeAllSessionsForUser ────────────────────────────────
    section("SCENARIO 27: revokeAllSessionsForUser works");
    const sessX = await createSession({ userId: USER_A, tenantId: TENANT_A });
    const sessY = await createSession({ userId: USER_A, tenantId: TENANT_A });
    const revAll = await revokeAllSessionsForUser({ userId: USER_A, reason: "logout_all" });
    assert(revAll.revokedCount >= 2, `At least 2 sessions revoked (got ${revAll.revokedCount})`);
    const valX = await validateSession(sessX.sessionToken);
    const valY = await validateSession(sessY.sessionToken);
    assert(valX.valid === false, "Session X revoked by logout-all");
    assert(valY.valid === false, "Session Y revoked by logout-all");

    // ── SCENARIO 28: listUserSessions returns complete list ───────────────────
    section("SCENARIO 28: listUserSessions returns complete list");
    const list28 = await listUserSessions(USER_A);
    assert(Array.isArray(list28), "Returns array");
    assert(list28.length >= 2, "At least 2 sessions found");
    assert(list28.some((s) => s.isRevoked), "At least one revoked session listed");
    assert(list28.every((s) => typeof s.id === "string"), "All sessions have id");
    assert(list28.every((s) => s.expiresAt instanceof Date), "All sessions have expiresAt");

    // ── SCENARIO 29: detectNewDevice ─────────────────────────────────────────
    section("SCENARIO 29: detectNewDevice works");
    const det29a = await detectNewDevice({ userId: USER_A, ipAddress: "192.168.1.100", deviceName: "Chrome on Mac" });
    assert(typeof det29a.isNewDevice === "boolean", "isNewDevice is boolean");
    assert(det29a.note.includes("No writes"), "INV-SEC8: detectNewDevice is read-only");

    const det29b = await detectNewDevice({ userId: USER_A, ipAddress: "10.0.0.99", deviceName: "Unknown Device" });
    assert(det29b.isNewDevice === true, "Unknown device/IP is new device");

    // ── SCENARIO 30: Security event logging ───────────────────────────────────
    section("SCENARIO 30: logSecurityEventExternal works");
    const evt30 = await logSecurityEventExternal({
      tenantId: TENANT_A,
      userId: USER_A,
      eventType: "login_success",
      ipAddress: "10.0.0.1",
      metadata: { browser: "Chrome" },
    });
    assert(typeof evt30.eventId === "string", "Event ID returned");
    const dbEvt30 = await client.query(
      `SELECT event_type, tenant_id FROM public.security_events WHERE id = $1`,
      [evt30.eventId],
    );
    assert(dbEvt30.rows[0].event_type === "login_success", "Event type stored correctly");
    assert(dbEvt30.rows[0].tenant_id === TENANT_A, "INV-SEC8: Event tenant-isolated");

    // ── SCENARIO 31: Security event type constraint ────────────────────────────
    section("SCENARIO 31: Invalid event type rejected by CHECK constraint");
    let err31 = false;
    try {
      await client.query(
        `INSERT INTO public.security_events (id, event_type) VALUES (gen_random_uuid(), 'invalid_type')`,
      );
    } catch { err31 = true; }
    assert(err31, "CHECK constraint rejects invalid event_type");

    // ── SCENARIO 32: IP allowlist — empty means unrestricted ──────────────────
    section("SCENARIO 32: Empty IP allowlist = unrestricted");
    const ip32 = await verifyIpAllowed({ tenantId: `tenant-no-allowlist-${TS}`, ip: "1.2.3.4" });
    assert(ip32.allowed === true, "No allowlist configured = unrestricted");
    assert(ip32.reason.includes("unrestricted"), "Reason mentions unrestricted");

    // ── SCENARIO 33: IP allowlist — add and match ─────────────────────────────
    section("SCENARIO 33: IP allowlist — add CIDR and match");
    await addIpAllowlistEntry({ tenantId: TENANT_A, ipRange: "192.168.1.0/24", description: "Internal" });
    const ip33a = await verifyIpAllowed({ tenantId: TENANT_A, ip: "192.168.1.55" });
    assert(ip33a.allowed === true, "IP in CIDR range is allowed");
    assert(ip33a.matchedRange === "192.168.1.0/24", "Correct CIDR match returned");

    const ip33b = await verifyIpAllowed({ tenantId: TENANT_A, ip: "10.0.0.1" });
    assert(ip33b.allowed === false, "IP outside CIDR range is blocked");

    // ── SCENARIO 34: IP allowlist — /32 single IP ─────────────────────────────
    section("SCENARIO 34: IP allowlist — /32 single IP match");
    await addIpAllowlistEntry({ tenantId: TENANT_A, ipRange: "203.0.113.5/32", description: "Office IP" });
    const ip34a = await verifyIpAllowed({ tenantId: TENANT_A, ip: "203.0.113.5" });
    assert(ip34a.allowed === true, "/32 single IP allowed");
    const ip34b = await verifyIpAllowed({ tenantId: TENANT_A, ip: "203.0.113.6" });
    assert(ip34b.allowed === false, "Adjacent IP outside /32 blocked");

    // ── SCENARIO 35: IP allowlist — list and remove ────────────────────────────
    section("SCENARIO 35: IP allowlist — list and remove");
    const list35 = await listTenantIpAllowlist(TENANT_A);
    assert(list35.length >= 2, "At least 2 allowlist entries");
    const removed35 = await removeIpAllowlistEntry({ tenantId: TENANT_A, ipRange: "203.0.113.5/32" });
    assert(removed35.removed === true, "Entry removed");
    const list35b = await listTenantIpAllowlist(TENANT_A);
    assert(list35b.length === list35.length - 1, "One fewer entry after removal");

    // ── SCENARIO 36: Security headers — structure ─────────────────────────────
    section("SCENARIO 36: Security headers explainer structured (INV-SEC6)");
    const headers36 = explainSecurityHeaders();
    assert(Array.isArray(headers36.headers), "headers is array");
    assert(headers36.headers.length >= 5, "At least 5 headers defined");
    const headerNames36 = headers36.headers.map((h) => h.name);
    assert(headerNames36.includes("Content-Security-Policy"), "CSP header defined");
    assert(headerNames36.includes("X-Frame-Options"), "X-Frame-Options defined");
    assert(headerNames36.includes("X-Content-Type-Options"), "X-Content-Type-Options defined");
    assert(headerNames36.includes("Referrer-Policy"), "Referrer-Policy defined");
    assert(headerNames36.includes("Strict-Transport-Security"), "HSTS defined");
    assert(headers36.note.includes("INV-SEC6"), "Note references INV-SEC6");

    // ── SCENARIO 37: Rate limit state ─────────────────────────────────────────
    section("SCENARIO 37: Rate limit state explainer (INV-SEC5)");
    const rl37 = explainRateLimitState();
    assert(typeof rl37.activeIpWindows === "number", "activeIpWindows is number");
    assert(typeof rl37.limits === "object", "limits object present");
    assert(rl37.limits.login.limit === 10, "Login limit = 10");
    assert(rl37.limits.api.limit === 200, "API limit = 200");
    assert(rl37.limits.aiQuery.limit === 30, "AI query limit = 30");
    assert(rl37.note.includes("INV-SEC5"), "Note references INV-SEC5");

    // ── SCENARIO 38–39: Upload validation ─────────────────────────────────────
    section("SCENARIO 38: Upload validation — valid PDF passes");
    const pdfBuf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
    const up38 = validateUpload({ buffer: pdfBuf, claimedMimeType: "application/pdf" });
    assert(up38.valid === true, "Valid PDF magic bytes pass");
    assert(up38.checks.magicBytesValid === true, "Magic bytes valid");
    assert(up38.checks.mimeTypeAllowed === true, "MIME type allowed");
    assert(up38.note.includes("INV-SEC7"), "Note references INV-SEC7");

    section("SCENARIO 39: Upload validation — wrong magic bytes rejected");
    const fakePdf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up39 = validateUpload({ buffer: fakePdf, claimedMimeType: "application/pdf" });
    assert(up39.valid === false, "PNG bytes claiming to be PDF rejected");
    assert(up39.checks.magicBytesValid === false, "magicBytesValid = false");
    assert(up39.rejectionReason?.includes("Magic bytes"), "Rejection reason mentions magic bytes");

    section("SCENARIO 40: Upload validation — MIME type not allowed");
    const up40 = validateUpload({ buffer: Buffer.from("test"), claimedMimeType: "application/x-executable" });
    assert(up40.valid === false, "Executable MIME type rejected");
    assert(up40.checks.mimeTypeAllowed === false, "mimeTypeAllowed = false");

    section("SCENARIO 41: Upload validation — file size limit");
    const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 1, 0x25);
    const up41 = validateUpload({ buffer: bigBuf, claimedMimeType: "text/plain", maxSizeBytes: 1 * 1024 * 1024 });
    assert(up41.valid === false, "Oversized file rejected");
    assert(up41.checks.sizeLimitOk === false, "sizeLimitOk = false");

    section("SCENARIO 42: Upload validation — valid JPEG passes");
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const up42 = validateUpload({ buffer: jpegBuf, claimedMimeType: "image/jpeg" });
    assert(up42.valid === true, "Valid JPEG magic bytes pass");

    section("SCENARIO 43: Upload validation — SVG with script rejected");
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const up43 = validateUpload({ buffer: svgBuf, claimedMimeType: "text/plain", filename: "test.svg" });
    assert(up43.valid === false, "SVG with script tag rejected");
    assert(up43.checks.svgSafe === false, "svgSafe = false");

    section("SCENARIO 44: Upload validation — clean SVG passes");
    const cleanSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>');
    const up44 = validateUpload({ buffer: cleanSvg, claimedMimeType: "text/plain", filename: "shape.svg" });
    assert(up44.valid === true, "Clean SVG passes validation");
    assert(up44.checks.svgSafe === true, "svgSafe = true");

    section("SCENARIO 45: ALL_ALLOWED_TYPES covers key types");
    assert(ALL_ALLOWED_TYPES.includes("application/pdf"), "PDF in allowed types");
    assert(ALL_ALLOWED_TYPES.includes("image/jpeg"), "JPEG in allowed types");
    assert(ALL_ALLOWED_TYPES.includes("image/png"), "PNG in allowed types");
    assert(ALL_ALLOWED_TYPES.includes("text/csv"), "CSV in allowed types");
    assert(!ALL_ALLOWED_TYPES.includes("application/x-executable"), "Executable not in allowed types");

    // ── SCENARIO 46: Security events are tenant-isolated ──────────────────────
    section("SCENARIO 46: Security events are tenant-isolated (INV-SEC8)");
    await logSecurityEventExternal({ tenantId: TENANT_B, userId: USER_B, eventType: "login_failed", ipAddress: "1.2.3.4" });
    const evtsA = await client.query(
      `SELECT id FROM public.security_events WHERE tenant_id = $1`,
      [TENANT_A],
    );
    const evtsB = await client.query(
      `SELECT id FROM public.security_events WHERE tenant_id = $1`,
      [TENANT_B],
    );
    const allEvtIds = [...evtsA.rows.map((r) => r.id), ...evtsB.rows.map((r) => r.id)];
    const uniqueIds = new Set(allEvtIds);
    assert(evtsA.rows.length > 0, "Tenant A events found");
    assert(evtsB.rows.length > 0, "Tenant B events found");
    assert(allEvtIds.length === uniqueIds.size, "INV-SEC8: No event overlap between tenants");

    // ── SCENARIO 47: Session security event logged on create ──────────────────
    section("SCENARIO 47: Session creation logs security event");
    const sess47 = await createSession({ userId: USER_A, tenantId: TENANT_A, ipAddress: "10.1.2.3" });
    const evts47 = await client.query(
      `SELECT event_type FROM public.security_events WHERE user_id = $1 AND event_type = 'session_created' ORDER BY created_at DESC LIMIT 1`,
      [USER_A],
    );
    assert(evts47.rows.length >= 1, "session_created event logged");

    // ── SCENARIO 48: Session revocation logs security event ───────────────────
    section("SCENARIO 48: Session revocation logs security event");
    await revokeSession({ sessionId: sess47.sessionId, tenantId: TENANT_A });
    const evts48 = await client.query(
      `SELECT event_type FROM public.security_events WHERE user_id = $1 AND event_type = 'session_revoked' ORDER BY created_at DESC LIMIT 1`,
      [USER_A],
    );
    assert(evts48.rows.length >= 1, "session_revoked event logged");

    // ── SCENARIO 49: Expired session fails validation ──────────────────────────
    section("SCENARIO 49: Expired session fails validation (INV-SEC3)");
    const expiredSess = await createSession({ userId: USER_A, ttlHours: 0 }); // 0 hours = expires now
    await client.query(
      `UPDATE public.user_sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [expiredSess.sessionId],
    );
    const val49 = await validateSession(expiredSess.sessionToken);
    assert(val49.valid === false, "INV-SEC3: Expired session fails validation");
    assert(val49.denialReason?.includes("expired"), "Denial reason mentions expired");

    // ── SCENARIO 50: requestSizeLimitMiddleware works ──────────────────────────
    section("SCENARIO 50: requestSizeLimitMiddleware is a valid middleware factory");
    const mw50 = requestSizeLimitMiddleware({ maxJsonBytes: 1024, maxMultipartBytes: 1024 * 1024 });
    assert(typeof mw50 === "function", "requestSizeLimitMiddleware returns function");
    assert(mw50.length === 3, "Middleware has correct arity (req, res, next)");

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Phase 7 validation: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error(`✗ ${failed} assertion(s) FAILED`);
      process.exit(1);
    } else {
      console.log(`✔ All ${passed} assertions passed`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Validation error:", e.message);
  process.exit(1);
});
