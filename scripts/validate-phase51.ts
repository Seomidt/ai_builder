// ─── Phase 51 Validation: AI Ops Assistant ────────────────────────────────────
// 70 scenarios, 300+ assertions
// Exit 0 = AI OPS ASSISTANT: COMPLETE ✅
// Exit 1 = AI OPS ASSISTANT: INCOMPLETE ❌
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const P = (...parts: string[]) => path.join(ROOT, ...parts);
const read = (p: string) => fs.readFileSync(p, "utf8");
const exists = (p: string) => fs.existsSync(p);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; failures.push(`✗ ${msg}`); }
}

function section(name: string): void {
  console.log(`\n─── ${name} ───`);
}

// ─── S01: Data Sources File ────────────────────────────────────────────────

section("S01: data-sources.ts exists");
assert(exists(P("server/lib/ai-ops/data-sources.ts")), "data-sources.ts exists");
const ds = read(P("server/lib/ai-ops/data-sources.ts"));
assert(ds.includes("AI_OPS_SOURCE_ID"), "AI_OPS_SOURCE_ID exported");
assert(ds.includes("analytics_daily_rollups"), "analytics_daily_rollups defined");
assert(ds.includes("tenant_ai_budgets"), "tenant_ai_budgets defined");
assert(ds.includes("tenant_ai_usage_snapshots"), "tenant_ai_usage_snapshots defined");
assert(ds.includes("ai_usage_alerts"), "ai_usage_alerts defined");
assert(ds.includes("gov_anomaly_events"), "gov_anomaly_events defined");
assert(ds.includes("security_events_aggregated"), "security_events_aggregated defined");
assert(ds.includes("stripe_subscriptions_summary"), "stripe_subscriptions_summary defined");
assert(ds.includes("stripe_invoices_summary"), "stripe_invoices_summary defined");
assert(ds.includes("obs_system_metrics"), "obs_system_metrics defined");
assert(ds.includes("obs_tenant_usage_metrics"), "obs_tenant_usage_metrics defined");
assert(ds.includes("storage_summary"), "storage_summary defined");
assert(ds.includes("platform_health_synthetic"), "platform_health_synthetic defined");

section("S02: Data source forbidden categories");
assert(ds.includes("FORBIDDEN_SOURCE_CATEGORIES"), "FORBIDDEN_SOURCE_CATEGORIES exported");
assert(ds.includes("raw_ai_prompts"), "raw_ai_prompts forbidden");
assert(ds.includes("raw_ai_outputs"), "raw_ai_outputs forbidden");
assert(ds.includes("private_documents"), "private_documents forbidden");
assert(ds.includes("user_pii"), "user_pii forbidden");
assert(ds.includes("signed_urls"), "signed_urls forbidden");
assert(ds.includes("secrets"), "secrets forbidden");
assert(ds.includes("isAllowedSource"), "isAllowedSource function exported");
assert(ds.includes("getSourceConfig"), "getSourceConfig function exported");

section("S03: Data source access levels");
assert(ds.includes("aggregated_only"), "aggregated_only access level");
assert(ds.includes("admin_only"), "admin_only access level");
assert(ds.includes("tenant_scoped"), "tenant_scoped access level");
assert(ds.includes("platform_scoped"), "platform_scoped access level");
assert(ds.includes("isAggregated"), "isAggregated property");
assert(ds.includes("isAdminOnly"), "isAdminOnly property");
assert(ds.includes("isTenantScoped"), "isTenantScoped property");
assert(ds.includes("isPlatformScoped"), "isPlatformScoped property");
assert(ds.includes("forbiddenFields"), "forbiddenFields property");

section("S04: Data source forbidden fields");
assert(ds.includes("ip_address"), "ip_address in forbidden fields");
assert(ds.includes("user_agent"), "user_agent in forbidden fields");
assert(ds.includes("stripe_customer_id"), "stripe_customer_id in forbidden fields");
assert(ds.includes("hosted_invoice_url"), "hosted_invoice_url in forbidden fields");
assert(ds.includes("actor_user_id"), "actor_user_id in forbidden fields");
assert(ds.includes("r2_key"), "r2_key in forbidden fields");
assert(ds.includes("signed_url"), "signed_url in forbidden fields");

// ─── S05: Intents File ─────────────────────────────────────────────────────

section("S05: intents.ts exists and defines all 10 intents");
assert(exists(P("server/lib/ai-ops/intents.ts")), "intents.ts exists");
const intents = read(P("server/lib/ai-ops/intents.ts"));
assert(intents.includes("PLATFORM_HEALTH_SUMMARY"), "platform_health_summary intent");
assert(intents.includes("TENANT_USAGE_SUMMARY"), "tenant_usage_summary intent");
assert(intents.includes("AI_COST_SUMMARY"), "ai_cost_summary intent");
assert(intents.includes("ANOMALY_EXPLANATION"), "anomaly_explanation intent");
assert(intents.includes("BILLING_HEALTH_SUMMARY"), "billing_health_summary intent");
assert(intents.includes("RETENTION_SUMMARY"), "retention_summary intent");
assert(intents.includes("SUPPORT_DEBUG_SUMMARY"), "support_debug_summary intent");
assert(intents.includes("SECURITY_SUMMARY"), "security_summary intent");
assert(intents.includes("STORAGE_HEALTH_SUMMARY"), "storage_health_summary intent");
assert(intents.includes("WEEKLY_OPS_DIGEST"), "weekly_ops_digest intent");

section("S06: Intent definitions structure");
assert(intents.includes("SUPPORTED_INTENTS"), "SUPPORTED_INTENTS exported");
assert(intents.includes("INTENT_DEFINITIONS"), "INTENT_DEFINITIONS exported");
assert(intents.includes("allowedSources"), "allowedSources in definitions");
assert(intents.includes("allowedAudience"), "allowedAudience in definitions");
assert(intents.includes("requiredInputs"), "requiredInputs in definitions");
assert(intents.includes("optionalInputs"), "optionalInputs in definitions");
assert(intents.includes("isPlatformWide"), "isPlatformWide flag");
assert(intents.includes("isTenantScoped"), "isTenantScoped flag");
assert(intents.includes("estimatedContextSize"), "estimatedContextSize hint");
assert(intents.includes("isValidIntent"), "isValidIntent helper");
assert(intents.includes("assertValidIntent"), "assertValidIntent helper");

