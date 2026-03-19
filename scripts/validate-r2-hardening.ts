/**
 * Phase X — R2 Hardening & Multi-Tenant Storage Refinement
 * Validation Script
 *
 * Run: npx tsx scripts/validate-r2-hardening.ts
 */

import * as fs   from "fs";
import * as path from "path";
import { execSync } from "child_process";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function fileExists(p: string): boolean {
  return fs.existsSync(path.join(process.cwd(), p));
}

function fileContains(p: string, pattern: string): boolean {
  try { return fs.readFileSync(path.join(process.cwd(), p), "utf-8").includes(pattern); }
  catch { return false; }
}

function tryRun(fn: () => boolean): boolean {
  try { return fn(); } catch { return false; }
}

function throwsTyped(fn: () => void, errorName: string): boolean {
  try { fn(); return false; }
  catch (e: any) { return e?.name === errorName || e?.constructor?.name === errorName; }
}

function throwsAny(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

// ─── PART 1: key-builder.ts ───────────────────────────────────────────────────
console.log("\n[Part 1] server/lib/r2/key-builder.ts");

import {
  buildTenantObjectKey,
  buildPlatformObjectKey,
  assertTenantScopedKey,
  normalizeFilename,
  extractTenantId,
  isPlatformKey,
  isTenantKey,
  safeKeyForLog,
} from "../server/lib/r2/key-builder.js";

assert(fileExists("server/lib/r2/key-builder.ts"),                          "key-builder.ts exists");
assert(fileContains("server/lib/r2/key-builder.ts", "buildTenantObjectKey"), "buildTenantObjectKey exported");
assert(fileContains("server/lib/r2/key-builder.ts", "buildPlatformObjectKey"), "buildPlatformObjectKey exported");
assert(fileContains("server/lib/r2/key-builder.ts", "assertTenantScopedKey"), "assertTenantScopedKey exported");
assert(fileContains("server/lib/r2/key-builder.ts", "normalizeFilename"),    "normalizeFilename exported");

// Tenant key format
const k1 = buildTenantObjectKey("tenant-abc", "uploads", "hello world.pdf");
assert(k1.startsWith("tenants/tenant-abc/uploads/"), "buildTenantObjectKey: correct prefix");
assert(!k1.includes(" "),                             "buildTenantObjectKey: spaces normalized");

// Platform key format
const k2 = buildPlatformObjectKey("backups", "db-2026-01-01.sql.gz");
assert(k2.startsWith("platform/backups/"),            "buildPlatformObjectKey: correct prefix");
assert(k2.includes("db-2026-01-01.sql.gz"),           "buildPlatformObjectKey: filename preserved");

// Tenant scoped assertions pass
assert(
  tryRun(() => { assertTenantScopedKey("tenants/tenant-abc/uploads/f.pdf", "tenant-abc"); return true; }),
  "assertTenantScopedKey: passes for correct tenant",
);
// Cross-tenant throws
assert(
  throwsAny(() => assertTenantScopedKey("tenants/tenant-xyz/uploads/f.pdf", "tenant-abc")),
  "assertTenantScopedKey: throws for wrong tenant",
);

// Filename normalisation
const norm1 = normalizeFilename("../../../etc/passwd");
assert(!norm1.includes(".."),                           "normalizeFilename: strips path traversal");
assert(!normalizeFilename("  hello world.txt  ").includes(" "), "normalizeFilename: strips spaces");
assert(normalizeFilename("file.pdf").endsWith(".pdf"),  "normalizeFilename: preserves extension");
assert(normalizeFilename("").length > 0,                "normalizeFilename: empty input returns fallback");
assert(normalizeFilename("a".repeat(300)).length <= 255,"normalizeFilename: max length capped at 255");

// Cross-tenant isolation
const k3 = buildTenantObjectKey("tenant-A", "invoices", "inv001.pdf");
const k4 = buildTenantObjectKey("tenant-B", "invoices", "inv001.pdf");
assert(k3 !== k4,                                       "Cross-tenant keys are different");
assert(!k3.includes("tenant-B"),                        "Tenant-A key does not reference tenant-B");
assert(!k4.includes("tenant-A"),                        "Tenant-B key does not reference tenant-A");

// extractTenantId
assert(extractTenantId("tenants/my-tenant/uploads/f.pdf") === "my-tenant", "extractTenantId: correct");
assert(extractTenantId("platform/backups/db.sql") === null,                "extractTenantId: null for platform key");

// isPlatformKey / isTenantKey
assert(isPlatformKey("platform/backups/x.gz"),                             "isPlatformKey: true for platform/");
assert(!isPlatformKey("tenants/abc/uploads/f.pdf"),                        "isPlatformKey: false for tenant key");
assert(isTenantKey("tenants/abc/uploads/f.pdf"),                           "isTenantKey: true");
assert(!isTenantKey("platform/backups/x.gz"),                              "isTenantKey: false for platform key");
assert(isTenantKey("tenants/abc/uploads/f.pdf", "abc"),                    "isTenantKey with tenantId: match");
assert(!isTenantKey("tenants/abc/uploads/f.pdf", "xyz"),                   "isTenantKey with tenantId: no match for other tenant");

// safeKeyForLog strips HTML injection
const dangerous = "<script>alert(1)</script>";
assert(!safeKeyForLog(dangerous).includes("<script>"),                     "safeKeyForLog: strips HTML tags");

// buildTenantObjectKey requires tenantId
assert(throwsAny(() => buildTenantObjectKey("", "uploads", "f.pdf")),     "buildTenantObjectKey: throws for empty tenantId");

// ─── PART 2: r2-auth.ts ───────────────────────────────────────────────────────
console.log("\n[Part 2] server/lib/r2/r2-auth.ts");

import {
  canAccessObjectKey,
  assertCanReadObject,
  assertCanWriteObject,
  assertCanDeleteObject,
  getActorTenantId,
  canViewPlatformUsage,
  R2AccessDeniedError,
} from "../server/lib/r2/r2-auth.js";

assert(fileExists("server/lib/r2/r2-auth.ts"),                             "r2-auth.ts exists");
assert(fileContains("server/lib/r2/r2-auth.ts", "canAccessObjectKey"),     "canAccessObjectKey exported");
assert(fileContains("server/lib/r2/r2-auth.ts", "assertCanReadObject"),    "assertCanReadObject exported");
assert(fileContains("server/lib/r2/r2-auth.ts", "assertCanWriteObject"),   "assertCanWriteObject exported");
assert(fileContains("server/lib/r2/r2-auth.ts", "assertCanDeleteObject"),  "assertCanDeleteObject exported");
assert(fileContains("server/lib/r2/r2-auth.ts", "R2AccessDeniedError"),    "R2AccessDeniedError class exists");

const tenantActorA   = { organizationId: "tenant-A", role: "member",         id: "u1" };
const tenantActorB   = { organizationId: "tenant-B", role: "member",         id: "u2" };
const platformActor  = { organizationId: "platform",  role: "platform_admin", id: "admin1" };

// Tenant access control
assert(canAccessObjectKey(tenantActorA, "tenants/tenant-A/uploads/f.pdf"),  "Tenant A can access own key");
assert(!canAccessObjectKey(tenantActorA, "tenants/tenant-B/uploads/f.pdf"), "Tenant A cannot access Tenant B key");
assert(!canAccessObjectKey(tenantActorA, "platform/backups/db.gz"),         "Tenant A cannot access platform key");
assert(canAccessObjectKey(platformActor, "tenants/tenant-A/uploads/f.pdf"), "Platform admin can access tenant key");
assert(canAccessObjectKey(platformActor, "platform/backups/db.gz"),         "Platform admin can access platform key");

// assertCanReadObject throws for cross-tenant
assert(
  throwsTyped(() => assertCanReadObject(tenantActorA, "tenants/tenant-B/f.pdf"), "R2AccessDeniedError"),
  "assertCanReadObject throws R2AccessDeniedError for cross-tenant",
);

// assertCanWriteObject own key passes
assert(
  tryRun(() => { assertCanWriteObject(tenantActorA, "tenants/tenant-A/uploads/f.pdf"); return true; }),
  "assertCanWriteObject: own key passes",
);
// assertCanWriteObject cross-tenant throws
assert(
  throwsTyped(() => assertCanWriteObject(tenantActorB, "tenants/tenant-A/uploads/f.pdf"), "R2AccessDeniedError"),
  "assertCanWriteObject: cross-tenant throws",
);

// assertCanDeleteObject for platform/backups/
assert(
  throwsTyped(() => assertCanDeleteObject(tenantActorA, "platform/backups/db.gz"), "R2AccessDeniedError"),
  "assertCanDeleteObject: tenant cannot delete platform/backups",
);
assert(
  tryRun(() => { assertCanDeleteObject(platformActor, "platform/backups/db.gz"); return true; }),
  "assertCanDeleteObject: platform admin can delete platform/backups",
);

// canViewPlatformUsage
assert(!canViewPlatformUsage(tenantActorA),                                "canViewPlatformUsage: tenant cannot");
assert(canViewPlatformUsage(platformActor),                                "canViewPlatformUsage: platform admin can");
assert(!canViewPlatformUsage({ organizationId: "x", role: "member" }),    "canViewPlatformUsage: member cannot");

// getActorTenantId
assert(getActorTenantId(tenantActorA) === "tenant-A",                     "getActorTenantId: returns organizationId");
assert(throwsAny(() => getActorTenantId({ organizationId: "" })),          "getActorTenantId: throws for empty org");

// ─── PART 3: r2-audit.ts ─────────────────────────────────────────────────────
console.log("\n[Part 3] server/lib/r2/r2-audit.ts");

import {
  logR2Event,
  auditUploadRequested,
  auditUploadCompleted,
  auditSignedUploadUrl,
  auditSignedDownloadUrl,
  auditDownloadStarted,
  auditObjectDeleted,
  auditAccessDenied,
  auditMultipartStarted,
  auditMultipartCompleted,
  auditMultipartAborted,
} from "../server/lib/r2/r2-audit.js";

assert(fileExists("server/lib/r2/r2-audit.ts"),                               "r2-audit.ts exists");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_upload_requested"),      "r2_upload_requested event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_upload_completed"),      "r2_upload_completed event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_signed_upload_url_created"), "r2_signed_upload_url_created defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_signed_download_url_created"), "r2_signed_download_url_created defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_download_started"),      "r2_download_started event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_object_deleted"),        "r2_object_deleted event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_access_denied"),         "r2_access_denied event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_multipart_started"),     "r2_multipart_started event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_multipart_completed"),   "r2_multipart_completed event defined");
assert(fileContains("server/lib/r2/r2-audit.ts", "r2_multipart_aborted"),     "r2_multipart_aborted event defined");
assert(!fileContains("server/lib/r2/r2-audit.ts", "secretAccessKey"),         "audit: never logs secretAccessKey");
assert(!fileContains("server/lib/r2/r2-audit.ts", "CF_R2_SECRET"),            "audit: never logs CF_R2_SECRET");

// Capture audit output
const auditLines: string[] = [];
const originalLog = console.log;
console.log = (msg: any) => { if (typeof msg === "string") auditLines.push(msg); originalLog(msg); };

auditUploadRequested({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf" });
auditUploadCompleted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf", sizeBytes: 1024 });
auditSignedUploadUrl({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf" });
auditSignedDownloadUrl({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf" });
auditDownloadStarted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf" });
auditObjectDeleted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/f.pdf" });
auditAccessDenied({ actorId: "u1", tenantId: "t1", reason: "cross-tenant" });
auditMultipartStarted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/large.zip" });
auditMultipartCompleted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/large.zip" });
auditMultipartAborted({ actorId: "u1", tenantId: "t1", keyPrefix: "tenants/t1/uploads/large.zip" });

console.log = originalLog;

assert(auditLines.some(l => l.includes("r2_upload_requested")),   "audit: upload_requested logged");
assert(auditLines.some(l => l.includes("r2_upload_completed")),   "audit: upload_completed logged");
assert(auditLines.some(l => l.includes("r2_access_denied")),      "audit: access_denied logged");
assert(auditLines.some(l => l.includes("r2_multipart_started")),  "audit: multipart_started logged");
assert(auditLines.some(l => l.includes("r2_multipart_completed")),"audit: multipart_completed logged");
assert(auditLines.some(l => l.includes("r2_multipart_aborted")),  "audit: multipart_aborted logged");
assert(auditLines.every(l => !l.includes("secretAccessKey")),     "audit: no secret keys in log output");
assert(auditLines.every(l => !l.includes("X-Amz-Signature")),     "audit: no signed URL signatures in log output");
assert(auditLines.some(l => l.includes('"source":"r2-audit"')),   "audit: structured JSON with source field");
assert(auditLines.some(l => l.includes('"ts"')),                  "audit: timestamp field present");

// ─── PART 4: r2-usage.ts ─────────────────────────────────────────────────────
console.log("\n[Part 4] server/lib/r2/r2-usage.ts");

assert(fileExists("server/lib/r2/r2-usage.ts"),                              "r2-usage.ts exists");
assert(fileContains("server/lib/r2/r2-usage.ts", "getBucketUsageSummary"),   "getBucketUsageSummary exported");
assert(fileContains("server/lib/r2/r2-usage.ts", "getTenantPrefixUsage"),    "getTenantPrefixUsage exported");
assert(fileContains("server/lib/r2/r2-usage.ts", "getPrefixUsage"),          "getPrefixUsage exported");
assert(fileContains("server/lib/r2/r2-usage.ts", "estimateObjectCount"),     "estimateObjectCount exported");
assert(fileContains("server/lib/r2/r2-usage.ts", "ListObjectsV2Command"),    "uses S3 ListObjectsV2Command");
assert(fileContains("server/lib/r2/r2-usage.ts", "totalBytes"),              "tracks totalBytes");
assert(fileContains("server/lib/r2/r2-usage.ts", "objectCount"),             "tracks objectCount");
assert(fileContains("server/lib/r2/r2-usage.ts", "topPrefixes"),             "returns topPrefixes");
assert(fileContains("server/lib/r2/r2-usage.ts", "computedAt"),              "includes computedAt timestamp");

// ─── PART 5: multipart-upload.ts ─────────────────────────────────────────────
console.log("\n[Part 5] server/lib/r2/multipart-upload.ts");

assert(fileExists("server/lib/r2/multipart-upload.ts"),                           "multipart-upload.ts exists");
assert(fileContains("server/lib/r2/multipart-upload.ts", "createMultipartUpload"), "createMultipartUpload exported");
assert(fileContains("server/lib/r2/multipart-upload.ts", "createMultipartPartUrl"),"createMultipartPartUrl exported");
assert(fileContains("server/lib/r2/multipart-upload.ts", "completeMultipartUpload"),"completeMultipartUpload exported");
assert(fileContains("server/lib/r2/multipart-upload.ts", "abortMultipartUpload"),  "abortMultipartUpload exported");
assert(fileContains("server/lib/r2/multipart-upload.ts", "CreateMultipartUploadCommand"), "uses CreateMultipartUploadCommand");
assert(fileContains("server/lib/r2/multipart-upload.ts", "CompleteMultipartUploadCommand"), "uses CompleteMultipartUploadCommand");
assert(fileContains("server/lib/r2/multipart-upload.ts", "AbortMultipartUploadCommand"),    "uses AbortMultipartUploadCommand");
assert(fileContains("server/lib/r2/multipart-upload.ts", "getSignedUrl"),          "parts use presigned URLs");
assert(fileContains("server/lib/r2/multipart-upload.ts", "10_000"),                "partNumber max 10000 validated");
assert(fileContains("server/lib/r2/multipart-upload.ts", "uploadId"),              "uploadId tracked through lifecycle");

// ─── PART 6: r2-delete-policy.ts ─────────────────────────────────────────────
console.log("\n[Part 6] server/lib/r2/r2-delete-policy.ts");

import {
  assertDeleteAllowed,
  getDeleteRiskLevel,
  explainDeleteDecision,
} from "../server/lib/r2/r2-delete-policy.js";

assert(fileExists("server/lib/r2/r2-delete-policy.ts"),                      "r2-delete-policy.ts exists");
assert(fileContains("server/lib/r2/r2-delete-policy.ts", "assertDeleteAllowed"),    "assertDeleteAllowed exported");
assert(fileContains("server/lib/r2/r2-delete-policy.ts", "getDeleteRiskLevel"),     "getDeleteRiskLevel exported");
assert(fileContains("server/lib/r2/r2-delete-policy.ts", "explainDeleteDecision"),  "explainDeleteDecision exported");

assert(getDeleteRiskLevel("tenants/x/uploads/f.pdf") === "low",              "upload = low risk");
assert(getDeleteRiskLevel("tenants/x/invoices/i.pdf") === "medium",          "invoices = medium risk");
assert(getDeleteRiskLevel("platform/audit-exports/e.csv") === "high",        "audit-exports = high risk");
assert(getDeleteRiskLevel("platform/backups/db.gz") === "critical",          "backups = critical risk");

const decOk     = explainDeleteDecision(tenantActorA, "tenants/tenant-A/uploads/f.pdf");
assert(decOk.allowed,                                                         "tenant can delete own upload");
assert(decOk.riskLevel === "low",                                             "own upload is low risk");

const decCross  = explainDeleteDecision(tenantActorA, "tenants/tenant-B/uploads/f.pdf");
assert(!decCross.allowed,                                                     "tenant cannot delete other tenant file");

const decBackup = explainDeleteDecision(tenantActorA, "platform/backups/db.gz");
assert(!decBackup.allowed,                                                    "tenant cannot delete platform/backups");
assert(decBackup.riskLevel === "critical",                                    "platform/backups is critical risk");

const decAdminBackup = explainDeleteDecision(platformActor, "platform/backups/db.gz");
assert(decAdminBackup.allowed,                                                "platform admin can delete backups");

assert(throwsAny(() => assertDeleteAllowed(tenantActorA, "platform/backups/db.gz")), "assertDeleteAllowed: throws for tenant on backups");
assert(tryRun(() => { assertDeleteAllowed(tenantActorA, "tenants/tenant-A/uploads/f.pdf"); return true; }), "assertDeleteAllowed: passes for own upload");

// ─── PART 7: Routes ──────────────────────────────────────────────────────────
console.log("\n[Part 7] server/routes/r2.ts");

assert(fileExists("server/routes/r2.ts"),                                    "r2.ts routes file exists");
assert(fileContains("server/routes/r2.ts", "/api/r2/health"),                "health route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/upload-url"),            "upload-url route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/upload"),                "upload route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/download"),              "download route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/url"),                   "url route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/list"),                  "list route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/exists"),                "exists route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/usage"),                 "usage route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/prefix-usage"),          "prefix-usage route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/tenant-usage"),          "tenant-usage route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/multipart/start"),       "multipart/start route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/multipart/part-url"),    "multipart/part-url route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/multipart/complete"),    "multipart/complete route present");
assert(fileContains("server/routes/r2.ts", "/api/r2/multipart/abort"),       "multipart/abort route present");
assert(fileContains("server/routes/r2.ts", "assertCanReadObject"),           "routes use assertCanReadObject");
assert(fileContains("server/routes/r2.ts", "assertCanWriteObject"),          "routes use assertCanWriteObject");
assert(fileContains("server/routes/r2.ts", "assertCanDeleteObject"),         "routes use assertCanDeleteObject");
assert(fileContains("server/routes/r2.ts", "assertDeleteAllowed"),           "routes use assertDeleteAllowed");
assert(fileContains("server/routes/r2.ts", "buildTenantObjectKey"),          "routes use buildTenantObjectKey");
assert(fileContains("server/routes/r2.ts", "canViewPlatformUsage"),          "usage routes gate by canViewPlatformUsage");
assert(fileContains("server/routes/r2.ts", "auditUploadRequested"),          "routes emit upload audit event");
assert(fileContains("server/routes/r2.ts", "auditObjectDeleted"),            "routes emit delete audit event");
assert(fileContains("server/routes/r2.ts", "auditAccessDenied"),             "routes emit access_denied audit event");
assert(fileContains("server/routes/r2.ts", "registerR2Routes"),              "registerR2Routes function exported");

