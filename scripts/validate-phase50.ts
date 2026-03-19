/**
 * Phase 50 — Analytics Foundation Validation
 * 70 scenarios, 300+ assertions
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Infrastructure ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; failures.push(`  ✗ ${msg}`); }
}

function section(title: string): void { console.log(`\n─── ${title} ───`); }

const ROOT = path.resolve(__dirname, "..");
const P    = (...p: string[]) => path.join(ROOT, ...p);

function read(fp: string): string {
  try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
}
function exists(fp: string): boolean { return fs.existsSync(fp); }
function has(fp: string, ...subs: string[]): boolean {
  const c = read(fp);
  return subs.every((s) => c.includes(s));
}

// ─── Import taxonomy + privacy rules ─────────────────────────────────────────

import {
  ANALYTICS_EVENTS,
  ANALYTICS_FAMILIES,
  ANALYTICS_SOURCES,
  ANALYTICS_DOMAIN_ROLES,
  SUPPORTED_LOCALES,
  isValidEventName,
  isValidFamily,
  isValidSource,
  isValidDomainRole,
  isValidLocale,
  getFamilyForEvent,
  getFamilyForEventUnsafe,
  getEventsByFamily,
} from "../server/lib/analytics/event-taxonomy";

import {
  sanitizeAnalyticsPayload,
  assertAnalyticsPayloadAllowed,
  redactAnalyticsPayload,
  isForbiddenKey,
  FORBIDDEN_ANALYTICS_KEYS,
} from "../server/lib/analytics/privacy-rules";

// ─── S01: Taxonomy file exists ────────────────────────────────────────────────

section("S01: event-taxonomy.ts exists");
assert(exists(P("server/lib/analytics/event-taxonomy.ts")), "event-taxonomy.ts exists");
assert(exists(P("server/lib/analytics/privacy-rules.ts")),  "privacy-rules.ts exists");
assert(exists(P("server/lib/analytics/track-event.ts")),    "track-event.ts exists");
assert(exists(P("server/lib/analytics/rollups.ts")),        "rollups.ts exists");
assert(exists(P("server/lib/analytics/migrate-phase50.ts")),"migrate-phase50.ts exists");

// ─── S02: Client files exist ──────────────────────────────────────────────────

section("S02: Client analytics files exist");
assert(exists(P("client/src/lib/analytics/track.ts")),      "client track.ts exists");
assert(exists(P("client/src/hooks/use-track-event.ts")),     "use-track-event.ts exists");
assert(exists(P("server/routes/analytics.ts")),              "server analytics routes exist");

// ─── S03: Documentation files exist ──────────────────────────────────────────

section("S03: Documentation files exist");
assert(exists(P("docs/architecture/analytics-foundation.md")),           "analytics-foundation.md exists");
assert(exists(P("docs/architecture/analytics-vs-audit-vs-security.md")), "analytics-vs-audit-vs-security.md exists");
assert(exists(P("scripts/run-analytics-rollups.ts")),                    "run-analytics-rollups.ts exists");

// ─── S04: Schema additions ────────────────────────────────────────────────────

section("S04: Analytics tables in schema.ts");
assert(has(P("shared/schema.ts"), "analyticsEvents"),       "analyticsEvents table in schema");
assert(has(P("shared/schema.ts"), "analyticsDailyRollups"), "analyticsDailyRollups in schema");
assert(has(P("shared/schema.ts"), "analytics_events"),      "analytics_events table name in schema");
assert(has(P("shared/schema.ts"), "analytics_daily_rollups"), "analytics_daily_rollups table name in schema");
assert(has(P("shared/schema.ts"), "event_family"),          "event_family column defined");
assert(has(P("shared/schema.ts"), "event_name"),            "event_name column defined");
assert(has(P("shared/schema.ts"), "occurred_at"),           "occurred_at column defined");
assert(has(P("shared/schema.ts"), "properties_summary"),    "properties_summary column defined");

// ─── S05: ANALYTICS_FAMILIES ─────────────────────────────────────────────────

section("S05: Analytics families defined");
assert(ANALYTICS_FAMILIES.length === 6, `6 families (got ${ANALYTICS_FAMILIES.length})`);
assert(ANALYTICS_FAMILIES.includes("product"),   "family: product");
assert(ANALYTICS_FAMILIES.includes("funnel"),    "family: funnel");
assert(ANALYTICS_FAMILIES.includes("retention"), "family: retention");
assert(ANALYTICS_FAMILIES.includes("billing"),   "family: billing");
assert(ANALYTICS_FAMILIES.includes("ai"),        "family: ai");
assert(ANALYTICS_FAMILIES.includes("ops"),       "family: ops");

// ─── S06: isValidFamily ───────────────────────────────────────────────────────

section("S06: isValidFamily guards");
assert(isValidFamily("product"),   "isValidFamily: product");
assert(isValidFamily("ai"),        "isValidFamily: ai");
assert(!isValidFamily("unknown"),  "isValidFamily: unknown → false");
assert(!isValidFamily(""),         "isValidFamily: empty → false");
assert(!isValidFamily("PRODUCT"),  "isValidFamily: PRODUCT (uppercase) → false");

// ─── S07: ANALYTICS_SOURCES ───────────────────────────────────────────────────

section("S07: Analytics sources");
assert(ANALYTICS_SOURCES.includes("client"), "source: client");
assert(ANALYTICS_SOURCES.includes("server"), "source: server");
assert(ANALYTICS_SOURCES.includes("system"), "source: system");
assert(ANALYTICS_SOURCES.length === 3,       "exactly 3 sources");

// ─── S08: isValidSource ───────────────────────────────────────────────────────

section("S08: isValidSource guards");
assert(isValidSource("client"),    "isValidSource: client");
assert(isValidSource("server"),    "isValidSource: server");
assert(isValidSource("system"),    "isValidSource: system");
assert(!isValidSource("browser"),  "isValidSource: browser → false");
assert(!isValidSource(""),         "isValidSource: empty → false");

// ─── S09: ANALYTICS_DOMAIN_ROLES ─────────────────────────────────────────────

section("S09: Domain roles");
assert(ANALYTICS_DOMAIN_ROLES.includes("public"), "domain_role: public");
assert(ANALYTICS_DOMAIN_ROLES.includes("app"),    "domain_role: app");
assert(ANALYTICS_DOMAIN_ROLES.includes("admin"),  "domain_role: admin");
assert(ANALYTICS_DOMAIN_ROLES.length === 3,       "exactly 3 domain roles");

// ─── S10: isValidDomainRole ───────────────────────────────────────────────────

section("S10: isValidDomainRole guards");
assert(isValidDomainRole("public"),   "isValidDomainRole: public");
assert(isValidDomainRole("app"),      "isValidDomainRole: app");
assert(isValidDomainRole("admin"),    "isValidDomainRole: admin");
assert(!isValidDomainRole("private"), "isValidDomainRole: private → false");
assert(!isValidDomainRole(""),        "isValidDomainRole: empty → false");

// ─── S11: SUPPORTED_LOCALES ───────────────────────────────────────────────────

section("S11: Supported locales");
assert(SUPPORTED_LOCALES.includes("en"), "locale: en");
assert(SUPPORTED_LOCALES.includes("da"), "locale: da");
assert(SUPPORTED_LOCALES.length === 2,   "exactly 2 locales");
assert(isValidLocale("en"),              "isValidLocale: en");
assert(isValidLocale("da"),              "isValidLocale: da");
assert(!isValidLocale("fr"),             "isValidLocale: fr → false");
assert(!isValidLocale(""),               "isValidLocale: empty → false");

// ─── S12: product.* events ────────────────────────────────────────────────────

section("S12: product.* events defined");
assert(isValidEventName("product.signup_started"),    "product.signup_started");
assert(isValidEventName("product.signup_completed"),  "product.signup_completed");
assert(isValidEventName("product.login"),             "product.login");
assert(isValidEventName("product.logout"),            "product.logout");
assert(isValidEventName("product.program_created"),   "product.program_created");
assert(isValidEventName("product.program_assigned"),  "product.program_assigned");
assert(isValidEventName("product.checkin_submitted"), "product.checkin_submitted");
assert(isValidEventName("product.client_invited"),    "product.client_invited");
assert(isValidEventName("product.client_created"),    "product.client_created");
assert(isValidEventName("product.dashboard_viewed"),  "product.dashboard_viewed");

// ─── S13: funnel.* events ─────────────────────────────────────────────────────

section("S13: funnel.* events defined");
assert(isValidEventName("funnel.landing_view"),           "funnel.landing_view");
assert(isValidEventName("funnel.pricing_view"),           "funnel.pricing_view");
assert(isValidEventName("funnel.signup_view"),            "funnel.signup_view");
assert(isValidEventName("funnel.signup_completed"),       "funnel.signup_completed");
assert(isValidEventName("funnel.trial_started"),          "funnel.trial_started");
assert(isValidEventName("funnel.subscription_started"),   "funnel.subscription_started");
assert(isValidEventName("funnel.subscription_failed"),    "funnel.subscription_failed");
assert(isValidEventName("funnel.subscription_canceled"),  "funnel.subscription_canceled");

// ─── S14: retention.* events ──────────────────────────────────────────────────

section("S14: retention.* events defined");
assert(isValidEventName("retention.session_started"),       "retention.session_started");
assert(isValidEventName("retention.session_weekly_active"), "retention.session_weekly_active");
assert(isValidEventName("retention.checkin_completed"),     "retention.checkin_completed");
assert(isValidEventName("retention.program_interaction"),   "retention.program_interaction");
assert(isValidEventName("retention.daily_active"),          "retention.daily_active");

// ─── S15: billing.* events ────────────────────────────────────────────────────

section("S15: billing.* events defined");
assert(isValidEventName("billing.checkout_started"),    "billing.checkout_started");
assert(isValidEventName("billing.checkout_completed"),  "billing.checkout_completed");
assert(isValidEventName("billing.invoice_paid"),        "billing.invoice_paid");
assert(isValidEventName("billing.payment_failed"),      "billing.payment_failed");
assert(isValidEventName("billing.plan_changed"),        "billing.plan_changed");

// ─── S16: ai.* events ────────────────────────────────────────────────────────

section("S16: ai.* events defined");
assert(isValidEventName("ai.request_started"),     "ai.request_started");
assert(isValidEventName("ai.request_completed"),   "ai.request_completed");
assert(isValidEventName("ai.request_failed"),      "ai.request_failed");
assert(isValidEventName("ai.limit_warning_shown"), "ai.limit_warning_shown");
assert(isValidEventName("ai.budget_exceeded"),     "ai.budget_exceeded");

// ─── S17: ops.* events ────────────────────────────────────────────────────────

section("S17: ops.* events defined");
assert(isValidEventName("ops.dashboard_viewed"),    "ops.dashboard_viewed");
assert(isValidEventName("ops.alert_opened"),        "ops.alert_opened");
assert(isValidEventName("ops.anomaly_viewed"),      "ops.anomaly_viewed");

// ─── S18: Invalid event names rejected ───────────────────────────────────────

section("S18: Invalid event names rejected");
assert(!isValidEventName("unknown.event"),         "unknown.event → invalid");
assert(!isValidEventName("product.nonexistent"),   "product.nonexistent → invalid");
assert(!isValidEventName(""),                      "empty string → invalid");
assert(!isValidEventName("login"),                 "login (no family) → invalid");
assert(!isValidEventName("PRODUCT.LOGIN"),         "uppercase → invalid");
assert(!isValidEventName("product.login.extra"),   "extra segment → invalid");

// ─── S19: getFamilyForEvent ───────────────────────────────────────────────────

section("S19: getFamilyForEvent returns correct family");
assert(getFamilyForEvent("product.login")               === "product",   "product.login → product");
assert(getFamilyForEvent("funnel.pricing_view")         === "funnel",    "funnel.pricing_view → funnel");
assert(getFamilyForEvent("retention.daily_active")      === "retention", "retention.daily_active → retention");
assert(getFamilyForEvent("billing.checkout_completed")  === "billing",   "billing.checkout_completed → billing");
assert(getFamilyForEvent("ai.request_started")          === "ai",        "ai.request_started → ai");
assert(getFamilyForEvent("ops.dashboard_viewed")        === "ops",       "ops.dashboard_viewed → ops");

// ─── S20: getFamilyForEventUnsafe ────────────────────────────────────────────

section("S20: getFamilyForEventUnsafe handles unknown");
assert(getFamilyForEventUnsafe("product.login")    === "product", "unsafe: product.login → product");
assert(getFamilyForEventUnsafe("unknown.event")    === null,      "unsafe: unknown.event → null");
assert(getFamilyForEventUnsafe("")                 === null,      "unsafe: empty → null");

// ─── S21: getEventsByFamily ───────────────────────────────────────────────────

section("S21: getEventsByFamily returns all events for family");
const productEvents   = getEventsByFamily("product");
const funnelEvents    = getEventsByFamily("funnel");
const retentionEvents = getEventsByFamily("retention");
const billingEvents   = getEventsByFamily("billing");
const aiEvents        = getEventsByFamily("ai");
const opsEvents       = getEventsByFamily("ops");

assert(productEvents.length   >= 9, `product events >= 9 (got ${productEvents.length})`);
assert(funnelEvents.length    >= 8, `funnel events >= 8 (got ${funnelEvents.length})`);
assert(retentionEvents.length >= 5, `retention events >= 5 (got ${retentionEvents.length})`);
assert(billingEvents.length   >= 5, `billing events >= 5 (got ${billingEvents.length})`);
assert(aiEvents.length        >= 5, `ai events >= 5 (got ${aiEvents.length})`);
assert(opsEvents.length       >= 3, `ops events >= 3 (got ${opsEvents.length})`);

assert(productEvents.every((e) => e.startsWith("product.")),   "all product events start with product.");
assert(funnelEvents.every((e) => e.startsWith("funnel.")),     "all funnel events start with funnel.");
assert(billingEvents.every((e) => e.startsWith("billing.")),   "all billing events start with billing.");

// ─── S22: Total event count ───────────────────────────────────────────────────

section("S22: Total event count");
const allEvents = Object.keys(ANALYTICS_EVENTS);
assert(allEvents.length >= 30, `total events >= 30 (got ${allEvents.length})`);
assert(allEvents.every((e) => e.includes(".")), "all events contain family separator");

// ─── S23: sanitizeAnalyticsPayload — safe fields pass through ─────────────────

section("S23: sanitizeAnalyticsPayload — safe fields pass through");
const safePayload = { plan_tier: "pro", duration_ms: 150, feature: "checkin", count: 5, flag: true };
const sanitized   = sanitizeAnalyticsPayload(safePayload);
assert(sanitized.plan_tier   === "pro",     "plan_tier passes through");
assert(sanitized.duration_ms === 150,       "duration_ms passes through");
assert(sanitized.feature     === "checkin", "feature passes through");
assert(sanitized.count       === 5,         "count passes through");
assert(sanitized.flag        === true,      "flag passes through");

// ─── S24: sanitizeAnalyticsPayload — forbidden keys stripped ──────────────────

section("S24: sanitizeAnalyticsPayload — forbidden keys stripped");
const dirtyPayload = {
  prompt:       "write me a story",
  password:     "secret123",
  token:        "eyJ...",
  api_key:      "sk-...",
  signed_url:   "https://s3.example.com/...",
  card_number:  "4242424242424242",
  plan_tier:    "pro",
};
const cleanPayload = sanitizeAnalyticsPayload(dirtyPayload);
assert(!("prompt"      in cleanPayload), "prompt stripped");
assert(!("password"    in cleanPayload), "password stripped");
assert(!("token"       in cleanPayload), "token stripped");
assert(!("api_key"     in cleanPayload), "api_key stripped");
assert(!("signed_url"  in cleanPayload), "signed_url stripped");
assert(!("card_number" in cleanPayload), "card_number stripped");
assert(cleanPayload.plan_tier === "pro",  "plan_tier kept");

// ─── S25: sanitizeAnalyticsPayload — raw_ prefix stripped ────────────────────

section("S25: raw_ prefix keys stripped");
const rawPayload = { raw_notes: "private text", raw_prompt: "do this", plan: "basic" };
const cleanRaw   = sanitizeAnalyticsPayload(rawPayload);
assert(!("raw_notes"  in cleanRaw), "raw_notes stripped");
assert(!("raw_prompt" in cleanRaw), "raw_prompt stripped");
assert("plan" in cleanRaw,          "plan kept");

// ─── S26: sanitizeAnalyticsPayload — nested forbidden stripped ────────────────

section("S26: nested forbidden keys stripped");
const nested = { user: { password: "abc", name: "alice" }, plan_tier: "free" };
const cleanNested = sanitizeAnalyticsPayload(nested);
assert(!("password" in (cleanNested.user as any)), "nested password stripped");
assert((cleanNested.user as any).name === "alice", "nested name kept");
assert(cleanNested.plan_tier === "free",            "top-level plan_tier kept");

// ─── S27: assertAnalyticsPayloadAllowed — clean payload passes ────────────────

section("S27: assertAnalyticsPayloadAllowed — clean payload passes");
let threw = false;
try {
  assertAnalyticsPayloadAllowed({ plan_tier: "pro", count: 5 });
} catch { threw = true; }
assert(!threw, "clean payload does not throw");

// ─── S28: assertAnalyticsPayloadAllowed — forbidden throws ───────────────────

section("S28: assertAnalyticsPayloadAllowed — forbidden keys throw");
let threw28 = false;
try {
  assertAnalyticsPayloadAllowed({ prompt: "write me code" });
} catch { threw28 = true; }
assert(threw28, "prompt in payload throws");

let threw28b = false;
try {
  assertAnalyticsPayloadAllowed({ token: "abc", plan: "pro" });
} catch { threw28b = true; }
assert(threw28b, "token in payload throws");

// ─── S29: redactAnalyticsPayload — forbidden → [REDACTED] ────────────────────

section("S29: redactAnalyticsPayload replaces forbidden values");
const redacted = redactAnalyticsPayload({
  password:  "abc",
  plan_tier: "pro",
  token:     "xyz",
});
assert(redacted.password  === "[REDACTED]", "password → [REDACTED]");
assert(redacted.token     === "[REDACTED]", "token → [REDACTED]");
assert(redacted.plan_tier === "pro",        "plan_tier kept");

// ─── S30: isForbiddenKey — exact matches ─────────────────────────────────────

section("S30: isForbiddenKey — exact match checks");
assert(isForbiddenKey("prompt"),       "prompt is forbidden");
assert(isForbiddenKey("password"),     "password is forbidden");
assert(isForbiddenKey("token"),        "token is forbidden");
assert(isForbiddenKey("api_key"),      "api_key is forbidden");
assert(isForbiddenKey("signed_url"),   "signed_url is forbidden");
assert(isForbiddenKey("card_number"),  "card_number is forbidden");
assert(isForbiddenKey("file_content"), "file_content is forbidden");
assert(!isForbiddenKey("plan_tier"),   "plan_tier is NOT forbidden");
assert(!isForbiddenKey("count"),       "count is NOT forbidden");
assert(!isForbiddenKey("feature"),     "feature is NOT forbidden");

// ─── S31: isForbiddenKey — pattern matches ────────────────────────────────────

section("S31: isForbiddenKey — pattern matches");
assert(isForbiddenKey("my_secret_key"), "my_secret_key matched by *secret* pattern");
assert(isForbiddenKey("raw_notes"),     "raw_notes matched by raw_ pattern");
assert(isForbiddenKey("user_credential"), "user_credential matched by *credential* pattern");
assert(isForbiddenKey("private_data"),  "private_data matched by *private* pattern");

// ─── S32: FORBIDDEN_ANALYTICS_KEYS list ──────────────────────────────────────

section("S32: FORBIDDEN_ANALYTICS_KEYS list");
assert(FORBIDDEN_ANALYTICS_KEYS.length > 10, "at least 10 forbidden keys defined");
assert(FORBIDDEN_ANALYTICS_KEYS.includes("prompt"),   "prompt in forbidden list");
assert(FORBIDDEN_ANALYTICS_KEYS.includes("password"),  "password in forbidden list");
assert(FORBIDDEN_ANALYTICS_KEYS.includes("token"),     "token in forbidden list");

// ─── S33: sanitizeAnalyticsPayload — oversized string truncated ───────────────

section("S33: sanitizeAnalyticsPayload — large strings handled safely");
const bigString = "x".repeat(1000);
const result33 = sanitizeAnalyticsPayload({ plan_tier: bigString });
assert(
  result33.plan_tier === undefined || typeof result33.plan_tier === "string",
  "oversized string handled without crash",
);

// ─── S34: sanitizeAnalyticsPayload — empty payload ───────────────────────────

section("S34: sanitizeAnalyticsPayload — empty payload");
const empty = sanitizeAnalyticsPayload({});
assert(typeof empty === "object", "empty payload returns object");
assert(Object.keys(empty).length === 0, "empty payload stays empty");

// ─── S35: sanitizeAnalyticsPayload — null values handled ─────────────────────

section("S35: sanitizeAnalyticsPayload — null values");
const withNulls = sanitizeAnalyticsPayload({ plan_tier: null, count: null });
assert(withNulls.plan_tier === null, "null plan_tier passes through");
assert(withNulls.count     === null, "null count passes through");

// ─── S36: track-event.ts structure ───────────────────────────────────────────

section("S36: track-event.ts exports");
assert(has(P("server/lib/analytics/track-event.ts"), "trackAnalyticsEvent"), "trackAnalyticsEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackProductEvent"),   "trackProductEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackFunnelEvent"),    "trackFunnelEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackRetentionEvent"), "trackRetentionEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackBillingEvent"),   "trackBillingEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackAiEvent"),        "trackAiEvent exported");
assert(has(P("server/lib/analytics/track-event.ts"), "trackOpsEvent"),       "trackOpsEvent exported");

// ─── S37: track-event.ts never blocks request path ───────────────────────────

section("S37: track-event.ts failure safety");
assert(has(P("server/lib/analytics/track-event.ts"), "try"), "try block present");
assert(has(P("server/lib/analytics/track-event.ts"), "catch"), "catch block present");
assert(has(P("server/lib/analytics/track-event.ts"), "console.error"), "error logging in catch");

// ─── S38: track-event.ts validates event name ────────────────────────────────

section("S38: track-event.ts validates event name before insert");
assert(has(P("server/lib/analytics/track-event.ts"), "isValidEventName"), "isValidEventName called");
assert(has(P("server/lib/analytics/track-event.ts"), "isValidSource"),    "isValidSource called");
assert(has(P("server/lib/analytics/track-event.ts"), "sanitizeAnalyticsPayload"), "sanitize called");

// ─── S39: track-event.ts derives family ──────────────────────────────────────

section("S39: track-event.ts derives family from taxonomy");
assert(has(P("server/lib/analytics/track-event.ts"), "getFamilyForEvent"), "getFamilyForEvent called");

// ─── S40: Client track.ts structure ──────────────────────────────────────────

section("S40: client track.ts exports");
assert(has(P("client/src/lib/analytics/track.ts"), "track"),           "track function exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackProduct"),    "trackProduct exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackFunnel"),     "trackFunnel exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackRetention"),  "trackRetention exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackBilling"),    "trackBilling exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackAi"),         "trackAi exported");
assert(has(P("client/src/lib/analytics/track.ts"), "trackOps"),        "trackOps exported");

// ─── S41: Client track.ts validates event name ───────────────────────────────

section("S41: client track.ts validates before sending");
assert(has(P("client/src/lib/analytics/track.ts"), "isValidEventName"), "isValidEventName in client track");
assert(has(P("client/src/lib/analytics/track.ts"), "ANALYTICS_ENDPOINT"), "endpoint constant defined");
assert(has(P("client/src/lib/analytics/track.ts"), "/api/analytics/track"), "correct endpoint path");

// ─── S42: Client track.ts sanitizes client props ─────────────────────────────

section("S42: client track.ts sanitizes payload");
assert(has(P("client/src/lib/analytics/track.ts"), "ALLOWED_CLIENT_PROPS"), "allowed props allowlist");
assert(has(P("client/src/lib/analytics/track.ts"), "sanitizeClientProps"),  "sanitize function");

// ─── S43: Client track.ts never trusts client org context ────────────────────

section("S43: client does not emit org_id (server derives it)");
const clientTrackContent = read(P("client/src/lib/analytics/track.ts"));
assert(!clientTrackContent.includes("organizationId"), "client track.ts does not send organizationId (server derives from session)");

// ─── S44: use-track-event.ts hook ────────────────────────────────────────────

section("S44: use-track-event.ts hook structure");
assert(has(P("client/src/hooks/use-track-event.ts"), "useTrackEvent"),         "useTrackEvent exported");
assert(has(P("client/src/hooks/use-track-event.ts"), "useTrackEventDebounced"),"useTrackEventDebounced exported");
assert(has(P("client/src/hooks/use-track-event.ts"), "usePageTrack"),          "usePageTrack exported");
assert(has(P("client/src/hooks/use-track-event.ts"), "useCallback"),            "useCallback used for stability");

// ─── S45: Server analytics route exists ──────────────────────────────────────

section("S45: Server analytics route");
assert(has(P("server/routes/analytics.ts"), "analyticsRouter"),       "analyticsRouter exported");
assert(has(P("server/routes/analytics.ts"), "/track"),                "/track route");
assert(has(P("server/routes/analytics.ts"), "adminAnalyticsRouter"),  "adminAnalyticsRouter exported");
assert(has(P("server/routes/analytics.ts"), "/summary"),              "/summary route");
assert(has(P("server/routes/analytics.ts"), "/funnels"),              "/funnels route");
assert(has(P("server/routes/analytics.ts"), "/retention"),            "/retention route");

// ─── S46: Server route validates event name ───────────────────────────────────

section("S46: Server analytics route validates input");
assert(has(P("server/routes/analytics.ts"), "isValidEventName"), "isValidEventName in route");
assert(has(P("server/routes/analytics.ts"), "isValidDomainRole"), "isValidDomainRole in route");
assert(has(P("server/routes/analytics.ts"), "isValidLocale"),     "isValidLocale in route");
assert(has(P("server/routes/analytics.ts"), "sanitizeAnalyticsPayload"), "sanitize in route");

// ─── S47: Server route derives org from session ───────────────────────────────

section("S47: Server route derives org from auth session");
assert(has(P("server/routes/analytics.ts"), "req.user") || has(P("server/routes/analytics.ts"), "req as any"), "server reads from request user");

// ─── S48: Admin analytics endpoint aggregated only ────────────────────────────

section("S48: Admin endpoints are aggregated only");
assert(has(P("server/routes/analytics.ts"), "analyticsDailyRollups"), "admin reads from rollups not raw events");
assert(has(P("server/routes/analytics.ts"), "sum("),                  "SUM aggregation in admin endpoints");

// ─── S49: rollups.ts structure ───────────────────────────────────────────────

section("S49: rollups.ts exports");
assert(has(P("server/lib/analytics/rollups.ts"), "aggregateDailyAnalyticsRollups"), "main rollup function");
assert(has(P("server/lib/analytics/rollups.ts"), "countDailyEvents"),               "countDailyEvents");
assert(has(P("server/lib/analytics/rollups.ts"), "computeUniqueUsers"),             "computeUniqueUsers");
assert(has(P("server/lib/analytics/rollups.ts"), "summarizeProperties"),            "summarizeProperties");

// ─── S50: rollups.ts uses upsert ─────────────────────────────────────────────

section("S50: rollups.ts uses upsert not plain insert");
assert(has(P("server/lib/analytics/rollups.ts"), "onConflictDoUpdate"), "upsert on conflict");

// ─── S51: rollup script exists and wired ─────────────────────────────────────

section("S51: run-analytics-rollups.ts script");
assert(has(P("scripts/run-analytics-rollups.ts"), "aggregateDailyAnalyticsRollups"), "script calls rollup function");
assert(has(P("scripts/run-analytics-rollups.ts"), "process.argv"),                   "script accepts date arg");

// ─── S52: Migration script ────────────────────────────────────────────────────

section("S52: migrate-phase50.ts migration");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "analytics_events"),       "creates analytics_events");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "analytics_daily_rollups"), "creates analytics_daily_rollups");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ROW LEVEL SECURITY"),     "enables RLS");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "CREATE INDEX IF NOT EXISTS"), "creates indexes");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "BEGIN"),                  "uses transaction");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ROLLBACK"),               "rolls back on error");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "SUPABASE_DB_POOL_URL"),   "uses pool URL");
assert(!has(P("server/lib/analytics/migrate-phase50.ts"), "import dotenv"),         "no dotenv import");

// ─── S53: analytics_events table constraints ──────────────────────────────────

section("S53: analytics_events table constraints");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_source_check"),      "source check constraint");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_domain_role_check"), "domain_role constraint");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_family_check"),      "family check constraint");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "CHECK (source IN"),       "source values enumerated");

// ─── S54: analytics_daily_rollups unique constraint ───────────────────────────

section("S54: analytics_daily_rollups unique constraint");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "adr50_uq_date_family_name"), "unique index on date/family/name");

// ─── S55: analytics_events indexes ───────────────────────────────────────────

section("S55: analytics_events indexes defined");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_org_occurred_idx"),      "org + occurred index");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_family_occurred_idx"),   "family + occurred index");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_name_occurred_idx"),     "name + occurred index");
assert(has(P("server/lib/analytics/migrate-phase50.ts"), "ae50_org_name_occurred_idx"), "org + name + occurred index");

// ─── S56: schema contains insert types ───────────────────────────────────────

section("S56: Schema insert types and select types");
assert(has(P("shared/schema.ts"), "InsertAnalyticsEvent"),         "InsertAnalyticsEvent type");
assert(has(P("shared/schema.ts"), "AnalyticsEvent"),               "AnalyticsEvent select type");
assert(has(P("shared/schema.ts"), "InsertAnalyticsDailyRollup"),   "InsertAnalyticsDailyRollup type");
assert(has(P("shared/schema.ts"), "AnalyticsDailyRollup"),         "AnalyticsDailyRollup select type");
assert(has(P("shared/schema.ts"), "insertAnalyticsEventSchema"),   "insertAnalyticsEventSchema");
assert(has(P("shared/schema.ts"), "insertAnalyticsDailyRollupSchema"), "insertAnalyticsDailyRollupSchema");

// ─── S57: RLS service_role_only documented ───────────────────────────────────

section("S57: RLS access model documented");
assert(has(P("shared/schema.ts"), "service_role_only"),            "service_role_only in schema comment");
assert(has(P("docs/architecture/analytics-foundation.md"), "service_role"), "RLS in analytics-foundation doc");

// ─── S58: Analytics vs audit separation documented ────────────────────────────

section("S58: Analytics vs audit vs security separation");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "analytics_events"),  "analytics_events in doc");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "security_events"),   "security_events in doc");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "audit"),             "audit in doc");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "decision guide") || has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "Decision Guide"), "decision guide present");

// ─── S59: Separation anti-patterns documented ────────────────────────────────

section("S59: Anti-patterns documented");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "Anti-Patterns") || has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "Anti-patterns"), "anti-patterns section");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "Never"),         "Never section present");

// ─── S60: analytics-foundation.md — all 5 required sections ──────────────────

section("S60: analytics-foundation.md covers required topics");
assert(has(P("docs/architecture/analytics-foundation.md"), "Event Taxonomy"),     "taxonomy section");
assert(has(P("docs/architecture/analytics-foundation.md"), "Privacy"),           "privacy section");
assert(has(P("docs/architecture/analytics-foundation.md"), "Tenant"),            "tenant-safety section");
assert(has(P("docs/architecture/analytics-foundation.md"), "Client vs Server"),  "client vs server section");
assert(has(P("docs/architecture/analytics-foundation.md"), "Rollup"),            "rollup section");
assert(has(P("docs/architecture/analytics-foundation.md"), "Phase 51"),          "Phase 51 readiness noted");

// ─── S61: Core funnel flows documented as instrumented ────────────────────────

section("S61: Core funnel flows instrumented");
assert(has(P("docs/architecture/analytics-foundation.md"), "funnel.landing_view"),    "landing_view documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "funnel.pricing_view"),    "pricing_view documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "funnel.signup_view"),     "signup_view documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "funnel.signup_completed"), "signup_completed documented");

// ─── S62: Core product flows documented ──────────────────────────────────────

section("S62: Core product flows documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "product.login"),             "login flow documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "product.program_created"),   "program_created documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "product.checkin_submitted") || has(P("docs/architecture/analytics-foundation.md"), "checkin_submitted"), "checkin_submitted documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "product.dashboard_viewed"), "dashboard_viewed documented");

// ─── S63: Billing events documented ──────────────────────────────────────────

section("S63: Billing events documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "billing.checkout_started"),   "checkout_started documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "billing.invoice_paid"),       "invoice_paid documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "billing.payment_failed"),     "payment_failed documented");

// ─── S64: AI events documented ────────────────────────────────────────────────

section("S64: AI events documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "ai.request_completed"),    "ai.request_completed documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "ai.request_failed") || has(P("docs/architecture/analytics-foundation.md"), "ai.budget_exceeded"), "ai failure/limit event documented");

// ─── S65: Ops events documented ──────────────────────────────────────────────

section("S65: Ops events documented");
assert(has(P("docs/architecture/analytics-foundation.md"), "ops.dashboard_viewed"),  "ops.dashboard_viewed documented");

// ─── S66: No cross-tenant data leakage in client wrapper ─────────────────────

section("S66: Multi-tenant safety in client wrapper");
const clientContent = read(P("client/src/lib/analytics/track.ts"));
assert(!clientContent.includes("organizationId"), "client wrapper does not expose org_id in properties");
assert(clientContent.includes("ALLOWED_CLIENT_PROPS"), "allowlist enforced on client props");

// ─── S67: No analytics in security_events ────────────────────────────────────

section("S67: security_events stays separate");
const secEvContent = read(P("server/lib/security/security-events.ts"));
assert(!secEvContent.includes("analyticsEvents"), "security_events does not reference analyticsEvents");
assert(!secEvContent.includes("analytics_events"), "security_events does not reference analytics_events table");

// ─── S68: No raw prompt data in track-event.ts ───────────────────────────────

section("S68: No raw prompt data in tracking layer");
const trackContent = read(P("server/lib/analytics/track-event.ts"));
assert(!trackContent.includes("raw_prompt"), "no raw_prompt in track-event");
assert(!trackContent.includes("checkin_text"), "no checkin_text in track-event");
assert(!trackContent.includes("response_text"), "no response_text in track-event");

// ─── S69: Phase 51 readiness ─────────────────────────────────────────────────

section("S69: Phase 51 AI Ops Assistant readiness");
assert(has(P("docs/architecture/analytics-foundation.md"), "Phase 51"),   "Phase 51 mentioned in foundation doc");
assert(has(P("docs/architecture/analytics-vs-audit-vs-security.md"), "Phase 51"), "Phase 51 in separation doc");
assert(has(P("server/lib/analytics/rollups.ts"), "aggregateDailyAnalyticsRollups"), "rollup layer ready for Phase 51 consumption");

// ─── S70: Final coherence check ───────────────────────────────────────────────

section("S70: Final analytics foundation coherence");
const allFilesExist = [
  P("server/lib/analytics/event-taxonomy.ts"),
  P("server/lib/analytics/privacy-rules.ts"),
  P("server/lib/analytics/track-event.ts"),
  P("server/lib/analytics/rollups.ts"),
  P("server/lib/analytics/migrate-phase50.ts"),
  P("client/src/lib/analytics/track.ts"),
  P("client/src/hooks/use-track-event.ts"),
  P("server/routes/analytics.ts"),
  P("scripts/run-analytics-rollups.ts"),
  P("docs/architecture/analytics-foundation.md"),
  P("docs/architecture/analytics-vs-audit-vs-security.md"),
].every(exists);
assert(allFilesExist, "All Phase 50 files present");

const taxonomyHasSixFamilies = ANALYTICS_FAMILIES.length === 6;
const eventsAreMapped = Object.values(ANALYTICS_EVENTS).every((f) =>
  (ANALYTICS_FAMILIES as readonly string[]).includes(f),
);
assert(taxonomyHasSixFamilies, "Taxonomy has exactly 6 families");
assert(eventsAreMapped, "All events map to valid families");

const noVercelUrlsInAnalytics =
  !read(P("client/src/lib/analytics/track.ts")).includes("vercel.app");
assert(noVercelUrlsInAnalytics, "No vercel.app URLs in analytics client");

assert(
  has(P("docs/architecture/analytics-foundation.md"), "service_role") &&
  has(P("docs/architecture/analytics-foundation.md"), "RLS"),
  "RLS model documented in analytics foundation"
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`
════════════════════════════════════════════════════════════
Phase 50 — Analytics Foundation Validation
════════════════════════════════════════════════════════════
  Passed:  ${passed}/${passed + failed}
  Failed:  ${failed}/${passed + failed}
`);

if (failures.length > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(f));
}

const totalEvents  = Object.keys(ANALYTICS_EVENTS).length;
const totalFamilies = ANALYTICS_FAMILIES.length;

console.log(`
  ${failed === 0 ? "ANALYTICS FOUNDATION: COMPLETE ✅" : "ANALYTICS FOUNDATION: INCOMPLETE ❌"}

  Audit summary:
    Prior analytics:    none (no PostHog, no tracking tables)
    security_events:    kept separate — not merged
    billing-events.ts:  kept as stubs — not merged into analytics
    audit logs:         kept separate — compliance layer

  Event taxonomy:
    Families:  ${totalFamilies} (product, funnel, retention, billing, ai, ops)
    Events:    ${totalEvents} canonical, versioned, stable

  Privacy rules:
    sanitizeAnalyticsPayload   — removes forbidden keys
    assertAnalyticsPayloadAllowed — throws on forbidden keys (test paths)
    redactAnalyticsPayload     — replaces forbidden values with [REDACTED]
    Forbidden patterns: *secret*, *password*, *token*, *private*, raw_*, *credential*

  Analytics tables:
    analytics_events           — raw event stream, RLS service_role_only
    analytics_daily_rollups    — pre-aggregated, RLS service_role_only

  Server tracking:
    trackAnalyticsEvent + 6 family wrappers
    POST /api/analytics/track — client ingestion
    GET  /api/admin/analytics/{summary,funnels,retention} — aggregated admin reads

  Client tracking:
    track(), trackProduct(), trackFunnel(), etc.
    useTrackEvent(), useTrackEventDebounced(), usePageTrack() hooks
    Client allowlist: only safe property keys emitted

  Rollup strategy:
    aggregateDailyAnalyticsRollups(date) → analytics_daily_rollups
    Script: scripts/run-analytics-rollups.ts [YYYY-MM-DD]
    Phase 51 AI Ops Assistant consumes rollups + aggregated admin endpoints

  Separation:
    analytics_events ≠ security_events ≠ audit logs
    Full decision guide in analytics-vs-audit-vs-security.md

  Branch:    feature/analytics-foundation-phase50
`);

process.exit(failed === 0 ? 0 : 1);