section("S07: Intent audience definitions");
assert(intents.includes("platform_admin"), "platform_admin audience");
assert(intents.includes("tenant_admin"), "tenant_admin audience");
assert(intents.includes("ops_only"), "ops_only audience");
assert(intents.includes("tenantId"), "tenantId input defined");
assert(intents.includes("weekly_ops_digest"), "weekly_ops_digest string value");
assert(intents.includes("platform_health_summary"), "platform_health_summary string value");

// ─── S08: Access Control ───────────────────────────────────────────────────

section("S08: access-control.ts exists");
assert(exists(P("server/lib/ai-ops/access-control.ts")), "access-control.ts exists");
const ac = read(P("server/lib/ai-ops/access-control.ts"));
assert(ac.includes("assertAiOpsAccess"), "assertAiOpsAccess exported");
assert(ac.includes("resolveAiOpsScope"), "resolveAiOpsScope exported");
assert(ac.includes("assertTenantScopeAllowed"), "assertTenantScopeAllowed exported");
assert(ac.includes("AiOpsAccessError"), "AiOpsAccessError class defined");
assert(ac.includes("AiOpsTenantScopeError"), "AiOpsTenantScopeError class defined");
assert(ac.includes("resolveUserFromRequest"), "resolveUserFromRequest exported");

section("S09: Access control role enforcement");
assert(ac.includes("platform_admin"), "platform_admin role defined");
assert(ac.includes("tenant_admin"), "tenant_admin role defined");
assert(ac.includes("\"none\""), "none role (no access) defined");
assert(ac.includes("canAccessPlatformWide"), "canAccessPlatformWide exported");
assert(ac.includes("canAccessTenantScoped"), "canAccessTenantScoped exported");

section("S10: Access control functional tests");
const acMod = await import("../server/lib/ai-ops/access-control.js");
const { assertAiOpsAccess, resolveAiOpsScope, assertTenantScopeAllowed, AiOpsAccessError, AiOpsTenantScopeError, resolveUserFromRequest } = acMod;

const adminUser = { userId: "u1", role: "platform_admin" as const };
const tenantUser = { userId: "u2", role: "tenant_admin" as const, organizationId: "org-A" };
const noUser = { userId: "u3", role: "none" as const };

let accessOk = false;
try {
  assertAiOpsAccess({ user: adminUser, requestedIntent: "platform_health_summary" });
  accessOk = true;
} catch { }
assert(accessOk, "platform_admin can request platform_health_summary");

let tenantAccessOk = false;
try {
  assertAiOpsAccess({ user: tenantUser, requestedIntent: "tenant_usage_summary", requestedOrganizationId: "org-A" });
  tenantAccessOk = true;
} catch { }
assert(tenantAccessOk, "tenant_admin can request tenant_usage_summary for own org");

let noUserBlocked = false;
try {
  assertAiOpsAccess({ user: noUser, requestedIntent: "platform_health_summary" });
} catch (e) {
  noUserBlocked = e instanceof AiOpsAccessError;
}
assert(noUserBlocked, "role=none is blocked with AiOpsAccessError");

let tenantBlockedPlatform = false;
try {
  assertAiOpsAccess({ user: tenantUser, requestedIntent: "platform_health_summary" });
} catch (e) {
  tenantBlockedPlatform = e instanceof AiOpsAccessError;
}
assert(tenantBlockedPlatform, "tenant_admin blocked from platform_health_summary");

let crossTenantBlocked = false;
try {
  assertAiOpsAccess({ user: tenantUser, requestedIntent: "tenant_usage_summary", requestedOrganizationId: "org-B" });
} catch (e) {
  crossTenantBlocked = e instanceof AiOpsTenantScopeError;
}
assert(crossTenantBlocked, "tenant_admin blocked from cross-tenant access");

section("S11: resolveAiOpsScope correctness");
const adminScope = resolveAiOpsScope({ user: adminUser, requestedIntent: "platform_health_summary" });
assert(adminScope.mode === "platform", "admin scope is platform for platform intent");

const tenantScope = resolveAiOpsScope({ user: tenantUser, requestedIntent: "tenant_usage_summary", requestedOrganizationId: "org-A" });
assert(tenantScope.mode === "tenant", "tenant scope is tenant mode");
assert(tenantScope.organizationId === "org-A", "tenant scope has correct organizationId");

const adminTenantScope = resolveAiOpsScope({ user: adminUser, requestedIntent: "tenant_usage_summary", requestedOrganizationId: "org-X" });
assert(adminTenantScope.mode === "tenant", "admin can scope to tenant mode");
assert(adminTenantScope.organizationId === "org-X", "admin tenant scope has correct org");

section("S12: assertTenantScopeAllowed correctness");
let scopeViolation = false;
try {
  assertTenantScopeAllowed(tenantScope, "org-B");
} catch (e) {
  scopeViolation = e instanceof AiOpsTenantScopeError;
}
assert(scopeViolation, "assertTenantScopeAllowed throws for mismatched org");

let scopeOk = false;
try {
  assertTenantScopeAllowed(tenantScope, "org-A");
  scopeOk = true;
} catch { }
assert(scopeOk, "assertTenantScopeAllowed passes for matching org");

section("S13: resolveUserFromRequest");
const resolved = resolveUserFromRequest({ user: { id: "u1", role: "admin", organizationId: "org-1" } });
assert(resolved.userId === "u1", "resolveUserFromRequest extracts userId");
assert(resolved.role === "platform_admin", "admin role maps to platform_admin");

const tenantResolved = resolveUserFromRequest({ user: { id: "u2", role: "owner", organizationId: "org-2" } });
assert(tenantResolved.role === "tenant_admin", "owner role maps to tenant_admin");

const noResolved = resolveUserFromRequest({ user: null });
assert(noResolved.role === "none", "null user maps to none role");