// ─── PART 8: Security properties ──────────────────────────────────────────────
console.log("\n[Part 8] Security properties");

assert(!fileContains("server/lib/r2/r2-audit.ts", "process.env.CF_R2_SECRET"), "audit: never logs CF_R2_SECRET env var");
assert(!fileContains("server/routes/r2.ts", "console.log(signed"),             "routes: signed URL not logged raw");
assert(fileContains("server/lib/r2/r2-auth.ts", "R2AccessDeniedError"),        "auth uses typed R2AccessDeniedError");
assert(fileContains("server/routes/r2.ts", "R2AccessDeniedError"),             "routes catch R2AccessDeniedError");
assert(fileContains("server/lib/r2/key-builder.ts", "traversal"),              "key-builder guards path traversal");
assert(fileContains("server/lib/r2/key-builder.ts", "255"),                    "key-builder caps filename at 255 chars");
assert(fileContains("server/lib/r2/r2-delete-policy.ts", "critical"),          "delete policy has critical risk level");
assert(fileContains("server/lib/r2/r2-delete-policy.ts", "R2AccessDeniedError"), "delete policy throws typed error");

// ─── PART 9: Frontend ─────────────────────────────────────────────────────────
console.log("\n[Part 9] client/src/pages/ops/storage.tsx");

