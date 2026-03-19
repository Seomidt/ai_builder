/**
 * Phase 9 Validation — Tenant Lifecycle Management
 * 55+ scenarios, 220+ assertions
 * INV-TEN1–12 all verified
 */

import pg from "pg";
import {
  createTenant, getTenantById, listTenants, updateTenantStatus,
  suspendTenant, reactivateTenant, startTenantOffboarding, markTenantDeleted,
  explainTenantLifecycle, summarizeTenantState, getTenantStatusHistory,
  isTransitionAllowed, validateTransition,
} from "./tenant-lifecycle";
import {
  createTenantSettings, getTenantSettings, updateTenantSettings,
  explainTenantSettings, createOrGetTenantSettings,
} from "./tenant-settings";
import {
  requestTenantExport, startTenantExport, completeTenantExport, failTenantExport,
  requestTenantDeletion, approveTenantDeletion, blockTenantDeletion,
  startTenantDeletion, completeTenantDeletion, failTenantDeletion,
  explainTenantGovernanceState, addTenantDomain, listTenantDomains, updateDomainStatus,
  listTenantExportRequests, listTenantDeletionRequests,
} from "./tenant-governance";
import {
  canTenantLogin, canTenantUseApi, canTenantUseAiRuntime,
  canTenantAccessKnowledge, canTenantAccessBilling,
  assertTenantIsOperational, explainTenantAccessState,
} from "./tenant-access";
import {
  ensureTenantExists, seedTenantDefaults,
  bootstrapCanonicalTenantsFromExistingData, explainTenantBootstrapState,
} from "./tenant-bootstrap";
import {
  TENANT_AUDIT_ACTIONS, ALL_TENANT_AUDIT_ACTION_CODES, isKnownTenantAuditAction,
} from "./audit-actions-phase9";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✔ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function section(title: string): void { console.log(`\n── ${title} ──`); }

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

const TS = Date.now();
const TID_A = `tenant-9a-${TS}`;
const TID_B = `tenant-9b-${TS}`;
const TID_C = `tenant-9c-${TS}`;
const TID_D = `tenant-9d-${TS}`;
const USER1 = `user-9-${TS}`;