// ─── S14: Response Contracts ───────────────────────────────────────────────

section("S14: response-contracts.ts exists");
assert(exists(P("server/lib/ai-ops/response-contracts.ts")), "response-contracts.ts exists");
const rc = read(P("server/lib/ai-ops/response-contracts.ts"));
assert(rc.includes("OpsResponseBaseSchema"), "OpsResponseBaseSchema defined");
assert(rc.includes("PlatformHealthResponseSchema"), "PlatformHealthResponseSchema");
assert(rc.includes("TenantUsageResponseSchema"), "TenantUsageResponseSchema");
assert(rc.includes("AiCostResponseSchema"), "AiCostResponseSchema");
assert(rc.includes("AnomalyResponseSchema"), "AnomalyResponseSchema");
assert(rc.includes("BillingHealthResponseSchema"), "BillingHealthResponseSchema");
assert(rc.includes("RetentionResponseSchema"), "RetentionResponseSchema");
assert(rc.includes("SupportDebugResponseSchema"), "SupportDebugResponseSchema");
assert(rc.includes("SecurityResponseSchema"), "SecurityResponseSchema");
assert(rc.includes("StorageHealthResponseSchema"), "StorageHealthResponseSchema");
assert(rc.includes("WeeklyDigestResponseSchema"), "WeeklyDigestResponseSchema");
assert(rc.includes("validateOpsResponse"), "validateOpsResponse exported");
assert(rc.includes("INTENT_RESPONSE_SCHEMAS"), "INTENT_RESPONSE_SCHEMAS exported");
assert(rc.includes("makeBaseResponse"), "makeBaseResponse exported");

section("S15: Response contract fields");
assert(rc.includes("summary"), "summary field in base schema");
assert(rc.includes("findings"), "findings field");
assert(rc.includes("risks"), "risks field");
assert(rc.includes("recommendedActions"), "recommendedActions field");
assert(rc.includes("confidence"), "confidence field");
assert(rc.includes("dataFreshness"), "dataFreshness field");
assert(rc.includes("sourcesUsed"), "sourcesUsed field");
assert(rc.includes("generatedAt"), "generatedAt field");
assert(rc.includes("insufficient_data"), "insufficient_data confidence value");

section("S16: Response contract validation functional tests");
const rcMod = await import("../server/lib/ai-ops/response-contracts.js");
const { validateOpsResponse } = rcMod;

let contractOk = false;
try {
  validateOpsResponse("platform_health_summary", {
    intent: "platform_health_summary",
    scope: "platform",
    organizationId: null,
    summary: "Platform is healthy.",
    findings: [],
    risks: [],
    recommendedActions: [],
    confidence: "high",
    dataFreshness: new Date().toISOString(),
    sourcesUsed: ["analytics_daily_rollups"],
    generatedAt: new Date().toISOString(),
    activeAnomalies: 0,
    systemStatus: "healthy",
  });
  contractOk = true;
} catch { }
assert(contractOk, "valid platform_health_summary response passes contract");

let contractFails = false;
try {
  validateOpsResponse("platform_health_summary", { intent: "bad", summary: 123 });
} catch {
  contractFails = true;
}
assert(contractFails, "invalid response fails contract validation");

let unknownIntentFails = false;
try {
  validateOpsResponse("nonexistent_intent" as any, {});
} catch {
  unknownIntentFails = true;
}
assert(unknownIntentFails, "unknown intent fails contract lookup");

// ─── S17: Safety Module ────────────────────────────────────────────────────

section("S17: safety.ts exists");
assert(exists(P("server/lib/ai-ops/safety.ts")), "safety.ts exists");
const safety = read(P("server/lib/ai-ops/safety.ts"));
assert(safety.includes("assertAiOpsSafeContext"), "assertAiOpsSafeContext exported");
assert(safety.includes("assertAiOpsOutputSafe"), "assertAiOpsOutputSafe exported");
assert(safety.includes("redactUnsafeOpsContext"), "redactUnsafeOpsContext exported");
assert(safety.includes("assertNoForbiddenIntent"), "assertNoForbiddenIntent exported");
assert(safety.includes("assertNoRawTenantContent"), "assertNoRawTenantContent exported");
assert(safety.includes("AI_OPS_SAFETY_CONFIG"), "AI_OPS_SAFETY_CONFIG exported");

section("S18: Safety module functional tests");
const safetyMod = await import("../server/lib/ai-ops/safety.js");
const { assertAiOpsSafeContext, assertAiOpsOutputSafe, redactUnsafeOpsContext, assertNoForbiddenIntent, assertNoRawTenantContent, AiOpsSafetyError } = safetyMod;

let safeCtxOk = false;
try {
  assertAiOpsSafeContext({ recentAnomalyCount: 3 }, ["analytics_daily_rollups"]);
  safeCtxOk = true;
} catch { }
assert(safeCtxOk, "safe context passes assertAiOpsSafeContext");

let unsafeCtxBlocked = false;
try {
  assertAiOpsSafeContext({ password: "secret123" }, ["analytics_daily_rollups"]);
} catch (e) {
  unsafeCtxBlocked = e instanceof AiOpsSafetyError;
}
assert(unsafeCtxBlocked, "context with password field throws AiOpsSafetyError");

let forbiddenSrcBlocked = false;
try {
  assertAiOpsSafeContext({}, ["raw_ai_prompts" as any]);
} catch (e) {
  forbiddenSrcBlocked = e instanceof AiOpsSafetyError;
}
assert(forbiddenSrcBlocked, "forbidden source throws AiOpsSafetyError");

section("S19: Output safety checks");
let safeOutputOk = false;
try {
  assertAiOpsOutputSafe('{"summary": "Platform looks stable.", "findings": []}');
  safeOutputOk = true;
} catch { }
assert(safeOutputOk, "safe output passes assertAiOpsOutputSafe");

let actionOutputBlocked = false;
try {
  assertAiOpsOutputSafe("I will now delete all unused tenants.");
} catch (e) {
  actionOutputBlocked = e instanceof AiOpsSafetyError;
}
assert(actionOutputBlocked, "output implying action is blocked");