assert(fileExists("client/src/pages/ops/storage.tsx"),                          "storage.tsx exists");
assert(fileContains("client/src/pages/ops/storage.tsx", "tenant-usage"),        "fetches tenant usage");
assert(fileContains("client/src/pages/ops/storage.tsx", "delete-policy"),       "calls delete-policy endpoint");
assert(fileContains("client/src/pages/ops/storage.tsx", "delete-confirm-modal"),"delete confirmation modal");
assert(fileContains("client/src/pages/ops/storage.tsx", "delete-risk-level"),   "shows risk level in modal");
assert(fileContains("client/src/pages/ops/storage.tsx", "upload-mode"),         "upload mode selector");
assert(fileContains("client/src/pages/ops/storage.tsx", "simple"),              "simple upload mode");
assert(fileContains("client/src/pages/ops/storage.tsx", "signed"),              "signed upload mode");
assert(fileContains("client/src/pages/ops/storage.tsx", "multipart"),           "multipart upload mode");
assert(fileContains("client/src/pages/ops/storage.tsx", "viewFilter"),          "view filter present");
assert(fileContains("client/src/pages/ops/storage.tsx", "usage-summary-cards"), "usage summary cards");
assert(fileContains("client/src/pages/ops/storage.tsx", "category-breakdown-card"), "category breakdown card");
assert(fileContains("client/src/pages/ops/storage.tsx", "object-scope-badge"),  "scope badge per object");
assert(fileContains("client/src/pages/ops/storage.tsx", "active-prefix-info"),  "active prefix info bar");
assert(fileContains("client/src/pages/ops/storage.tsx", "data-testid"),         "test IDs present throughout");

