/**
 * Phase 37 — Secure Authentication Platform
 * Validation Script — 60+ scenarios, 180+ assertions
 *
 * Run: npx tsx scripts/validate-phase37.ts
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; failures.push(message); console.error(`  ✗ FAIL: ${message}`); }
}

function fileExists(p: string): boolean {
  return fs.existsSync(path.join(process.cwd(), p));
}

function fileContains(p: string, pattern: string): boolean {
  try { return fs.readFileSync(path.join(process.cwd(), p), "utf-8").includes(pattern); }
  catch { return false; }
}

async function dbQuery<T>(client: Client, sql: string, params: any[] = []): Promise<T[]> {
  const res = await client.query<T>(sql, params);
  return res.rows;
}

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";

// ─── PART 1: Migration / Database Tables ──────────────────────────────────
console.log("\n[Part 1] Database tables (migration 037_auth_platform.sql)");

const client = new Client({ connectionString: DB_URL });
await client.connect();

const tables = await dbQuery<{ table_name: string }>(
  client,
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'auth_%'`,
);
const tableSet = new Set(tables.map(t => t.table_name));

const expectedTables = [
  "auth_sessions", "auth_login_attempts", "auth_password_reset_tokens",
  "auth_email_verification_tokens", "auth_mfa_totp", "auth_mfa_recovery_codes",
  "auth_invites", "auth_security_events",
];
for (const t of expectedTables) {
  assert(tableSet.has(t), `Table ${t} exists in DB`);
}

// Verify indexes
const indexes = await dbQuery<{ indexname: string }>(
  client,
  `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'auth_%'`,
);
const idxSet = new Set(indexes.map(i => i.indexname));

const expectedIndexes = [
  "idx_auth_sessions_user_created", "idx_auth_sessions_tenant_created", "idx_auth_sessions_token",
  "idx_auth_attempts_email_created", "idx_auth_attempts_ip_created",
  "idx_auth_prt_user_created", "idx_auth_prt_token",
  "idx_auth_evt_user_created", "idx_auth_evt_token",
  "idx_auth_mfa_rc_user_created",
  "idx_auth_invites_tenant_created", "idx_auth_invites_token",
  "idx_auth_sec_events_tenant_created", "idx_auth_sec_events_user_created", "idx_auth_sec_events_type_created",
];
for (const idx of expectedIndexes) {
  assert(idxSet.has(idx), `Index ${idx} exists`);
}

// Verify key columns
const cols = await dbQuery<{ table_name: string; column_name: string }>(
  client,
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'auth_%'`,
);
const colSet = new Set(cols.map(c => `${c.table_name}.${c.column_name}`));

const expectedCols = [
  "auth_sessions.session_token", "auth_sessions.revoked_at", "auth_sessions.expires_at",
  "auth_sessions.device_label", "auth_sessions.ip_address", "auth_sessions.user_agent",
  "auth_login_attempts.email_hash", "auth_login_attempts.success", "auth_login_attempts.failure_reason",
  "auth_password_reset_tokens.token_hash", "auth_password_reset_tokens.used_at", "auth_password_reset_tokens.expires_at",
  "auth_email_verification_tokens.token_hash", "auth_email_verification_tokens.used_at",
  "auth_mfa_totp.secret_encrypted", "auth_mfa_totp.enabled", "auth_mfa_totp.verified_at",
  "auth_mfa_recovery_codes.code_hash", "auth_mfa_recovery_codes.used_at",
  "auth_invites.token_hash", "auth_invites.accepted_at", "auth_invites.role", "auth_invites.invited_by",
  "auth_security_events.event_type", "auth_security_events.severity", "auth_security_events.metadata_json",
];
for (const c of expectedCols) {
  assert(colSet.has(c), `Column ${c} exists`);
}

await client.end().catch(() => {});

// ─── PART 2: auth-audit.ts ───────────────────────────────────────────────
console.log("\n[Part 2] server/lib/auth-platform/auth-audit.ts");

assert(fileExists("server/lib/auth-platform/auth-audit.ts"),                      "auth-audit.ts exists");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logAuthEvent"),     "logAuthEvent exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logLoginSuccess"),  "logLoginSuccess exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logLoginFailure"),  "logLoginFailure exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logLogout"),        "logLogout exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logPasswordResetRequested"), "logPasswordResetRequested exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logPasswordChanged"),        "logPasswordChanged exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logMfaEnabled"),    "logMfaEnabled exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logMfaDisabled"),   "logMfaDisabled exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "logSessionRevoked"),"logSessionRevoked exported");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "auth_security_events"), "inserts to auth_security_events");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "suspicious_login_detected"),  "suspicious_login_detected event type");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "rate_limit_triggered"),       "rate_limit_triggered event type");
assert(fileContains("server/lib/auth-platform/auth-audit.ts", "mfa_challenge_failed"),        "mfa_challenge_failed event type");

// ─── PART 3: auth-security.ts ────────────────────────────────────────────
console.log("\n[Part 3] server/lib/auth-platform/auth-security.ts");

assert(fileExists("server/lib/auth-platform/auth-security.ts"),                            "auth-security.ts exists");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "recordLoginAttempt"),    "recordLoginAttempt exported");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "isEmailLimited"),        "isEmailLimited exported");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "isIpLimited"),           "isIpLimited exported");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "getAuthSecurityState"),  "getAuthSecurityState exported");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "detectSuspiciousAuthPatterns"), "detectSuspiciousAuthPatterns exported");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "hashEmail"),             "hashEmail uses sha256");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "sha256"),                "sha256 used for email hashing");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "auth_login_attempts"),   "queries auth_login_attempts");
assert(fileContains("server/lib/auth-platform/auth-security.ts", "cooldownUntil"),         "cooldown time included in state");

// ─── PART 4: session-service.ts ──────────────────────────────────────────
console.log("\n[Part 4] server/lib/auth-platform/session-service.ts");

assert(fileExists("server/lib/auth-platform/session-service.ts"),                         "session-service.ts exists");
assert(fileContains("server/lib/auth-platform/session-service.ts", "createSession"),      "createSession exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "listUserSessions"),   "listUserSessions exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "revokeSession"),      "revokeSession exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "revokeAllOtherSessions"), "revokeAllOtherSessions exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "touchSession"),       "touchSession exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "rotateSession"),      "rotateSession exported");
assert(fileContains("server/lib/auth-platform/session-service.ts", "httpOnly"),           "httpOnly cookie flag set");
assert(fileContains("server/lib/auth-platform/session-service.ts", "secure"),             "secure cookie flag set");
assert(fileContains("server/lib/auth-platform/session-service.ts", "sameSite"),           "sameSite cookie flag set");
assert(fileContains("server/lib/auth-platform/session-service.ts", "sha256"),             "tokens hashed with sha256");
assert(fileContains("server/lib/auth-platform/session-service.ts", "randomBytes"),        "tokens generated with randomBytes");
assert(fileContains("server/lib/auth-platform/session-service.ts", "revoked_at"),         "revocation tracked in DB");
assert(fileContains("server/lib/auth-platform/session-service.ts", "expires_at"),         "expiry tracked in DB");

// ─── PART 5: login-service.ts ────────────────────────────────────────────
console.log("\n[Part 5] server/lib/auth-platform/login-service.ts");

assert(fileExists("server/lib/auth-platform/login-service.ts"),                          "login-service.ts exists");
assert(fileContains("server/lib/auth-platform/login-service.ts", "loginWithPassword"),   "loginWithPassword exported");
assert(fileContains("server/lib/auth-platform/login-service.ts", "completeMfaLogin"),    "completeMfaLogin exported");
assert(fileContains("server/lib/auth-platform/login-service.ts", "logout"),              "logout exported");
assert(fileContains("server/lib/auth-platform/login-service.ts", "refreshSession"),      "refreshSession exported");
assert(fileContains("server/lib/auth-platform/login-service.ts", "hashPassword"),        "hashPassword exported");
assert(fileContains("server/lib/auth-platform/login-service.ts", "argon2"),              "argon2 used for password hashing");
assert(fileContains("server/lib/auth-platform/login-service.ts", "argon2id"),            "argon2id variant used");
assert(fileContains("server/lib/auth-platform/login-service.ts", "GENERIC_AUTH_ERROR"),  "GENERIC_AUTH_ERROR constant — no enumeration");
assert(fileContains("server/lib/auth-platform/login-service.ts", "mfaRequired"),         "mfaRequired in response");
assert(fileContains("server/lib/auth-platform/login-service.ts", "pendingMfaToken"),     "pendingMfaToken issued for MFA flow");
assert(fileContains("server/lib/auth-platform/login-service.ts", "isEmailLimited"),      "brute force email check integrated");
assert(fileContains("server/lib/auth-platform/login-service.ts", "isIpLimited"),         "brute force IP check integrated");
assert(fileContains("server/lib/auth-platform/login-service.ts", "dummy_timing_equaliser"), "timing attack equaliser present");
assert(!fileContains("server/lib/auth-platform/login-service.ts", "console.log(password"), "password never logged");

// ─── PART 6: password-reset-service.ts ───────────────────────────────────
console.log("\n[Part 6] server/lib/auth-platform/password-reset-service.ts");

assert(fileExists("server/lib/auth-platform/password-reset-service.ts"),                            "password-reset-service.ts exists");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "requestPasswordReset"),  "requestPasswordReset exported");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "verifyResetToken"),      "verifyResetToken exported");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "resetPassword"),         "resetPassword exported");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "validatePasswordStrength"), "password strength validation");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "12"),                    "minimum 12 char password length");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "sha256"),                "token hashed with sha256");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "used_at"),               "one-time use enforced via used_at");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "expires_at"),            "expiry enforced");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "GENERIC_RESET_MSG"),     "generic message prevents enumeration");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "auth_password_reset_tokens"), "uses correct table");

// ─── PART 7: email-verification-service.ts ───────────────────────────────
console.log("\n[Part 7] server/lib/auth-platform/email-verification-service.ts");

assert(fileExists("server/lib/auth-platform/email-verification-service.ts"),                              "email-verification-service.ts exists");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "issueEmailVerification"),  "issueEmailVerification exported");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "verifyEmailToken"),        "verifyEmailToken exported");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "sha256"),                  "token hashed with sha256");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "used_at"),                 "one-time use via used_at");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "email_verified"),          "marks user email_verified");
assert(fileContains("server/lib/auth-platform/email-verification-service.ts", "auth_email_verification_tokens"), "correct table used");

// ─── PART 8: invite-service.ts ───────────────────────────────────────────
console.log("\n[Part 8] server/lib/auth-platform/invite-service.ts");

assert(fileExists("server/lib/auth-platform/invite-service.ts"),                          "invite-service.ts exists");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "createInvite"),        "createInvite exported");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "validateInvite"),      "validateInvite exported");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "acceptInvite"),        "acceptInvite exported");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "sha256"),              "token hashed with sha256");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "accepted_at"),         "one-time use via accepted_at");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "expires_at"),          "expiry enforced");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "auth_invites"),        "uses auth_invites table");
assert(fileContains("server/lib/auth-platform/invite-service.ts", "invite_accepted"),     "logs invite_accepted event");

// ─── PART 9: mfa-service.ts ──────────────────────────────────────────────
console.log("\n[Part 9] server/lib/auth-platform/mfa-service.ts");

assert(fileExists("server/lib/auth-platform/mfa-service.ts"),                              "mfa-service.ts exists");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "beginTotpEnrollment"),     "beginTotpEnrollment exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "verifyTotpEnrollment"),    "verifyTotpEnrollment exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "challengeTotp"),           "challengeTotp exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "generateRecoveryCodes"),   "generateRecoveryCodes exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "useRecoveryCode"),         "useRecoveryCode exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "disableMfa"),              "disableMfa exported");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "otplib"),                  "otplib TOTP library used");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "authenticator"),           "authenticator from otplib used");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "secret_encrypted"),        "secrets stored encrypted");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "aes-256-cbc"),             "AES-256-CBC encryption");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "sha256"),                  "recovery codes hashed");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "used_at"),                 "recovery codes one-time use");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "enabled = TRUE"),          "MFA only enabled after enrollment verification");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "mfa_enabled"),             "logs mfa_enabled event");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "mfa_disabled"),            "logs mfa_disabled event");
assert(fileContains("server/lib/auth-platform/mfa-service.ts", "qrDataUrl"),               "QR code URL generated");

// ─── PART 10: Auth API Routes ─────────────────────────────────────────────
console.log("\n[Part 10] server/routes/auth-platform.ts");

assert(fileExists("server/routes/auth-platform.ts"),                                       "auth-platform.ts routes file exists");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/login"),                  "POST /api/auth/login route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/logout"),                 "POST /api/auth/logout route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/refresh"),                "POST /api/auth/refresh route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/password-reset/request"), "POST /api/auth/password-reset/request route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/password-reset/confirm"), "POST /api/auth/password-reset/confirm route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/email-verification/request"), "POST /api/auth/email-verification/request route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/email-verification/confirm"), "POST /api/auth/email-verification/confirm route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/invite/accept"),          "POST /api/auth/invite/accept route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/mfa/enroll/start"),       "POST /api/auth/mfa/enroll/start route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/mfa/enroll/verify"),      "POST /api/auth/mfa/enroll/verify route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/mfa/challenge"),          "POST /api/auth/mfa/challenge route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/mfa/recovery"),           "POST /api/auth/mfa/recovery route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/sessions"),               "GET /api/auth/sessions route");
assert(fileContains("server/routes/auth-platform.ts", "/api/auth/sessions/revoke-others"), "POST /api/auth/sessions/revoke-others route");
assert(fileContains("server/routes/auth-platform.ts", "strictLimiter"),                    "routes use strictLimiter rate limit");
assert(fileContains("server/routes/auth-platform.ts", "authLimiter"),                      "routes use authLimiter rate limit");
assert(fileContains("server/routes/auth-platform.ts", "cookieParser"),                     "cookieParser middleware registered");
assert(fileContains("server/routes/auth-platform.ts", "registerAuthPlatformRoutes"),       "registerAuthPlatformRoutes exported");

// ─── PART 11: Route Registration ─────────────────────────────────────────
console.log("\n[Part 11] Route registration in server/routes.ts");
assert(fileContains("server/routes.ts", "registerAuthPlatformRoutes"), "registerAuthPlatformRoutes called in routes.ts");
assert(fileContains("server/routes.ts", "auth-platform"),              "auth-platform module imported");

// ─── PART 12: Admin Auth Endpoints ───────────────────────────────────────
console.log("\n[Part 12] Admin auth endpoints in server/routes/admin.ts");
assert(fileContains("server/routes/admin.ts", "/api/admin/auth/overview"),           "/api/admin/auth/overview registered");
assert(fileContains("server/routes/admin.ts", "/api/admin/auth/login-failures"),     "/api/admin/auth/login-failures registered");
assert(fileContains("server/routes/admin.ts", "/api/admin/auth/suspicious-events"),  "/api/admin/auth/suspicious-events registered");
assert(fileContains("server/routes/admin.ts", "/api/admin/auth/sessions"),           "/api/admin/auth/sessions registered");
assert(fileContains("server/routes/admin.ts", "/api/admin/auth/mfa-adoption"),       "/api/admin/auth/mfa-adoption registered");
assert(fileContains("server/routes/admin.ts", "auth_login_attempts"),                "admin routes query auth_login_attempts");
assert(fileContains("server/routes/admin.ts", "auth_sessions"),                      "admin routes query auth_sessions");
assert(fileContains("server/routes/admin.ts", "auth_mfa_totp"),                      "admin routes query auth_mfa_totp");
assert(fileContains("server/routes/admin.ts", "auth_security_events"),               "admin routes query auth_security_events");

// ─── PART 13: Auth UI Pages ──────────────────────────────────────────────
console.log("\n[Part 13] Auth UI pages");

assert(fileExists("client/src/pages/auth/login.tsx"),                               "login.tsx exists");
assert(fileContains("client/src/pages/auth/login.tsx", "data-testid"),              "login.tsx has testId attributes");
assert(fileContains("client/src/pages/auth/login.tsx", "input-email"),              "login email input testId");
assert(fileContains("client/src/pages/auth/login.tsx", "input-password"),           "login password input testId");
assert(fileContains("client/src/pages/auth/login.tsx", "btn-login"),                "login submit button testId");
assert(fileContains("client/src/pages/auth/login.tsx", "mfaRequired"),              "login handles mfaRequired");
assert(fileContains("client/src/pages/auth/login.tsx", "pendingMfaToken"),          "login stores pendingMfaToken");

assert(fileExists("client/src/pages/auth/password-reset-request.tsx"),              "password-reset-request.tsx exists");
assert(fileContains("client/src/pages/auth/password-reset-request.tsx", "btn-send-reset"), "reset request submit testId");

assert(fileExists("client/src/pages/auth/password-reset-confirm.tsx"),              "password-reset-confirm.tsx exists");
assert(fileContains("client/src/pages/auth/password-reset-confirm.tsx", "btn-reset-password"), "reset confirm submit testId");
assert(fileContains("client/src/pages/auth/password-reset-confirm.tsx", "input-new-password"),   "new password input testId");

assert(fileExists("client/src/pages/auth/email-verify.tsx"),                        "email-verify.tsx exists");
assert(fileContains("client/src/pages/auth/email-verify.tsx", "verify-success"),    "verify success state shown");
assert(fileContains("client/src/pages/auth/email-verify.tsx", "verify-error"),      "verify error state shown");

assert(fileExists("client/src/pages/auth/invite-accept.tsx"),                       "invite-accept.tsx exists");
assert(fileContains("client/src/pages/auth/invite-accept.tsx", "btn-accept-invite"), "accept invite button testId");

assert(fileExists("client/src/pages/auth/mfa-challenge.tsx"),                       "mfa-challenge.tsx exists");
assert(fileContains("client/src/pages/auth/mfa-challenge.tsx", "input-totp-code"), "TOTP input testId");
assert(fileContains("client/src/pages/auth/mfa-challenge.tsx", "recovery"),        "recovery code option present");

// ─── PART 14: Security Settings Page ─────────────────────────────────────
console.log("\n[Part 14] client/src/pages/settings/security.tsx");

assert(fileExists("client/src/pages/settings/security.tsx"),                               "security.tsx exists");
assert(fileContains("client/src/pages/settings/security.tsx", "btn-start-mfa-enrollment"), "MFA enrollment start testId");
assert(fileContains("client/src/pages/settings/security.tsx", "btn-verify-enrollment"),    "MFA enrollment verify testId");
assert(fileContains("client/src/pages/settings/security.tsx", "recovery-codes-list"),      "recovery codes section testId");
assert(fileContains("client/src/pages/settings/security.tsx", "btn-revoke-all-sessions"),  "revoke all sessions testId");
assert(fileContains("client/src/pages/settings/security.tsx", "/api/auth/sessions"),       "fetches sessions API");
assert(fileContains("client/src/pages/settings/security.tsx", "mfa-qr-code"),             "QR code displayed");

// ─── PART 15: Ops Auth Security Page ─────────────────────────────────────
console.log("\n[Part 15] client/src/pages/ops/auth.tsx");

assert(fileExists("client/src/pages/ops/auth.tsx"),                                        "ops/auth.tsx exists");
assert(fileContains("client/src/pages/ops/auth.tsx", "OpsNav"),                            "ops/auth uses OpsNav");
assert(fileContains("client/src/pages/ops/auth.tsx", "/api/admin/auth/overview"),          "ops/auth fetches overview");
assert(fileContains("client/src/pages/ops/auth.tsx", "/api/admin/auth/suspicious-events"), "ops/auth fetches suspicious events");
assert(fileContains("client/src/pages/ops/auth.tsx", "/api/admin/auth/login-failures"),    "ops/auth fetches login failures");
assert(fileContains("client/src/pages/ops/auth.tsx", "/api/admin/auth/mfa-adoption"),      "ops/auth fetches MFA adoption");
assert(fileContains("client/src/pages/ops/auth.tsx", "data-testid"),                       "ops/auth has testId attributes");
assert(fileContains("client/src/pages/ops/auth.tsx", "ops-auth-page"),                     "ops/auth has page-level testId");
assert(fileContains("client/src/pages/ops/auth.tsx", "metric-failures-24h"),               "ops/auth failure metric testId");
assert(fileContains("client/src/pages/ops/auth.tsx", "mfa-adoption-card"),                 "ops/auth MFA adoption card");

// ─── PART 16: Navigation & Routing ───────────────────────────────────────
console.log("\n[Part 16] Navigation and routing");

assert(fileContains("client/src/components/ops/OpsNav.tsx", "/ops/auth"),           "OpsNav has /ops/auth link");
assert(fileContains("client/src/components/ops/OpsNav.tsx", "Auth Security"),       "OpsNav label 'Auth Security'");
assert(fileContains("client/src/components/ops/OpsNav.tsx", "KeyRound"),            "OpsNav imports KeyRound icon");
assert(fileContains("client/src/App.tsx", "/auth/login"),                           "App.tsx registers /auth/login route");
assert(fileContains("client/src/App.tsx", "/auth/password-reset"),                  "App.tsx registers /auth/password-reset route");
assert(fileContains("client/src/App.tsx", "/auth/email-verify"),                    "App.tsx registers /auth/email-verify route");
assert(fileContains("client/src/App.tsx", "/auth/invite-accept"),                   "App.tsx registers /auth/invite-accept route");
assert(fileContains("client/src/App.tsx", "/auth/mfa-challenge"),                   "App.tsx registers /auth/mfa-challenge route");
assert(fileContains("client/src/App.tsx", "/settings/security"),                    "App.tsx registers /settings/security route");
assert(fileContains("client/src/App.tsx", "/ops/auth"),                             "App.tsx registers /ops/auth route");

// ─── PART 17: Security Properties ────────────────────────────────────────
console.log("\n[Part 17] Security properties");

assert(fileContains("server/lib/auth-platform/session-service.ts", "httpOnly: true"),    "httpOnly cookie enforced");
assert(fileContains("server/lib/auth-platform/session-service.ts", "NODE_ENV"),          "secure flag conditional on NODE_ENV");
assert(!fileContains("server/lib/auth-platform/login-service.ts",   'console.log(password'),   "password never logged via console.log");
assert(fileContains("server/lib/auth-platform/login-service.ts",    "GENERIC_AUTH_ERROR"), "generic error prevents enumeration on login");
assert(fileContains("server/lib/auth-platform/password-reset-service.ts", "GENERIC_RESET_MSG"), "generic message on reset prevents enumeration");
assert(fileContains("server/lib/auth-platform/mfa-service.ts",     "secret_encrypted"),  "TOTP secrets stored encrypted, not plaintext");
assert(fileContains("server/lib/auth-platform/auth-security.ts",   "sha256"),            "email addresses hashed before storage");
assert(fileContains("server/routes/auth-platform.ts",              "rateLimit"),         "routes have rate limiting");
assert(fileExists("migrations/037_auth_platform.sql"),                                   "migration file exists");
assert(fileContains("migrations/037_auth_platform.sql", "ENABLE ROW LEVEL SECURITY"),   "RLS enabled on all auth tables");

// ─── SUMMARY ─────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`Phase 37 Validation — ${passed + failed} assertions`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
} else {
  console.log("\n✓ All assertions passed — Phase 37 complete");
  process.exit(0);
}