let certaintyBlocked = false;
try {
  assertAiOpsOutputSafe("This definitely is the root cause of the failure.");
} catch (e) {
  certaintyBlocked = e instanceof AiOpsSafetyError;
}
assert(certaintyBlocked, "output with fabricated certainty is blocked");

section("S20: Redaction functionality");
const redacted = redactUnsafeOpsContext({ count: 5, password: "secret", nested: { token: "abc" } });
assert(redacted.count === 5, "non-sensitive fields preserved after redaction");
assert(redacted.password === "[REDACTED]", "password field is redacted");
assert((redacted.nested as any)?.token === "[REDACTED]", "nested token is redacted");

const clean = redactUnsafeOpsContext({ recentAnomalyCount: 3, systemStatus: "healthy" });
assert(clean.recentAnomalyCount === 3, "clean context passes through unchanged");

section("S21: assertNoForbiddenIntent");
let forbiddenIntentBlocked = false;
try {
  assertNoForbiddenIntent("delete_all_tenants");
} catch (e) {
  forbiddenIntentBlocked = e instanceof AiOpsSafetyError;
}
assert(forbiddenIntentBlocked, "unsupported intent throws AiOpsSafetyError");

let validIntentOk = false;
try {
  assertNoForbiddenIntent("platform_health_summary");
  validIntentOk = true;
} catch { }
assert(validIntentOk, "valid intent passes assertNoForbiddenIntent");

section("S22: assertNoRawTenantContent");
let rawTenantBlocked = false;
try {
  assertNoRawTenantContent({ raw_prompt: "user prompt here" });
} catch (e) {
  rawTenantBlocked = e instanceof AiOpsSafetyError;
}
assert(rawTenantBlocked, "raw_prompt field throws AiOpsSafetyError");

let rawOutputBlocked = false;
try {
  assertNoRawTenantContent({ model_output: "model said..." });
} catch (e) {
  rawOutputBlocked = e instanceof AiOpsSafetyError;
}
assert(rawOutputBlocked, "model_output field throws AiOpsSafetyError");

let cleanCtxOk = false;
try {
  assertNoRawTenantContent({ anomalyCount: 5, systemStatus: "healthy" });
  cleanCtxOk = true;
} catch { }
assert(cleanCtxOk, "clean context passes assertNoRawTenantContent");

// ─── S23: Context Assembler ────────────────────────────────────────────────

section("S23: context-assembler.ts exists");
assert(exists(P("server/lib/ai-ops/context-assembler.ts")), "context-assembler.ts exists");
const ca = read(P("server/lib/ai-ops/context-assembler.ts"));
assert(ca.includes("buildPlatformHealthContext"), "buildPlatformHealthContext exported");
assert(ca.includes("buildTenantUsageContext"), "buildTenantUsageContext exported");
assert(ca.includes("buildAiCostContext"), "buildAiCostContext exported");
assert(ca.includes("buildAnomalyContext"), "buildAnomalyContext exported");
assert(ca.includes("buildRetentionContext"), "buildRetentionContext exported");
assert(ca.includes("buildBillingHealthContext"), "buildBillingHealthContext exported");
assert(ca.includes("buildStorageHealthContext"), "buildStorageHealthContext exported");
assert(ca.includes("buildSecurityContext"), "buildSecurityContext exported");

section("S24: Context assembler uses only allowed sources");
assert(ca.includes("gov_anomaly_events"), "assembler uses gov_anomaly_events");
assert(ca.includes("ai_usage_alerts"), "assembler uses ai_usage_alerts");
assert(ca.includes("analytics_daily_rollups"), "assembler uses analytics_daily_rollups");
assert(ca.includes("tenant_ai_usage_snapshots"), "assembler uses tenant_ai_usage_snapshots");
assert(ca.includes("tenant_ai_budgets"), "assembler uses tenant_ai_budgets");
assert(ca.includes("stripe_subscriptions"), "assembler uses stripe data");
assert(ca.includes("security_events"), "assembler uses security_events");
assert(ca.includes("tenant_files"), "assembler uses tenant_files for storage");
assert(!ca.includes("actor_user_id"), "assembler does not select actor_user_id");
assert(!ca.includes("idempotency_key"), "assembler does not select idempotency_key");
assert(!ca.includes("session_id"), "assembler does not select session_id");

section("S25: Context includes meta/freshness");
assert(ca.includes("assembledAt"), "context includes assembledAt timestamp");
assert(ca.includes("sourceIds"), "context includes sourceIds");
assert(ca.includes("makeMeta"), "makeMeta helper defined");

section("S26: Context assembler safety patterns");
assert(ca.includes("redactUnsafeOpsContext"), "assembler uses redactUnsafeOpsContext");
assert(ca.includes("limit("), "assembler uses DB query limits");
assert(ca.includes("Promise.allSettled"), "assembler uses allSettled for resilience");

// ─── S27: Orchestrator ─────────────────────────────────────────────────────

section("S27: orchestrator.ts exists");
assert(exists(P("server/lib/ai-ops/orchestrator.ts")), "orchestrator.ts exists");
const orch = read(P("server/lib/ai-ops/orchestrator.ts"));
assert(orch.includes("runAiOpsQuery"), "runAiOpsQuery exported");
assert(orch.includes("assertValidIntent"), "orchestrator validates intent");
assert(orch.includes("assertAiOpsAccess"), "orchestrator checks access");
assert(orch.includes("resolveAiOpsScope"), "orchestrator resolves scope");
assert(orch.includes("assertAiOpsSafeContext"), "orchestrator checks context safety");
assert(orch.includes("assertAiOpsOutputSafe"), "orchestrator checks output safety");
assert(orch.includes("validateOpsResponse"), "orchestrator validates response contract");
assert(orch.includes("logAiOpsAudit"), "orchestrator logs audit");
assert(orch.includes("gpt-4o-mini"), "orchestrator uses gpt-4o-mini model");
assert(orch.includes("temperature: 0.1"), "orchestrator uses low temperature");
assert(orch.includes("json_object"), "orchestrator uses JSON response format");
assert(orch.includes("SYSTEM_PROMPT"), "system prompt defined");