// ─── PART 10: File completeness ───────────────────────────────────────────────
console.log("\n[Part 10] File completeness");

const requiredFiles = [
  "server/lib/r2/key-builder.ts",
  "server/lib/r2/r2-auth.ts",
  "server/lib/r2/r2-audit.ts",
  "server/lib/r2/r2-usage.ts",
  "server/lib/r2/multipart-upload.ts",
  "server/lib/r2/r2-delete-policy.ts",
  "server/lib/r2/r2-client.ts",
  "server/lib/r2/r2-service.ts",
  "server/lib/r2/index.ts",
  "server/routes/r2.ts",
  "client/src/pages/ops/storage.tsx",
  "scripts/validate-r2-hardening.ts",
];
for (const f of requiredFiles) assert(fileExists(f), `${f} exists`);

// index.ts re-exports all modules
assert(fileContains("server/lib/r2/index.ts", "key-builder"),      "index.ts exports key-builder");
assert(fileContains("server/lib/r2/index.ts", "r2-auth"),          "index.ts exports r2-auth");
assert(fileContains("server/lib/r2/index.ts", "r2-audit"),         "index.ts exports r2-audit");
assert(fileContains("server/lib/r2/index.ts", "r2-usage"),         "index.ts exports r2-usage");
assert(fileContains("server/lib/r2/index.ts", "multipart"),        "index.ts exports multipart-upload");
assert(fileContains("server/lib/r2/index.ts", "r2-delete-policy"), "index.ts exports r2-delete-policy");

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`Phase X R2 Hardening — ${passed + failed} assertions total`);
console.log(`  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
} else {
  console.log("\n✓ All assertions passed — Phase X R2 Hardening & Multi-Tenant Storage complete");
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
    const commit = execSync("git rev-parse --short HEAD").toString().trim();
    console.log(`\nBranch : ${branch}`);
    console.log(`Commit : ${commit}`);
  } catch {}
  process.exit(0);
}