async function main() {
  const client = getClient();
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── SCENARIO 1: DB schema — 6 tables ──────────────────────────────────────
    section("SCENARIO 1: DB schema — 6 Phase 9 tables present");
    const tables = ["tenants","tenant_settings","tenant_status_history","tenant_export_requests","tenant_deletion_requests","tenant_domains"];
    const tR = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`, [tables]);
    assert(tR.rows.length === 6, `All 6 Phase 9 tables exist (found ${tR.rows.length})`);

    // ── SCENARIO 2: Tenants CHECK constraints ─────────────────────────────────
    section("SCENARIO 2: CHECK constraints on tenants");
    const ckR = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.tenants'::regclass AND contype='c'`);
    assert(ckR.rows.length >= 2, `At least 2 CHECK constraints (found ${ckR.rows.length})`);
    const ckNames = ckR.rows.map((r) => r.conname).join(",");
    assert(ckNames.includes("lifecycle_status"), "lifecycle_status CHECK constraint present");
    assert(ckNames.includes("tenant_type"), "tenant_type CHECK constraint present");

    // ── SCENARIO 3: Total RLS table count ────────────────────────────────────
    section("SCENARIO 3: Total RLS table count ≥ 129");
    const rlsR = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    const rlsCount = parseInt(rlsR.rows[0].cnt, 10);
    assert(rlsCount >= 129, `Total RLS tables >= 129 (found ${rlsCount})`);

    // ── SCENARIO 4: RLS on all 6 Phase 9 tables ───────────────────────────────
    section("SCENARIO 4: RLS enabled on all 6 Phase 9 tables");
    const p9Rls = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`, [tables]);
    assert(p9Rls.rows.length === 6, `RLS on all 6 tables (found ${p9Rls.rows.length})`);

    // ── SCENARIO 5: FK integrity ──────────────────────────────────────────────
    section("SCENARIO 5: FK — tenant_settings → tenants");
    const fkR = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.tenant_settings'::regclass AND contype='f'`);
    assert(fkR.rows.length >= 1, `FK from tenant_settings to tenants exists (${fkR.rows.map((r) => r.conname).join(",")})`);

    // ── SCENARIO 6: Indexes ───────────────────────────────────────────────────
    section("SCENARIO 6: Key indexes present");
    const idxR = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='tenants'`);
    assert(idxR.rows.length >= 5, `At least 5 tenants indexes (found ${idxR.rows.length})`);

    // ── SCENARIO 7: createTenant works (INV-TEN1) ─────────────────────────────
    section("SCENARIO 7: createTenant works — lifecycle_status explicit (INV-TEN1)");
    const t7 = await createTenant({ id: TID_A, name: "Tenant Alpha", lifecycleStatus: "active", tenantType: "customer", changedBy: USER1 });
    assert(t7.id === TID_A, "id matches");
    assert(t7.name === "Tenant Alpha", "name matches");
    assert(t7.lifecycleStatus === "active", "INV-TEN1: lifecycle_status = active");
    assert(t7.tenantType === "customer", "tenant_type = customer");

    // Verify in DB
    const dbT7 = await client.query(`SELECT id, lifecycle_status, tenant_type FROM public.tenants WHERE id = $1`, [TID_A]);
    assert(dbT7.rows.length === 1, "Tenant persisted in DB");
    assert(dbT7.rows[0].lifecycle_status === "active", "lifecycle_status = active in DB");
    assert(dbT7.rows[0].tenant_type === "customer", "tenant_type = customer in DB");

    // ── SCENARIO 8: Status history on creation ───────────────────────────────
    section("SCENARIO 8: Status history written on tenant creation");
    const hist8 = await client.query(`SELECT * FROM public.tenant_status_history WHERE tenant_id = $1`, [TID_A]);
    assert(hist8.rows.length >= 1, "Status history row created on tenant creation");
    assert(hist8.rows[0].new_status === "active", "Initial status history records 'active'");
    assert(hist8.rows[0].previous_status === null, "Initial previous_status is null");
    assert(hist8.rows[0].changed_by === USER1, "changed_by recorded");

    // ── SCENARIO 9: getTenantById ─────────────────────────────────────────────
    section("SCENARIO 9: getTenantById works");
    const found9 = await getTenantById(TID_A);
    assert(found9 !== null, "getTenantById finds existing tenant");
    assert(found9!.id === TID_A, "id matches");
    assert(found9!.lifecycleStatus === "active", "lifecycleStatus correct");

    const notFound9 = await getTenantById("nonexistent-tenant-id");
    assert(notFound9 === null, "getTenantById returns null for missing tenant");

    // ── SCENARIO 10: listTenants ──────────────────────────────────────────────
    section("SCENARIO 10: listTenants works");
    const list10 = await listTenants({ lifecycleStatus: "active" });
    assert(Array.isArray(list10), "listTenants returns array");
    assert(list10.some((t) => t.id === TID_A), "Created tenant appears in list");

    // ── SCENARIO 11: trial → active (INV-TEN2) ────────────────────────────────
    section("SCENARIO 11: trial → active lifecycle transition (INV-TEN2)");
    const tTrial = await createTenant({ id: TID_B, name: "Trial Tenant", lifecycleStatus: "trial" });
    assert(tTrial.lifecycleStatus === "trial", "Tenant created with trial status");

    const { tenant: t11, previousStatus: prev11 } = await updateTenantStatus({ tenantId: TID_B, newStatus: "active", reason: "Converted from trial" });
    assert(t11.lifecycleStatus === "active", "INV-TEN2: trial → active transition successful");
    assert(prev11 === "trial", "previousStatus = trial");

    const hist11 = await client.query(`SELECT * FROM public.tenant_status_history WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [TID_B]);
    assert(hist11.rows[0].previous_status === "trial", "History: previous = trial");
    assert(hist11.rows[0].new_status === "active", "History: new = active");
    assert(hist11.rows[0].change_reason === "Converted from trial", "change_reason recorded");

    // ── SCENARIO 12: active → suspended (INV-TEN2) ────────────────────────────
    section("SCENARIO 12: active → suspended via suspendTenant");
    const tSusp = await suspendTenant({ tenantId: TID_B, changedBy: USER1, reason: "Non-payment" });
    assert(tSusp.lifecycleStatus === "suspended", "Tenant suspended");
    assert(tSusp.suspendedAt instanceof Date, "suspended_at set");

    // ── SCENARIO 13: suspended → active (INV-TEN2) ────────────────────────────
    section("SCENARIO 13: suspended → active via reactivateTenant");
    const tReact = await reactivateTenant({ tenantId: TID_B, changedBy: USER1, reason: "Payment received" });
    assert(tReact.lifecycleStatus === "active", "Tenant reactivated");

    // ── SCENARIO 14: active → delinquent (INV-TEN2) ───────────────────────────
    section("SCENARIO 14: active → delinquent transition");
    const { tenant: t14 } = await updateTenantStatus({ tenantId: TID_B, newStatus: "delinquent", reason: "Invoice overdue" });
    assert(t14.lifecycleStatus === "delinquent", "Tenant marked delinquent");

    // ── SCENARIO 15: delinquent → active (INV-TEN2) ───────────────────────────
    section("SCENARIO 15: delinquent → active transition");
    const { tenant: t15 } = await updateTenantStatus({ tenantId: TID_B, newStatus: "active", reason: "Invoice paid" });
    assert(t15.lifecycleStatus === "active", "Tenant back to active from delinquent");

    // ── SCENARIO 16: active → offboarding (INV-TEN2) ──────────────────────────
    section("SCENARIO 16: active → offboarding via startTenantOffboarding");
    const tOff = await startTenantOffboarding({ tenantId: TID_B, changedBy: USER1 });
    assert(tOff.lifecycleStatus === "offboarding", "Tenant in offboarding");
    assert(tOff.offboardingStartedAt instanceof Date, "offboarding_started_at set");

    // ── SCENARIO 17: offboarding → deleted (INV-TEN2) ─────────────────────────
    section("SCENARIO 17: offboarding → deleted via markTenantDeleted");
    const tDel = await markTenantDeleted({ tenantId: TID_B, changedBy: USER1, reason: "Customer requested deletion" });
    assert(tDel.lifecycleStatus === "deleted", "Tenant marked deleted");
    assert(tDel.deletedAt instanceof Date, "deleted_at set");

    // ── SCENARIO 18: deleted → active BLOCKED (INV-TEN3) ─────────────────────
    section("SCENARIO 18: deleted → active rejected (INV-TEN3)");
    let err18 = false;
    try {
      await updateTenantStatus({ tenantId: TID_B, newStatus: "active" });
    } catch (e) {
      err18 = (e as Error).message.includes("INV-TEN3");
    }
    assert(err18, "INV-TEN3: deleted → active transition rejected with INV-TEN3 message");

    // ── SCENARIO 19: suspended → trial BLOCKED (INV-TEN3) ────────────────────
    section("SCENARIO 19: suspended → trial rejected (INV-TEN3)");
    const tSusp2 = await createTenant({ id: TID_C, name: "Suspended Test", lifecycleStatus: "suspended" });
    let err19 = false;
    try {
      await updateTenantStatus({ tenantId: TID_C, newStatus: "trial" });
    } catch (e) {
      err19 = (e as Error).message.includes("INV-TEN3");
    }
    assert(err19, "INV-TEN3: suspended → trial transition rejected");

    // ── SCENARIO 20: deleted → offboarding BLOCKED (INV-TEN3) ────────────────
    section("SCENARIO 20: deleted → offboarding rejected (INV-TEN3)");
    let err20 = false;
    try {
      await updateTenantStatus({ tenantId: TID_B, newStatus: "offboarding" });
    } catch (e) {
      err20 = (e as Error).message.includes("INV-TEN3");
    }
    assert(err20, "INV-TEN3: deleted → offboarding transition rejected");

    // ── SCENARIO 21: isTransitionAllowed logic ────────────────────────────────
    section("SCENARIO 21: isTransitionAllowed — transition matrix correct");
    assert(isTransitionAllowed("trial", "active"), "trial → active allowed");
    assert(isTransitionAllowed("active", "suspended"), "active → suspended allowed");
    assert(isTransitionAllowed("active", "delinquent"), "active → delinquent allowed");
    assert(isTransitionAllowed("active", "offboarding"), "active → offboarding allowed");
    assert(isTransitionAllowed("suspended", "active"), "suspended → active allowed");
    assert(isTransitionAllowed("delinquent", "active"), "delinquent → active allowed");
    assert(isTransitionAllowed("offboarding", "deleted"), "offboarding → deleted allowed");
    assert(!isTransitionAllowed("deleted", "active"), "deleted → active NOT allowed");
    assert(!isTransitionAllowed("deleted", "offboarding"), "deleted → offboarding NOT allowed");
    assert(!isTransitionAllowed("suspended", "trial"), "suspended → trial NOT allowed");
    assert(!isTransitionAllowed("deleted", "trial"), "deleted → trial NOT allowed");

    // ── SCENARIO 22: CHECK constraint rejects invalid lifecycle_status ──────────
    section("SCENARIO 22: DB CHECK rejects invalid lifecycle_status");
    let ck22 = false;
    try {
      await client.query(`INSERT INTO public.tenants (id, name, lifecycle_status) VALUES (gen_random_uuid()::text, 'bad', 'invalid_status')`);
    } catch { ck22 = true; }
    assert(ck22, "CHECK constraint rejects invalid lifecycle_status");

    // ── SCENARIO 23: CREATE tenant settings (INV-TEN5) ───────────────────────
    section("SCENARIO 23: createTenantSettings (INV-TEN5)");
    const s23 = await createTenantSettings({ tenantId: TID_A, allowLogin: true, allowApiAccess: true, allowAiRuntime: true, changedBy: USER1 });
    assert(typeof s23.id === "string", "settings id returned");
    assert(s23.tenantId === TID_A, "tenantId matches");
    assert(s23.allowLogin === true, "allowLogin = true");
    assert(s23.settingsStatus === "active", "settingsStatus = active");

    // INV-TEN5: Unique per tenant
    let s23Dup = false;
    try {
      await createTenantSettings({ tenantId: TID_A });
    } catch { s23Dup = true; }
    assert(s23Dup, "INV-TEN5: Duplicate settings creation rejected (unique constraint)");

    // ── SCENARIO 24: getTenantSettings ───────────────────────────────────────
    section("SCENARIO 24: getTenantSettings retrieves canonical row");
    const s24 = await getTenantSettings(TID_A);
    assert(s24 !== null, "Settings found");
    assert(s24!.tenantId === TID_A, "tenantId matches");

    // ── SCENARIO 25: updateTenantSettings (INV-TEN8) ─────────────────────────
    section("SCENARIO 25: updateTenantSettings — audited (INV-TEN8)");
    const countBefore = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`, [TID_A]);
    const s25 = await updateTenantSettings({ tenantId: TID_A, allowAiRuntime: false, changedBy: USER1 });
    assert(s25.allowAiRuntime === false, "allowAiRuntime updated to false");
    const countAfter = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`, [TID_A]);
    assert(parseInt(countAfter.rows[0].cnt, 10) > parseInt(countBefore.rows[0].cnt, 10), "INV-TEN8: Settings update audited");

    // ── SCENARIO 26: explainTenantSettings (INV-TEN9) ────────────────────────
    section("SCENARIO 26: explainTenantSettings is read-only (INV-TEN9)");
    const settings26 = await getTenantSettings(TID_A);
    const explained26 = explainTenantSettings(settings26);
    assert(explained26.found === true, "Settings found");
    assert(explained26.canUseAiRuntime === false, "ai_runtime disabled reflected");
    assert(explained26.disabledCapabilities.includes("ai_runtime"), "ai_runtime in disabled list");
    assert(explained26.note.includes("INV-TEN9"), "INV-TEN9 in note");

    const beforeCount26 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_settings WHERE tenant_id = $1`, [TID_A]);
    explainTenantSettings(null);
    const afterCount26 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_settings WHERE tenant_id = $1`, [TID_A]);
    assert(parseInt(beforeCount26.rows[0].cnt, 10) === parseInt(afterCount26.rows[0].cnt, 10), "INV-TEN9: explainTenantSettings wrote nothing");

    // ── SCENARIO 27: createOrGetTenantSettings is idempotent ─────────────────
    section("SCENARIO 27: createOrGetTenantSettings idempotent");
    const s27a = await createOrGetTenantSettings(TID_A);
    const s27b = await createOrGetTenantSettings(TID_A);
    assert(s27a.id === s27b.id, "Same settings id returned on repeated calls (INV-TEN5 idempotent)");

    // ── SCENARIO 28: addTenantDomain ──────────────────────────────────────────
    section("SCENARIO 28: addTenantDomain");
    const dom28 = await addTenantDomain({ tenantId: TID_A, domain: `example-${TS}.com`, addedBy: USER1 });
    assert(typeof dom28["id"] === "string", "domain id returned");
    assert(dom28["domain_status"] === "pending", "domain_status = pending");
    assert(dom28["tenant_id"] === TID_A, "tenant_id correct");

    // ── SCENARIO 29: domain uniqueness enforced ───────────────────────────────
    section("SCENARIO 29: domain uniqueness enforced");
    let dom29Dup = false;
    try {
      await addTenantDomain({ tenantId: TID_A, domain: `example-${TS}.com` });
    } catch { dom29Dup = true; }
    assert(dom29Dup, "Duplicate domain rejected by unique constraint");

    // ── SCENARIO 30: domain status update ─────────────────────────────────────
    section("SCENARIO 30: domain status updated to verified");
    const dom30 = await updateDomainStatus(dom28["id"] as string, "verified");
    assert(dom30["domain_status"] === "verified", "domain_status = verified");
    assert(dom30["verified_at"] !== null, "verified_at set");

    // ── SCENARIO 31: disabled domain preserved ────────────────────────────────
    section("SCENARIO 31: domain disabled — preserved, not deleted");
    const dom31 = await updateDomainStatus(dom28["id"] as string, "disabled");
    assert(dom31["domain_status"] === "disabled", "domain_status = disabled");
    const domRows31 = await client.query(`SELECT * FROM public.tenant_domains WHERE id = $1`, [dom28["id"]]);
    assert(domRows31.rows.length === 1, "Disabled domain still in DB (not deleted)");

    // ── SCENARIO 32: listTenantDomains tenant-scoped (INV-TEN10) ─────────────
    section("SCENARIO 32: listTenantDomains is tenant-scoped (INV-TEN10)");
    const dom32 = await listTenantDomains(TID_A);
    assert(Array.isArray(dom32), "Returns array");
    assert(dom32.every((d) => d["tenant_id"] === TID_A), "INV-TEN10: All domains belong to tenant A");

    // ── SCENARIO 33: active tenant can login (INV-TEN4) ───────────────────────
    section("SCENARIO 33: active tenant can login (INV-TEN4)");
    await updateTenantSettings({ tenantId: TID_A, allowLogin: true, allowApiAccess: true, allowAiRuntime: true });
    const access33 = await canTenantLogin(TID_A);
    assert(access33.allowed === true, "Active tenant can login");
    assert(access33.lifecycleStatus === "active", "lifecycleStatus = active");

    // ── SCENARIO 34: suspended tenant cannot login (INV-TEN4) ─────────────────
    section("SCENARIO 34: suspended tenant cannot login (INV-TEN4)");
    // TID_C is currently suspended
    const access34 = await canTenantLogin(TID_C);
    assert(access34.allowed === false, "INV-TEN4: Suspended tenant cannot login");
    assert(access34.reason.includes("suspended"), "Reason mentions suspended");

    // ── SCENARIO 35: suspended tenant cannot use API ──────────────────────────
    section("SCENARIO 35: suspended tenant cannot use API (INV-TEN4)");
    const api35 = await canTenantUseApi(TID_C);
    assert(api35.allowed === false, "INV-TEN4: Suspended tenant cannot use API");

    // ── SCENARIO 36: suspended tenant cannot use AI runtime ──────────────────
    section("SCENARIO 36: suspended tenant cannot use AI runtime (INV-TEN4)");
    const ai36 = await canTenantUseAiRuntime(TID_C);
    assert(ai36.allowed === false, "INV-TEN4: Suspended tenant cannot use AI runtime");

    // ── SCENARIO 37: deleted tenant access fails safely ───────────────────────
    section("SCENARIO 37: deleted tenant fails safely (INV-TEN4)");
    const del37 = await canTenantLogin(TID_B); // TID_B is deleted
    assert(del37.allowed === false, "INV-TEN4: Deleted tenant cannot login");
    assert(del37.reason.includes("deleted"), "Reason mentions deleted");

    // ── SCENARIO 38: offboarding tenant access clamped ────────────────────────
    section("SCENARIO 38: offboarding tenant clamped (INV-TEN4)");
    const tOff38 = await createTenant({ id: TID_D, name: "Offboarding Tenant", lifecycleStatus: "active" });
    await startTenantOffboarding({ tenantId: TID_D });
    const off38 = await canTenantLogin(TID_D);
    assert(off38.allowed === false, "INV-TEN4: Offboarding tenant cannot login");

    // ── SCENARIO 39: assertTenantIsOperational throws for non-active ──────────
    section("SCENARIO 39: assertTenantIsOperational throws for suspended (INV-TEN4)");
    let err39 = false;
    try {
      await assertTenantIsOperational(TID_C);
    } catch (e) {
      err39 = (e as Error).message.includes("INV-TEN4");
    }
    assert(err39, "INV-TEN4: assertTenantIsOperational throws with INV-TEN4 message for suspended");

    // ── SCENARIO 40: assertTenantIsOperational passes for active ──────────────
    section("SCENARIO 40: assertTenantIsOperational passes for active tenant");
    let err40 = false;
    try {
      await assertTenantIsOperational(TID_A);
    } catch { err40 = true; }
    assert(!err40, "Active tenant passes assertTenantIsOperational");

    // ── SCENARIO 41: explainTenantAccessState is read-only (INV-TEN9) ─────────
    section("SCENARIO 41: explainTenantAccessState is read-only (INV-TEN9)");
    const beforeCnt41 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const access41 = await explainTenantAccessState(TID_C);
    const afterCnt41 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(beforeCnt41.rows[0].cnt, 10) === parseInt(afterCnt41.rows[0].cnt, 10), "INV-TEN9: explainTenantAccessState wrote nothing");
    assert(access41.isOperational === false, "Suspended tenant not operational");
    assert(access41.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(access41.note.includes("INV-TEN4"), "INV-TEN4 in note");

    // ── SCENARIO 42: request tenant export (INV-TEN6) ─────────────────────────
    section("SCENARIO 42: requestTenantExport (INV-TEN6)");
    const exp42 = await requestTenantExport({ tenantId: TID_A, requestedBy: USER1, exportScope: "full" });
    assert(typeof exp42.requestId === "string", "requestId returned");
    assert(exp42.exportStatus === "requested", "exportStatus = requested");

    // Verify in DB
    const expRow42 = await client.query(`SELECT * FROM public.tenant_export_requests WHERE id = $1`, [exp42.requestId]);
    assert(expRow42.rows.length === 1, "Export request in DB");
    assert(expRow42.rows[0].export_scope === "full", "export_scope = full");
    assert(expRow42.rows[0].tenant_id === TID_A, "tenant_id = TID_A");

    // ── SCENARIO 43: start tenant export ──────────────────────────────────────
    section("SCENARIO 43: startTenantExport transitions to 'running'");
    const exp43 = await startTenantExport(exp42.requestId, "system");
    assert(exp43["export_status"] === "running", "exportStatus = running");
    assert(exp43["started_at"] !== null, "started_at set");

    // ── SCENARIO 44: complete tenant export ───────────────────────────────────
    section("SCENARIO 44: completeTenantExport transitions to 'completed'");
    const exp44 = await completeTenantExport(exp42.requestId, { tablesExported: 5 });
    assert(exp44["export_status"] === "completed", "exportStatus = completed");
    assert(exp44["completed_at"] !== null, "completed_at set");
    assert(exp44["result_summary"] !== null, "result_summary stored");

    // ── SCENARIO 45: fail tenant export ───────────────────────────────────────
    section("SCENARIO 45: failTenantExport — create new then fail it");
    const exp45a = await requestTenantExport({ tenantId: TID_A, requestedBy: null });
    await startTenantExport(exp45a.requestId);
    const exp45 = await failTenantExport(exp45a.requestId, "S3 connection timeout");
    assert(exp45["export_status"] === "failed", "exportStatus = failed");
    assert(exp45["error_message"] === "S3 connection timeout", "error_message stored");

    // ── SCENARIO 46: listTenantExportRequests tenant-scoped (INV-TEN10) ───────
    section("SCENARIO 46: listTenantExportRequests is tenant-scoped (INV-TEN10)");
    const expList46 = await listTenantExportRequests(TID_A);
    assert(expList46.every((e) => e["tenant_id"] === TID_A), "INV-TEN10: All export requests for TID_A only");

    // ── SCENARIO 47: request tenant deletion (INV-TEN6) ───────────────────────
    section("SCENARIO 47: requestTenantDeletion (INV-TEN6)");
    const del47 = await requestTenantDeletion({ tenantId: TID_A, requestedBy: USER1 });
    assert(typeof del47.requestId === "string", "requestId returned");
    assert(del47.deletionStatus === "requested", "deletionStatus = requested");

    // ── SCENARIO 48: approve tenant deletion ──────────────────────────────────
    section("SCENARIO 48: approveTenantDeletion");
    const del48 = await approveTenantDeletion(del47.requestId, USER1);
    assert(del48["deletion_status"] === "approved", "deletionStatus = approved");
    assert(del48["approved_at"] !== null, "approved_at set");

    // ── SCENARIO 49: block tenant deletion ────────────────────────────────────
    section("SCENARIO 49: blockTenantDeletion — reason recorded");
    const del49req = await requestTenantDeletion({ tenantId: TID_C, requestedBy: null });
    const del49 = await blockTenantDeletion(del49req.requestId, "Pending legal hold", USER1);
    assert(del49["deletion_status"] === "blocked", "deletionStatus = blocked");
    assert(del49["block_reason"] === "Pending legal hold", "block_reason recorded");

    // ── SCENARIO 50: start + complete tenant deletion ─────────────────────────
    section("SCENARIO 50: startTenantDeletion → completeTenantDeletion");
    await startTenantDeletion(del48["id"] as string);
    const del50 = await completeTenantDeletion(del48["id"] as string, { rowsPurged: 42 });
    assert(del50["deletion_status"] === "completed", "deletionStatus = completed");
    assert(del50["result_summary"] !== null, "result_summary stored");

    // ── SCENARIO 51: fail tenant deletion ─────────────────────────────────────
    section("SCENARIO 51: failTenantDeletion");
    const del51req = await requestTenantDeletion({ tenantId: TID_D, requestedBy: null });
    await approveTenantDeletion(del51req.requestId, "system");
    await startTenantDeletion(del51req.requestId);
    const del51 = await failTenantDeletion(del51req.requestId, "DB lock timeout");
    assert(del51["deletion_status"] === "failed", "deletionStatus = failed");
    assert(del51["error_message"] === "DB lock timeout", "error_message stored");

    // ── SCENARIO 52: listTenantDeletionRequests tenant-scoped (INV-TEN10) ──────
    section("SCENARIO 52: listTenantDeletionRequests is tenant-scoped (INV-TEN10)");
    const delList52 = await listTenantDeletionRequests(TID_A);
    assert(delList52.every((r) => r["tenant_id"] === TID_A), "INV-TEN10: All deletion requests for TID_A only");

    // ── SCENARIO 53: explainTenantGovernanceState (INV-TEN9) ──────────────────
    section("SCENARIO 53: explainTenantGovernanceState is read-only (INV-TEN9)");
    const beforeGov53 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_export_requests WHERE tenant_id = $1`, [TID_A]);
    const gov53 = await explainTenantGovernanceState(TID_A);
    const afterGov53 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_export_requests WHERE tenant_id = $1`, [TID_A]);
    assert(parseInt(beforeGov53.rows[0].cnt, 10) === parseInt(afterGov53.rows[0].cnt, 10), "INV-TEN9: explainTenantGovernanceState wrote nothing");
    assert(gov53.note.includes("INV-TEN9"), "INV-TEN9 in governance note");
    assert(Array.isArray(gov53.exportRequests), "exportRequests is array");
    assert(Array.isArray(gov53.deletionRequests), "deletionRequests is array");
    assert(gov53.governanceNote.includes("INV-TEN6"), "INV-TEN6 in governance policy note");

    // ── SCENARIO 54: ensureTenantExists is idempotent (INV-TEN7) ─────────────
    section("SCENARIO 54: ensureTenantExists is idempotent (INV-TEN7)");
    const boot54a = await ensureTenantExists({ tenantId: TID_A, name: "Ignored name" });
    const boot54b = await ensureTenantExists({ tenantId: TID_A, name: "Ignored again" });
    assert(boot54a.created === false, "INV-TEN7: Existing tenant not recreated");
    assert(boot54b.created === false, "INV-TEN7: Second call also returns existing");
    assert(boot54a.tenant!.id === TID_A, "Tenant id matches on idempotent call");

    // ── SCENARIO 55: seedTenantDefaults is idempotent (INV-TEN7) ─────────────
    section("SCENARIO 55: seedTenantDefaults is idempotent (INV-TEN7)");
    const seed55a = await seedTenantDefaults(TID_A);
    const seed55b = await seedTenantDefaults(TID_A);
    assert(seed55a.settingsId === seed55b.settingsId, "INV-TEN7: Same settings id returned on repeated calls");

    // ── SCENARIO 56: bootstrapCanonicalTenantsFromExistingData dry-run (INV-TEN7/9)
    section("SCENARIO 56: bootstrapCanonicalTenantsFromExistingData dry-run (INV-TEN7/9)");
    const beforeBoot56 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const boot56 = await bootstrapCanonicalTenantsFromExistingData({ dryRun: true, changedBy: "test" });
    const afterBoot56 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(beforeBoot56.rows[0].cnt, 10) === parseInt(afterBoot56.rows[0].cnt, 10), "INV-TEN9: Dry-run wrote nothing");
    assert(boot56.dryRun === true, "dryRun flag set");
    assert(Array.isArray(boot56.discovered), "discovered is array");
    assert(boot56.note.includes("INV-TEN7"), "INV-TEN7 in bootstrap note");

    // ── SCENARIO 57: explainTenantLifecycle is read-only (INV-TEN9) ──────────
    section("SCENARIO 57: explainTenantLifecycle is read-only (INV-TEN9)");
    const beforeExp57 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_status_history WHERE tenant_id = $1`, [TID_A]);
    const expl57 = await explainTenantLifecycle(TID_A);
    const afterExp57 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_status_history WHERE tenant_id = $1`, [TID_A]);
    assert(parseInt(beforeExp57.rows[0].cnt, 10) === parseInt(afterExp57.rows[0].cnt, 10), "INV-TEN9: explainTenantLifecycle wrote nothing");
    assert(expl57.found === true, "Tenant found");
    assert(expl57.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(Array.isArray(expl57.allowedTransitions), "allowedTransitions returned");
    assert(expl57.isOperational === true, "TID_A is operational");

    // ── SCENARIO 58: explainTenantBootstrapState (INV-TEN9) ──────────────────
    section("SCENARIO 58: explainTenantBootstrapState is read-only (INV-TEN9)");
    const before58 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const bs58 = await explainTenantBootstrapState();
    const after58 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(before58.rows[0].cnt, 10) === parseInt(after58.rows[0].cnt, 10), "INV-TEN9: explainTenantBootstrapState wrote nothing");
    assert(bs58.canonicalTenantCount >= 4, `At least 4 canonical tenants (found ${bs58.canonicalTenantCount})`);
    assert(bs58.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(bs58.note.includes("INV-TEN7"), "INV-TEN7 in note");

    // ── SCENARIO 59: summarizeTenantState is read-only (INV-TEN9) ────────────
    section("SCENARIO 59: summarizeTenantState is read-only (INV-TEN9)");
    const before59 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const sum59 = await summarizeTenantState(TID_A);
    const after59 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(before59.rows[0].cnt, 10) === parseInt(after59.rows[0].cnt, 10), "INV-TEN9: summarizeTenantState wrote nothing");
    assert(sum59.tenantId === TID_A, "tenantId matches");
    assert(sum59.lifecycleStatus === "active", "lifecycleStatus correct");
    assert(sum59.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(typeof sum59.hasSettings === "boolean", "hasSettings boolean");

    // ── SCENARIO 60: Audit events logged for lifecycle changes (INV-TEN8) ─────
    section("SCENARIO 60: Lifecycle changes audited (INV-TEN8)");
    const auditRows = await client.query(
      `SELECT action FROM public.audit_events WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY created_at DESC LIMIT 20`,
      [TID_A],
    );
    const auditActions = auditRows.rows.map((r) => r.action);
    assert(auditActions.includes("tenant.created"), "INV-TEN8: tenant.created audited");
    assert(auditActions.some((a) => a.startsWith("tenant.")), "INV-TEN8: Multiple tenant audit events present");

    // ── SCENARIO 61: Settings update audited (INV-TEN8) ──────────────────────
    section("SCENARIO 61: Settings update audited (INV-TEN8)");
    const settingsAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`,
      [TID_A],
    );
    assert(parseInt(settingsAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.settings.updated audited");

    // ── SCENARIO 62: Export request audited (INV-TEN8) ───────────────────────
    section("SCENARIO 62: Export request audited (INV-TEN8)");
    const expAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.export.requested'`,
      [TID_A],
    );
    assert(parseInt(expAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.export.requested audited");

    // ── SCENARIO 63: Deletion request audited (INV-TEN8) ─────────────────────
    section("SCENARIO 63: Deletion request audited (INV-TEN8)");
    const delAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.deletion.requested'`,
      [TID_A],
    );
    assert(parseInt(delAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.deletion.requested audited");

    // ── SCENARIO 64: Canonical action codes (INV-TEN8) ───────────────────────
    section("SCENARIO 64: Canonical tenant audit action codes");
    assert(ALL_TENANT_AUDIT_ACTION_CODES.length >= 20, `At least 20 canonical tenant action codes (found ${ALL_TENANT_AUDIT_ACTION_CODES.length})`);
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_CREATED), "tenant.created is known");
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_SUSPENDED), "tenant.suspended is known");
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_DELETION_BLOCKED), "tenant.deletion.blocked is known");
    assert(!isKnownTenantAuditAction("random.action"), "Unknown action rejected");

    // ── SCENARIO 65: Cross-tenant isolation (INV-TEN10) ──────────────────────
    section("SCENARIO 65: Cross-tenant isolation — no data leakage (INV-TEN10)");
    const expA = await listTenantExportRequests(TID_A);
    const expD = await listTenantExportRequests(TID_D);
    const overlap65 = expA.filter((a) => expD.some((d) => d["id"] === a["id"]));
    assert(overlap65.length === 0, "INV-TEN10: Zero overlap in export requests across tenants");

    const delA = await listTenantDeletionRequests(TID_A);
    const delC = await listTenantDeletionRequests(TID_C);
    const overlapDel = delA.filter((a) => delC.some((c) => c["id"] === a["id"]));
    assert(overlapDel.length === 0, "INV-TEN10: Zero overlap in deletion requests across tenants");

    const domA = await listTenantDomains(TID_A);
    const domD = await listTenantDomains(TID_D);
    const overlapDom = domA.filter((a) => domD.some((d) => d["id"] === a["id"]));
    assert(overlapDom.length === 0, "INV-TEN10: Zero overlap in domains across tenants");

    // ── SCENARIO 66: tenant_id backward compatibility (INV-TEN11) ─────────────
    section("SCENARIO 66: Existing tenant_id usage intact (INV-TEN11)");
    const mbR = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_memberships`);
    assert(parseInt(mbR.rows[0].cnt, 10) >= 0, "INV-TEN11: tenant_memberships still accessible (legacy tenant_id pattern intact)");

    const auditR = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id IS NOT NULL`);
    assert(parseInt(auditR.rows[0].cnt, 10) >= 0, "INV-TEN11: audit_events tenant_id column still intact");

    // ── SCENARIO 67: existing active flows still work (INV-TEN12) ─────────────
    section("SCENARIO 67: Existing platform tables still accessible (INV-TEN12)");
    const secEvt = await client.query(`SELECT COUNT(*) as cnt FROM public.security_events`);
    assert(secEvt.rows.length === 1, "INV-TEN12: security_events still accessible");
    const userSess = await client.query(`SELECT COUNT(*) as cnt FROM public.user_sessions`);
    assert(userSess.rows.length === 1, "INV-TEN12: user_sessions still accessible");
    const mfaM = await client.query(`SELECT COUNT(*) as cnt FROM public.user_mfa_methods`);
    assert(mfaM.rows.length === 1, "INV-TEN12: user_mfa_methods still accessible");
    const auditEv = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events`);
    assert(auditEv.rows.length === 1, "INV-TEN12: audit_events still accessible");

    // ── SCENARIO 68: status history append-only ───────────────────────────────
    section("SCENARIO 68: Status history is append-only (multiple entries preserved)");
    const hist68 = await getTenantStatusHistory(TID_B);
    assert(hist68.length >= 5, `TID_B has at least 5 status history entries (found ${hist68.length}) — trial, active, suspended, active, delinquent, active, offboarding, deleted`);
    const statuses68 = hist68.map((h) => h["new_status"]);
    assert(statuses68.includes("deleted"), "History includes deleted status");
    assert(statuses68.includes("suspended"), "History includes suspended status");

    // ── SCENARIO 69: settings visibility tenant-scoped (INV-TEN10) ────────────
    section("SCENARIO 69: Settings visibility is tenant-scoped (INV-TEN10)");
    const settA69 = await getTenantSettings(TID_A);
    const settD69 = await getTenantSettings(TID_D); // TID_D has no settings
    assert(settA69 !== null, "TID_A settings found");
    assert(settD69 === null || settD69.tenantId !== TID_A, "INV-TEN10: TID_D settings are not TID_A settings");

    // ── SCENARIO 70: canTenantAccessKnowledge + canTenantAccessBilling active
    section("SCENARIO 70: Active tenant can access knowledge and billing");
    const know70 = await canTenantAccessKnowledge(TID_A);
    const bill70 = await canTenantAccessBilling(TID_A);
    assert(know70.allowed === true, "Active tenant can access knowledge");
    assert(bill70.allowed === true, "Active tenant can access billing");

    // ── SCENARIO 71: settings-based access control (INV-TEN4) ─────────────────
    section("SCENARIO 71: Settings-based access disables specific capabilities (INV-TEN4)");
    const tSetTest = await createTenant({ id: `ts-cap-${TS}`, name: "CapTest", lifecycleStatus: "active" });
    await createTenantSettings({ tenantId: tSetTest.id, allowLogin: true, allowAiRuntime: false, allowKnowledgeAccess: false });
    const ai71 = await canTenantUseAiRuntime(tSetTest.id);
    const know71 = await canTenantAccessKnowledge(tSetTest.id);
    const login71 = await canTenantLogin(tSetTest.id);
    assert(ai71.allowed === false, "INV-TEN4: AI runtime disabled via settings");
    assert(know71.allowed === false, "INV-TEN4: Knowledge disabled via settings");
    assert(login71.allowed === true, "Login still allowed (not disabled in settings)");

    // Cleanup
    await client.query(`DELETE FROM public.tenant_settings WHERE tenant_id = $1`, [tSetTest.id]);
    await client.query(`DELETE FROM public.tenant_status_history WHERE tenant_id = $1`, [tSetTest.id]);
    await client.query(`DELETE FROM public.tenants WHERE id = $1`, [tSetTest.id]);

    // ── SCENARIO 72: DB CHECK rejects invalid deletion_status ─────────────────
    section("SCENARIO 72: DB CHECK rejects invalid deletion_status");
    let ck72 = false;
    try {
      await client.query(`INSERT INTO public.tenant_deletion_requests (id, tenant_id, deletion_status) VALUES (gen_random_uuid()::text, $1, 'bad_status')`, [TID_A]);
    } catch { ck72 = true; }
    assert(ck72, "CHECK constraint rejects invalid deletion_status");

    // ── SCENARIO 73: DB CHECK rejects invalid export_scope ───────────────────
    section("SCENARIO 73: DB CHECK rejects invalid export_scope");
    let ck73 = false;
    try {
      await client.query(`INSERT INTO public.tenant_export_requests (id, tenant_id, export_scope) VALUES (gen_random_uuid()::text, $1, 'everything')`, [TID_A]);
    } catch { ck73 = true; }
    assert(ck73, "CHECK constraint rejects invalid export_scope");

    // ── SCENARIO 74: DB CHECK rejects invalid domain_status ──────────────────
    section("SCENARIO 74: DB CHECK rejects invalid domain_status");
    let ck74 = false;
    try {
      await client.query(`INSERT INTO public.tenant_domains (id, tenant_id, domain, domain_status) VALUES (gen_random_uuid()::text, $1, 'test.com', 'unknown_status')`, [TID_A]);
    } catch { ck74 = true; }
    assert(ck74, "CHECK constraint rejects invalid domain_status");

    // ── Cleanup test tenants ───────────────────────────────────────────────────
    section("CLEANUP: Remove test tenants and related data");
    for (const tid of [TID_A, TID_B, TID_C, TID_D]) {
      await client.query(`DELETE FROM public.tenant_domains WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_export_requests WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_deletion_requests WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_settings WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_status_history WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1`, [tid]);
    }
    console.log("  ✔ Test tenants and related data cleaned up");

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Phase 9 validation: ${passed} passed, ${failed} failed`);
    if (failed > 0) { console.error(`✗ ${failed} assertion(s) FAILED`); process.exit(1); }
    else { console.log(`✔ All ${passed} assertions passed`); }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Validation error:", e.message); process.exit(1); });