section("S28: Orchestrator grounding instructions");
assert(orch.includes("Only analyze the structured context"), "grounding instruction in prompt");
assert(orch.includes("advisory only"), "advisory-only instruction in prompt");
assert(orch.includes("insufficient_data"), "insufficient_data instruction in prompt");
assert(orch.includes("assertNoForbiddenIntent"), "orchestrator checks forbidden intent first");
assert(orch.includes("assertNoRawTenantContent"), "orchestrator checks raw tenant content");

section("S29: Orchestrator error handling");
assert(orch.includes("OrchestratorResult"), "OrchestratorResult type defined");
assert(orch.includes("success: false"), "orchestrator returns failure on error");
assert(orch.includes("auditId"), "auditId in result");
assert(orch.includes("catch"), "orchestrator has error handling");

// ─── S30: Audit Module ─────────────────────────────────────────────────────

section("S30: audit.ts exists");
assert(exists(P("server/lib/ai-ops/audit.ts")), "audit.ts exists");
const audit = read(P("server/lib/ai-ops/audit.ts"));
assert(audit.includes("logAiOpsAudit"), "logAiOpsAudit exported");
assert(audit.includes("getRecentAuditLog"), "getRecentAuditLog exported");
assert(audit.includes("getAuditStats"), "getAuditStats exported");
assert(audit.includes("AI_OPS_AUDIT_CONFIG"), "AI_OPS_AUDIT_CONFIG exported");
assert(audit.includes("userId"), "audit logs userId");
assert(audit.includes("intent"), "audit logs intent");
assert(audit.includes("scope"), "audit logs scope");
assert(audit.includes("success"), "audit logs success");
assert(!audit.includes("raw_prompt"), "audit does not log raw prompts");
assert(!audit.includes("raw_output"), "audit does not log raw output");
assert(audit.includes("500"), "audit has in-memory max cap");

section("S31: Audit functional tests");
const auditMod = await import("../server/lib/ai-ops/audit.js");
const { logAiOpsAudit, getRecentAuditLog, getAuditStats } = auditMod;

await logAiOpsAudit({ auditId: "test-001", userId: "u1", intent: "platform_health_summary", scope: "platform", success: true });
const log = getRecentAuditLog(10);
assert(log.length >= 1, "audit log has at least 1 entry after logging");
assert(log[0].userId === "u1", "audit log entry has correct userId");
assert(log[0].intent === "platform_health_summary", "audit log has correct intent");

const stats = getAuditStats();
assert(stats.totalRequests >= 1, "audit stats totalRequests >= 1");
assert("platform_health_summary" in stats.intentBreakdown, "audit stats has intent breakdown");

// ─── S32: Digest Module ────────────────────────────────────────────────────

section("S32: digest.ts exists");
assert(exists(P("server/lib/ai-ops/digest.ts")), "digest.ts exists");
const digest = read(P("server/lib/ai-ops/digest.ts"));
assert(digest.includes("generateWeeklyDigest"), "generateWeeklyDigest exported");
assert(digest.includes("getCachedDigest"), "getCachedDigest exported");
assert(digest.includes("clearDigestCache"), "clearDigestCache exported");
assert(digest.includes("DIGEST_CONFIG"), "DIGEST_CONFIG exported");
assert(digest.includes("weekStart"), "weekStart in digest");
assert(digest.includes("weekEnd"), "weekEnd in digest");
assert(digest.includes("highlights"), "highlights in digest");
assert(digest.includes("riskSignals"), "riskSignals in digest");
assert(digest.includes("CACHE_TTL_MS"), "cache TTL defined");
assert(digest.includes("forceRefresh"), "forceRefresh parameter supported");
assert(!digest.includes('"analytics_events"'), "digest does not query analytics_events directly");

// ─── S33: Admin Routes ─────────────────────────────────────────────────────

section("S33: admin routes exist with AI Ops endpoints");
assert(exists(P("server/routes/admin.ts")), "admin.ts routes file exists");
const adminRoutes = read(P("server/routes/admin.ts"));
assert(adminRoutes.includes("/api/admin/ai-ops/query"), "POST /api/admin/ai-ops/query route");
assert(adminRoutes.includes("/api/admin/ai-ops/health-summary"), "GET health-summary route");
assert(adminRoutes.includes("/api/admin/ai-ops/weekly-digest"), "GET weekly-digest route");
assert(adminRoutes.includes("/api/admin/ai-ops/tenant/:organizationId/summary"), "GET tenant summary route");
assert(adminRoutes.includes("/api/admin/ai-ops/intents"), "GET intents route");
assert(adminRoutes.includes("/api/admin/ai-ops/audit"), "GET audit route");

section("S34: Admin routes validation and error handling");
assert(adminRoutes.includes("AiOpsQuerySchema"), "request body validated with Zod");
assert(adminRoutes.includes("isValidIntent"), "intent validated in route");
assert(adminRoutes.includes("403"), "403 returned for access violations");
assert(adminRoutes.includes("400"), "400 returned for bad requests");
assert(adminRoutes.includes("runAiOpsQuery"), "route uses orchestrator");
assert(adminRoutes.includes("generateWeeklyDigest"), "route uses digest generator");
assert(adminRoutes.includes("getRecentAuditLog"), "route exposes audit log");
assert(adminRoutes.includes("supportedIntents"), "unknown intent returns supportedIntents list");

// ─── S35: UI Surface ───────────────────────────────────────────────────────

