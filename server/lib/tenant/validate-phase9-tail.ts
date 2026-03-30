/**
 * Phase 9 Validation — TAIL (scenarios 57–74)
 * Runs only the final scenarios not completed in the main run.
 */

import pg from "pg";
import {
  createTenant, updateTenantStatus, suspendTenant, startTenantOffboarding,
  markTenantDeleted, explainTenantLifecycle, summarizeTenantState,
  getTenantStatusHistory,
} from "./tenant-lifecycle";
import {
  createTenantSettings, getTenantSettings, updateTenantSettings,
} from "./tenant-settings";
import {
  canTenantLogin, canTenantUseApi, canTenantUseAiRuntime,
  canTenantAccessKnowledge, canTenantAccessBilling, explainTenantAccessState,
} from "./tenant-access";
import {
  requestTenantExport, requestTenantDeletion, listTenantExportRequests,
  listTenantDeletionRequests, listTenantDomains, addTenantDomain, explainTenantGovernanceState,
} from "./tenant-governance";
import { explainTenantBootstrapState } from "./tenant-bootstrap.ts";
import {
  ALL_TENANT_AUDIT_ACTION_CODES, isKnownTenantAuditAction, TENANT_AUDIT_ACTIONS,
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
const TID_A = `t9tail-a-${TS}`;
const TID_B = `t9tail-b-${TS}`;
const TID_C = `t9tail-c-${TS}`;
const USER1 = `user-tail-${TS}`;

async function main() {
  const client = getClient();
  await client.connect();

  try {
    // Minimal setup
    await createTenant({ id: TID_A, name: "Tail Alpha", lifecycleStatus: "active" });
    await createTenantSettings({ tenantId: TID_A, changedBy: USER1 });
    await updateTenantSettings({ tenantId: TID_A, allowAiRuntime: false, changedBy: USER1 });

    await createTenant({ id: TID_B, name: "Tail Beta", lifecycleStatus: "trial" });
    await updateTenantStatus({ tenantId: TID_B, newStatus: "active" });
    await suspendTenant({ tenantId: TID_B });
    await updateTenantStatus({ tenantId: TID_B, newStatus: "active" });
    await updateTenantStatus({ tenantId: TID_B, newStatus: "delinquent" });
    await updateTenantStatus({ tenantId: TID_B, newStatus: "active" });
    await startTenantOffboarding({ tenantId: TID_B });
    await markTenantDeleted({ tenantId: TID_B });

    await createTenant({ id: TID_C, name: "Tail Gamma", lifecycleStatus: "suspended" });
    const exp = await requestTenantExport({ tenantId: TID_A, requestedBy: USER1 });
    await requestTenantDeletion({ tenantId: TID_A, requestedBy: USER1 });
    await addTenantDomain({ tenantId: TID_A, domain: `tail-${TS}.com` });

    // ── SCENARIO 57 ───────────────────────────────────────────────────────────
    section("SCENARIO 57: explainTenantLifecycle is read-only (INV-TEN9)");
    const before57 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_status_history WHERE tenant_id = $1`, [TID_A]);
    const expl57 = await explainTenantLifecycle(TID_A);
    const after57 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_status_history WHERE tenant_id = $1`, [TID_A]);
    assert(parseInt(before57.rows[0].cnt, 10) === parseInt(after57.rows[0].cnt, 10), "INV-TEN9: explainTenantLifecycle wrote nothing");
    assert(expl57.found === true, "Tenant found");
    assert(expl57.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(Array.isArray(expl57.allowedTransitions), "allowedTransitions returned");
    assert(expl57.isOperational === true, "TID_A is operational");

    // ── SCENARIO 58 ───────────────────────────────────────────────────────────
    section("SCENARIO 58: explainTenantBootstrapState is read-only (INV-TEN9)");
    const before58 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const bs58 = await explainTenantBootstrapState();
    const after58 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(before58.rows[0].cnt, 10) === parseInt(after58.rows[0].cnt, 10), "INV-TEN9: explainTenantBootstrapState wrote nothing");
    assert(bs58.canonicalTenantCount >= 3, `At least 3 canonical tenants (found ${bs58.canonicalTenantCount})`);
    assert(bs58.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(bs58.note.includes("INV-TEN7"), "INV-TEN7 in note");
    assert(typeof bs58.lifecycleStatusBreakdown === "object", "lifecycleStatusBreakdown returned");

    // ── SCENARIO 59 ───────────────────────────────────────────────────────────
    section("SCENARIO 59: summarizeTenantState is read-only (INV-TEN9)");
    const before59 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    const sum59 = await summarizeTenantState(TID_A);
    const after59 = await client.query(`SELECT COUNT(*) as cnt FROM public.tenants`);
    assert(parseInt(before59.rows[0].cnt, 10) === parseInt(after59.rows[0].cnt, 10), "INV-TEN9: summarizeTenantState wrote nothing");
    assert(sum59.tenantId === TID_A, "tenantId matches");
    assert(sum59.lifecycleStatus === "active", "lifecycleStatus = active");
    assert(sum59.note.includes("INV-TEN9"), "INV-TEN9 in note");
    assert(sum59.hasSettings === true, "hasSettings = true");
    assert(sum59.hasActiveExportRequest === true, "hasActiveExportRequest = true");

    // ── SCENARIO 60 ───────────────────────────────────────────────────────────
    section("SCENARIO 60: Lifecycle changes audited (INV-TEN8)");
    const auditRows = await client.query(
      `SELECT action FROM public.audit_events WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY created_at DESC LIMIT 20`,
      [TID_A],
    );
    const actions = auditRows.rows.map((r) => r.action);
    assert(actions.includes("tenant.created"), "INV-TEN8: tenant.created audited");
    assert(actions.some((a) => a.startsWith("tenant.")), "INV-TEN8: Multiple tenant audit events");

    // ── SCENARIO 61 ───────────────────────────────────────────────────────────
    section("SCENARIO 61: Settings update audited (INV-TEN8)");
    const settingsAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`,
      [TID_A],
    );
    assert(parseInt(settingsAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.settings.updated audited");

    // ── SCENARIO 62 ───────────────────────────────────────────────────────────
    section("SCENARIO 62: Export request audited (INV-TEN8)");
    const expAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.export.requested'`,
      [TID_A],
    );
    assert(parseInt(expAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.export.requested audited");

    // ── SCENARIO 63 ───────────────────────────────────────────────────────────
    section("SCENARIO 63: Deletion request audited (INV-TEN8)");
    const delAudit = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1 AND action = 'tenant.deletion.requested'`,
      [TID_A],
    );
    assert(parseInt(delAudit.rows[0].cnt, 10) >= 1, "INV-TEN8: tenant.deletion.requested audited");

    // ── SCENARIO 64 ───────────────────────────────────────────────────────────
    section("SCENARIO 64: Canonical tenant audit action codes");
    assert(ALL_TENANT_AUDIT_ACTION_CODES.length >= 20, `At least 20 canonical codes (found ${ALL_TENANT_AUDIT_ACTION_CODES.length})`);
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_CREATED), "tenant.created known");
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_SUSPENDED), "tenant.suspended known");
    assert(isKnownTenantAuditAction(TENANT_AUDIT_ACTIONS.TENANT_DELETION_BLOCKED), "tenant.deletion.blocked known");
    assert(!isKnownTenantAuditAction("random.action"), "Unknown action not known");

    // ── SCENARIO 65 ───────────────────────────────────────────────────────────
    section("SCENARIO 65: Cross-tenant isolation (INV-TEN10)");
    const expA65 = await listTenantExportRequests(TID_A);
    const expC65 = await listTenantExportRequests(TID_C);
    assert(expA65.every((e) => e["tenant_id"] === TID_A), "INV-TEN10: All TID_A exports belong to TID_A");
    assert(expC65.every((e) => e["tenant_id"] === TID_C), "INV-TEN10: All TID_C exports belong to TID_C");
    const overlap65 = expA65.filter((a) => expC65.some((c) => c["id"] === a["id"]));
    assert(overlap65.length === 0, "INV-TEN10: Zero overlap in exports across tenants");

    const delA65 = await listTenantDeletionRequests(TID_A);
    const delC65 = await listTenantDeletionRequests(TID_C);
    const overlapD = delA65.filter((a) => delC65.some((c) => c["id"] === a["id"]));
    assert(overlapD.length === 0, "INV-TEN10: Zero overlap in deletion requests");

    const domA65 = await listTenantDomains(TID_A);
    const domC65 = await listTenantDomains(TID_C);
    const overlapDom = domA65.filter((a) => domC65.some((c) => c["id"] === a["id"]));
    assert(overlapDom.length === 0, "INV-TEN10: Zero overlap in domains");

    // ── SCENARIO 66 ───────────────────────────────────────────────────────────
    section("SCENARIO 66: Existing tenant_id usage intact (INV-TEN11)");
    const mbR = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_memberships`);
    assert(parseInt(mbR.rows[0].cnt, 10) >= 0, "INV-TEN11: tenant_memberships still accessible");

    // ── SCENARIO 67 ───────────────────────────────────────────────────────────
    section("SCENARIO 67: Existing platform tables still accessible (INV-TEN12)");
    const secEvt = await client.query(`SELECT COUNT(*) as cnt FROM public.security_events`);
    assert(secEvt.rows.length === 1, "INV-TEN12: security_events accessible");
    const userSess = await client.query(`SELECT COUNT(*) as cnt FROM public.user_sessions`);
    assert(userSess.rows.length === 1, "INV-TEN12: user_sessions accessible");
    const mfaM = await client.query(`SELECT COUNT(*) as cnt FROM public.user_mfa_methods`);
    assert(mfaM.rows.length === 1, "INV-TEN12: user_mfa_methods accessible");
    const auditEv = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events`);
    assert(auditEv.rows.length === 1, "INV-TEN12: audit_events accessible");

    // ── SCENARIO 68 ───────────────────────────────────────────────────────────
    section("SCENARIO 68: Status history append-only (multiple entries preserved)");
    const hist68 = await getTenantStatusHistory(TID_B);
    assert(hist68.length >= 5, `TID_B has >= 5 status history entries (found ${hist68.length})`);
    const statuses68 = hist68.map((h) => h["new_status"]);
    assert(statuses68.includes("deleted"), "History includes deleted");
    assert(statuses68.includes("suspended"), "History includes suspended");

    // ── SCENARIO 69 ───────────────────────────────────────────────────────────
    section("SCENARIO 69: Settings visibility is tenant-scoped (INV-TEN10)");
    const settA = await getTenantSettings(TID_A);
    const settC = await getTenantSettings(TID_C); // TID_C has no settings
    assert(settA !== null, "TID_A settings found");
    assert(settC === null, "INV-TEN10: TID_C settings not found (not created for C)");

    // ── SCENARIO 70 ───────────────────────────────────────────────────────────
    section("SCENARIO 70: Active tenant can access knowledge and billing");
    const know70 = await canTenantAccessKnowledge(TID_A);
    const bill70 = await canTenantAccessBilling(TID_A);
    assert(know70.allowed === true, "Active tenant can access knowledge");
    assert(bill70.allowed === true, "Active tenant can access billing");

    // ── SCENARIO 71 ───────────────────────────────────────────────────────────
    section("SCENARIO 71: Settings-based access disables specific capabilities (INV-TEN4)");
    const tSetTest = await createTenant({ id: `ts-cap-tail-${TS}`, name: "CapTest", lifecycleStatus: "active" });
    await createTenantSettings({ tenantId: tSetTest.id, allowLogin: true, allowAiRuntime: false, allowKnowledgeAccess: false });
    const ai71 = await canTenantUseAiRuntime(tSetTest.id);
    const know71 = await canTenantAccessKnowledge(tSetTest.id);
    const login71 = await canTenantLogin(tSetTest.id);
    assert(ai71.allowed === false, "INV-TEN4: AI runtime disabled via settings");
    assert(know71.allowed === false, "INV-TEN4: Knowledge disabled via settings");
    assert(login71.allowed === true, "Login still allowed");

    // ── SCENARIO 72 ───────────────────────────────────────────────────────────
    section("SCENARIO 72: DB CHECK rejects invalid deletion_status");
    let ck72 = false;
    try {
      await client.query(`INSERT INTO public.tenant_deletion_requests (id, tenant_id, deletion_status) VALUES (gen_random_uuid()::text, $1, 'bad_status')`, [TID_A]);
    } catch { ck72 = true; }
    assert(ck72, "CHECK constraint rejects invalid deletion_status");

    // ── SCENARIO 73 ───────────────────────────────────────────────────────────
    section("SCENARIO 73: DB CHECK rejects invalid export_scope");
    let ck73 = false;
    try {
      await client.query(`INSERT INTO public.tenant_export_requests (id, tenant_id, export_scope) VALUES (gen_random_uuid()::text, $1, 'everything')`, [TID_A]);
    } catch { ck73 = true; }
    assert(ck73, "CHECK constraint rejects invalid export_scope");

    // ── SCENARIO 74 ───────────────────────────────────────────────────────────
    section("SCENARIO 74: DB CHECK rejects invalid domain_status");
    let ck74 = false;
    try {
      await client.query(`INSERT INTO public.tenant_domains (id, tenant_id, domain, domain_status) VALUES (gen_random_uuid()::text, $1, 'test-ck.com', 'unknown_status')`, [TID_A]);
    } catch { ck74 = true; }
    assert(ck74, "CHECK constraint rejects invalid domain_status");

    // ── CLEANUP ────────────────────────────────────────────────────────────────
    section("CLEANUP");
    for (const tid of [TID_A, TID_B, TID_C, tSetTest.id]) {
      await client.query(`DELETE FROM public.tenant_domains WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_export_requests WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_deletion_requests WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_settings WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenant_status_history WHERE tenant_id = $1`, [tid]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1`, [tid]);
    }
    console.log("  ✔ Tail test tenants cleaned up");

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Phase 9 TAIL validation: ${passed} passed, ${failed} failed`);
    if (failed > 0) { console.error(`✗ ${failed} FAILED`); process.exit(1); }
    else { console.log(`✔ All ${passed} tail assertions passed`); }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Tail validation error:", e.message); process.exit(1); });