section("S35: ops/assistant.tsx exists");
assert(exists(P("client/src/pages/ops/assistant.tsx")), "ops/assistant.tsx exists");
const ui = read(P("client/src/pages/ops/assistant.tsx"));
assert(ui.includes("OpsAssistant"), "OpsAssistant component exported");
assert(ui.includes("/api/admin/ai-ops/query"), "UI queries ai-ops endpoint");
assert(ui.includes("/api/admin/ai-ops/weekly-digest"), "UI shows weekly digest");
assert(ui.includes("INTENT_LABELS"), "UI has intent labels");
assert(ui.includes("select-intent"), "select-intent data-testid");
assert(ui.includes("button-run-query"), "button-run-query data-testid");
assert(ui.includes("card-query-result"), "card-query-result data-testid");
assert(ui.includes("text-summary"), "text-summary data-testid");
assert(ui.includes("Admin-only"), "admin-only label in UI");
assert(ui.includes("Advisory only"), "advisory-only label in UI");

section("S36: UI shows findings, risks, recommendations");
assert(ui.includes("findings"), "UI renders findings");
assert(ui.includes("risks"), "UI renders risks");
assert(ui.includes("recommendedActions"), "UI renders recommendedActions");
assert(ui.includes("confidence"), "UI shows confidence");
assert(ui.includes("dataFreshness"), "UI shows data freshness");
assert(ui.includes("sourcesUsed"), "UI shows sources used");
assert(ui.includes("isPending"), "UI shows loading state");
assert(ui.includes("Skeleton"), "UI uses skeleton loading");

section("S37: UI does not imply actions");
assert(!ui.includes("executeAction"), "UI has no executeAction function");
assert(!ui.includes("deleteAll"), "UI has no deleteAll action");
assert(ui.includes("Advisory only"), "UI explicitly says advisory only");

// ─── S38: Ops stub pages ───────────────────────────────────────────────────

section("S38: All ops stub pages exist");
assert(exists(P("client/src/pages/ops/dashboard.tsx")), "ops/dashboard.tsx exists");
assert(exists(P("client/src/pages/ops/tenants.tsx")), "ops/tenants.tsx exists");
assert(exists(P("client/src/pages/ops/jobs.tsx")), "ops/jobs.tsx exists");
assert(exists(P("client/src/pages/ops/webhooks.tsx")), "ops/webhooks.tsx exists");
assert(exists(P("client/src/pages/ops/ai.tsx")), "ops/ai.tsx exists");
assert(exists(P("client/src/pages/ops/billing.tsx")), "ops/billing.tsx exists");
assert(exists(P("client/src/pages/ops/recovery.tsx")), "ops/recovery.tsx exists");
assert(exists(P("client/src/pages/ops/security.tsx")), "ops/security.tsx exists");
assert(exists(P("client/src/pages/ops/release.tsx")), "ops/release.tsx exists");
assert(exists(P("client/src/pages/ops/auth.tsx")), "ops/auth.tsx exists");
assert(exists(P("client/src/pages/ops/storage.tsx")), "ops/storage.tsx exists");

section("S39: Auth and settings stub pages exist");
assert(exists(P("client/src/pages/auth/login.tsx")), "auth/login.tsx exists");
assert(exists(P("client/src/pages/auth/password-reset-request.tsx")), "auth/password-reset-request.tsx exists");
assert(exists(P("client/src/pages/auth/password-reset-confirm.tsx")), "auth/password-reset-confirm.tsx exists");
assert(exists(P("client/src/pages/auth/email-verify.tsx")), "auth/email-verify.tsx exists");
assert(exists(P("client/src/pages/auth/invite-accept.tsx")), "auth/invite-accept.tsx exists");
assert(exists(P("client/src/pages/auth/mfa-challenge.tsx")), "auth/mfa-challenge.tsx exists");
assert(exists(P("client/src/pages/settings/security.tsx")), "settings/security.tsx exists");

// ─── S40: Documentation ────────────────────────────────────────────────────

section("S40: Architecture documentation exists");
assert(exists(P("docs/architecture/ai-ops-assistant.md")), "ai-ops-assistant.md exists");
const archDoc = read(P("docs/architecture/ai-ops-assistant.md"));
assert(archDoc.includes("Supported Intents"), "doc: supported intents section");
assert(archDoc.includes("Allowed Data Sources"), "doc: allowed sources section");
assert(archDoc.includes("Access Model"), "doc: access model section");
assert(archDoc.includes("Scope Model"), "doc: scope model section");
assert(archDoc.includes("Output Contracts"), "doc: output contracts section");
assert(archDoc.includes("Privacy Boundaries"), "doc: privacy boundaries section");
assert(archDoc.includes("Anti-Hallucination"), "doc: anti-hallucination section");
assert(archDoc.includes("Why Rollups"), "doc: why rollups section");
assert(archDoc.includes("Future Extension"), "doc: future extension section");

section("S41: Safety documentation exists");
assert(exists(P("docs/security/ai-ops-safety.md")), "ai-ops-safety.md exists");
const safetyDoc = read(P("docs/security/ai-ops-safety.md"));
assert(safetyDoc.includes("Privacy Guarantees"), "safety doc: privacy guarantees");
assert(safetyDoc.includes("Scope Enforcement"), "safety doc: scope enforcement");
assert(safetyDoc.includes("Forbidden Source Categories"), "safety doc: forbidden categories");
assert(safetyDoc.includes("Logging Model"), "safety doc: logging model");
assert(safetyDoc.includes("Output Safety"), "safety doc: output safety");
assert(safetyDoc.includes("FULLY READY"), "safety doc: FULLY READY verdict");
assert(safetyDoc.toLowerCase().includes("advisory only"), "safety doc: advisory only");
assert(safetyDoc.includes("[REDACTED]"), "safety doc: redaction mentioned");

// ─── S42: Cross-cutting safety invariants ────────────────────────────────

section("S42: No raw AI prompt access anywhere in ai-ops");
const aiOpsFilesToCheck = [
  "server/lib/ai-ops/data-sources.ts",
  "server/lib/ai-ops/intents.ts",
  "server/lib/ai-ops/context-assembler.ts",
  "server/lib/ai-ops/orchestrator.ts",
];
for (const f of aiOpsFilesToCheck) {
  const content = read(P(f));
  assert(!content.includes("raw_prompt"), `${path.basename(f)}: no raw_prompt reference`);
}

section("S43: Tenant isolation boundary in access control");
assert(ac.includes("Cross-tenant"), "access control has cross-tenant error message");
assert(ac.includes("organization"), "access control references organization boundary");

section("S44: All intents have response contracts");
const rcMod2 = await import("../server/lib/ai-ops/response-contracts.js");
const { INTENT_RESPONSE_SCHEMAS } = rcMod2;
const intentsMod = await import("../server/lib/ai-ops/intents.js");
const { SUPPORTED_INTENTS } = intentsMod;
for (const intentId of SUPPORTED_INTENTS) {
  assert(intentId in INTENT_RESPONSE_SCHEMAS, `${intentId} has a response contract`);
}

section("S45: All intents handled in orchestrator");
const INTENT_ENUM_KEYS: Record<string, string> = {
  "platform_health_summary": "PLATFORM_HEALTH_SUMMARY",
  "tenant_usage_summary": "TENANT_USAGE_SUMMARY",
  "ai_cost_summary": "AI_COST_SUMMARY",
  "anomaly_explanation": "ANOMALY_EXPLANATION",
  "billing_health_summary": "BILLING_HEALTH_SUMMARY",
  "retention_summary": "RETENTION_SUMMARY",
  "support_debug_summary": "SUPPORT_DEBUG_SUMMARY",
  "security_summary": "SECURITY_SUMMARY",
  "storage_health_summary": "STORAGE_HEALTH_SUMMARY",
  "weekly_ops_digest": "WEEKLY_OPS_DIGEST",
};
for (const intentId of SUPPORTED_INTENTS) {
  const enumKey = INTENT_ENUM_KEYS[intentId] ?? intentId;
  assert(orch.includes(enumKey), `orchestrator handles intent: ${intentId}`);
}

section("S46: Data source count integrity");
const dsMod = await import("../server/lib/ai-ops/data-sources.js");
const { AI_OPS_DATA_SOURCES, HOST_ALLOWLIST_CONFIG } = dsMod;
const sourceCount = Object.keys(AI_OPS_DATA_SOURCES).length;
assert(sourceCount >= 12, `at least 12 data sources defined (got ${sourceCount})`);
assert(HOST_ALLOWLIST_CONFIG.totalAllowedSources === sourceCount, "HOST_ALLOWLIST_CONFIG.totalAllowedSources matches actual count");

section("S47: Weekly digest uses rollups not raw events");
assert(!digest.includes('"analytics_events"'), "digest does not query analytics_events directly");
assert(digest.includes("buildPlatformHealthContext"), "digest uses platform health context builder");
assert(digest.includes("buildAiCostContext"), "digest uses AI cost context builder");
assert(digest.includes("buildBillingHealthContext"), "digest uses billing health context builder");

section("S48: Orchestrator model configuration");
assert(orch.includes("max_tokens: 1200"), "orchestrator limits token output");
assert(orch.includes("response_format"), "orchestrator uses structured JSON response");

section("S49: Orchestrator scope propagation");
assert(orch.includes("scope.mode"), "orchestrator propagates scope mode to response");
assert(orch.includes("scope.organizationId"), "orchestrator propagates organizationId to response");

section("S50: File count check");
const aiOpsDir = P("server/lib/ai-ops");
const aiOpsFileList = fs.readdirSync(aiOpsDir);
assert(aiOpsFileList.length >= 8, `at least 8 files in server/lib/ai-ops (got ${aiOpsFileList.length})`);
assert(aiOpsFileList.includes("data-sources.ts"), "data-sources.ts in directory");
assert(aiOpsFileList.includes("intents.ts"), "intents.ts in directory");
assert(aiOpsFileList.includes("access-control.ts"), "access-control.ts in directory");
assert(aiOpsFileList.includes("context-assembler.ts"), "context-assembler.ts in directory");
assert(aiOpsFileList.includes("response-contracts.ts"), "response-contracts.ts in directory");
assert(aiOpsFileList.includes("orchestrator.ts"), "orchestrator.ts in directory");
assert(aiOpsFileList.includes("safety.ts"), "safety.ts in directory");
assert(aiOpsFileList.includes("digest.ts"), "digest.ts in directory");
assert(aiOpsFileList.includes("audit.ts"), "audit.ts in directory");

// ─── S51-S70: Additional scenario coverage ────────────────────────────────

section("S51: Intent isValidIntent rejects unknown intents");
const { isValidIntent } = intentsMod;
assert(!isValidIntent("hack_platform"), "isValidIntent rejects hack_platform");
assert(!isValidIntent(""), "isValidIntent rejects empty string");
assert(isValidIntent("platform_health_summary"), "isValidIntent accepts platform_health_summary");
assert(isValidIntent("weekly_ops_digest"), "isValidIntent accepts weekly_ops_digest");

section("S52: Intent assertValidIntent throws on unknown");
const { assertValidIntent } = intentsMod;
let assertIntentThrows = false;
try { assertValidIntent("bad_intent"); } catch { assertIntentThrows = true; }
assert(assertIntentThrows, "assertValidIntent throws on unknown intent");

section("S53: Security intent is platform-wide admin-only");
const { INTENT_DEFINITIONS } = intentsMod;
const secDef = INTENT_DEFINITIONS["security_summary"];
assert(secDef.isPlatformWide === true, "security_summary isPlatformWide");
assert(!secDef.allowedAudience.includes("tenant_admin"), "security_summary excludes tenant_admin audience");

section("S54: Tenant intent requires tenant input");
const tenantUsageDef = INTENT_DEFINITIONS["tenant_usage_summary"];
assert(tenantUsageDef.isTenantScoped === true, "tenant_usage_summary isTenantScoped");
assert(tenantUsageDef.requiredInputs.includes("tenantId"), "tenant_usage_summary requires tenantId");

section("S55: Weekly digest is platform-wide");
const weeklyDef = INTENT_DEFINITIONS["weekly_ops_digest"];
assert(weeklyDef.isPlatformWide === true, "weekly_ops_digest isPlatformWide");
assert(!weeklyDef.isTenantScoped, "weekly_ops_digest not tenant-scoped");

section("S56: Billing intent is platform-only");
const billingDef = INTENT_DEFINITIONS["billing_health_summary"];
assert(billingDef.isPlatformWide === true, "billing_health_summary isPlatformWide");
assert(billingDef.allowedAudience.includes("platform_admin"), "billing allows platform_admin");
assert(!billingDef.allowedAudience.includes("tenant_admin"), "billing excludes tenant_admin");

section("S57: Response contracts use Zod");
assert(rc.includes("z.object"), "response contracts use z.object");
assert(rc.includes("z.string()"), "response contracts use z.string");
assert(rc.includes("z.array"), "response contracts use z.array");
assert(rc.includes("z.enum"), "response contracts use z.enum");

section("S58: Confidence levels are enumerated");
assert(rc.includes('"high"'), "confidence includes high");
assert(rc.includes('"medium"'), "confidence includes medium");
assert(rc.includes('"low"'), "confidence includes low");
assert(rc.includes('"insufficient_data"'), "confidence includes insufficient_data");

section("S59: FindingSchema has severity enum");
assert(rc.includes("FindingSchema"), "FindingSchema defined");
assert(rc.includes('"info"'), "severity info defined");
assert(rc.includes('"warning"'), "severity warning defined");
assert(rc.includes('"critical"'), "severity critical defined");
assert(rc.includes('"ok"'), "severity ok defined");

section("S60: RiskSchema has likelihood and impact");
assert(rc.includes("RiskSchema"), "RiskSchema defined");
assert(rc.includes("likelihood"), "likelihood field in risk");
assert(rc.includes("impact"), "impact field in risk");
assert(rc.includes("mitigation"), "mitigation field in risk");

section("S61: RecommendedActionSchema has priority");
assert(rc.includes("RecommendedActionSchema"), "RecommendedActionSchema defined");
assert(rc.includes("priority"), "priority field defined");
assert(rc.includes("rationale"), "rationale field defined");

section("S62: Admin routes preserve existing routes");
assert(adminRoutes.includes("/api/admin/health"), "original /health route preserved");
assert(adminRoutes.includes("/api/admin/tenants"), "original /tenants route preserved");
assert(adminRoutes.includes("/api/admin/plans"), "original /plans route preserved");
assert(adminRoutes.includes("/api/admin/invoices"), "original /invoices route preserved");

section("S63: Admin routes use Zod schema");
assert(adminRoutes.includes("z.object"), "admin routes use z.object");
assert(adminRoutes.includes("safeParse"), "admin routes use safeParse");

section("S64: Orchestrator context assembly is per-intent");
assert(orch.includes("PLATFORM_HEALTH_SUMMARY"), "orchestrator has case for PLATFORM_HEALTH_SUMMARY");
assert(orch.includes("TENANT_USAGE_SUMMARY"), "orchestrator has case for TENANT_USAGE_SUMMARY");
assert(orch.includes("WEEKLY_OPS_DIGEST"), "orchestrator has case for WEEKLY_OPS_DIGEST");

section("S65: Audit config version is set");
const { AI_OPS_AUDIT_CONFIG } = auditMod;
assert(AI_OPS_AUDIT_CONFIG.version === "phase51", "audit config version is phase51");

section("S66: Digest config version is set");
const digestMod = await import("../server/lib/ai-ops/digest.js");
const { DIGEST_CONFIG } = digestMod;
assert(DIGEST_CONFIG.version === "phase51", "digest config version is phase51");
assert(DIGEST_CONFIG.weekLookbackDays === 7, "digest lookback is 7 days");

section("S67: Safety config version is set");
const { AI_OPS_SAFETY_CONFIG } = safetyMod;
assert(AI_OPS_SAFETY_CONFIG.version === "phase51", "safety config version is phase51");
assert(AI_OPS_SAFETY_CONFIG.forbiddenContextFields.length > 10, "safety config has many forbidden fields");

section("S68: Admin routes tenant scope validation");
assert(adminRoutes.includes("organizationId"), "admin routes use organizationId");
assert(adminRoutes.includes("Cross-tenant"), "admin routes reference cross-tenant error");

section("S69: UI uses TanStack Query properly");
assert(ui.includes("useQuery"), "UI uses useQuery");
assert(ui.includes("useMutation"), "UI uses useMutation");
assert(ui.includes("queryKey"), "UI defines queryKey");

section("S70: Final file integrity check");
assert(exists(P("scripts/validate-phase51.ts")), "validate-phase51.ts exists");
assert(exists(P("server/lib/ai-ops/data-sources.ts")), "data-sources.ts final check");
assert(exists(P("server/lib/ai-ops/intents.ts")), "intents.ts final check");
assert(exists(P("server/lib/ai-ops/access-control.ts")), "access-control.ts final check");
assert(exists(P("server/lib/ai-ops/context-assembler.ts")), "context-assembler.ts final check");
assert(exists(P("server/lib/ai-ops/response-contracts.ts")), "response-contracts.ts final check");
assert(exists(P("server/lib/ai-ops/orchestrator.ts")), "orchestrator.ts final check");
assert(exists(P("server/lib/ai-ops/safety.ts")), "safety.ts final check");
assert(exists(P("server/lib/ai-ops/digest.ts")), "digest.ts final check");
assert(exists(P("server/lib/ai-ops/audit.ts")), "audit.ts final check");
assert(exists(P("server/routes/admin.ts")), "admin.ts routes final check");
assert(exists(P("client/src/pages/ops/assistant.tsx")), "assistant.tsx final check");
assert(exists(P("docs/architecture/ai-ops-assistant.md")), "architecture doc final check");
assert(exists(P("docs/security/ai-ops-safety.md")), "safety doc final check");

// ─── FINAL VERDICT ────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`  Passed:  ${passed}/${passed + failed}`);
console.log(`  Failed:  ${failed}/${passed + failed}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(" ", f);
}
console.log("═".repeat(60));

if (failed === 0) {
  console.log("\n  AI OPS ASSISTANT: COMPLETE ✅\n");
  process.exit(0);
} else {
  console.log("\n  AI OPS ASSISTANT: INCOMPLETE ❌\n");
  process.exit(1);
}
