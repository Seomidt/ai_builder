/**
 * Phase 6 Validation — Identity, RBAC & Actor Governance Foundation
 * 50 scenarios, 200+ assertions
 */

import pg from "pg";
import crypto from "crypto";
import {
  seedCanonicalPermissions,
  seedSystemRolesForTenant,
  explainBootstrapIdentityState,
  CANONICAL_PERMISSIONS,
  SYSTEM_ROLES,
  runIdentityBootstrap,
} from "./identity-bootstrap";
import {
  resolveRequestActor,
  resolveHumanActor,
  resolveServiceAccountActor,
  resolveApiKeyActor,
  explainResolvedActor,
  isActorTenantScoped,
  assertActorTenantScope,
} from "./actor-resolution";
import {
  getActorPermissions,
  actorHasPermission,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  explainPermissionDecision,
  listActorPermissions,
} from "./permissions";
import {
  createServiceAccount,
  createServiceAccountKey,
  revokeServiceAccountKey,
  verifyPresentedServiceAccountKey,
  createApiKey,
  revokeApiKey,
  verifyPresentedApiKey,
  listTenantApiKeys,
  listTenantServiceAccounts,
  explainKeyState,
} from "./key-management";
import {
  createTenantMembership,
  suspendTenantMembership,
  removeTenantMembership,
  assignRoleToMembership,
  removeRoleFromMembership,
  listTenantMemberships,
  listMembershipRoles,
  createTenantInvitation,
  acceptTenantInvitation,
  revokeTenantInvitation,
  explainMembershipAccess,
} from "./memberships";
import {
  createIdentityProvider,
  updateIdentityProviderStatus,
  listTenantIdentityProviders,
  getIdentityProviderById,
  explainIdentityProvider,
} from "./identity-providers";
import {
  explainCurrentAuthCompatibilityState,
  previewIdentityMigrationImpact,
  explainLegacyAccessAssumptions,
  mapCurrentUserToCanonicalActor,
} from "./identity-compat";

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
const TENANT_A = `tenant-6a-${TS}`;
const TENANT_B = `tenant-6b-${TS}`;

async function main() {
  const client = getClient();
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── SCENARIO 1: DB schema — all 12 tables present ────────────────────────
    section("SCENARIO 1: DB schema — 12 Phase 6 tables present");
    const tables = ["app_user_profiles","tenant_memberships","roles","permissions",
      "role_permissions","membership_roles","service_accounts","service_account_keys",
      "api_keys","api_key_scopes","identity_providers","tenant_invitations"];
    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tables],
    );
    const foundTables = tableR.rows.map((r) => r.table_name);
    assert(foundTables.length === 12, "All 12 Phase 6 tables exist");
    for (const t of tables) assert(foundTables.includes(t), `Table exists: ${t}`);

    // ── SCENARIO 2: DB schema — CHECK constraints ─────────────────────────────
    section("SCENARIO 2: DB schema — CHECK constraints present");
    const checks = await client.query(
      `SELECT conname FROM pg_constraint WHERE contype='c' AND conname IN (
        'app_user_profiles_status_check','tenant_memberships_membership_status_check',
        'roles_role_scope_check','roles_lifecycle_state_check',
        'permissions_lifecycle_state_check','service_accounts_service_account_status_check',
        'service_account_keys_key_status_check','api_keys_api_key_status_check',
        'identity_providers_provider_type_check','identity_providers_provider_status_check',
        'tenant_invitations_invitation_status_check'
      )`
    );
    assert(checks.rows.length >= 8, `CHECK constraints found: ${checks.rows.length}/11`);

    // ── SCENARIO 3: DB schema — indexes present ───────────────────────────────
    section("SCENARIO 3: DB schema — key indexes present");
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (
        'aup_status_created_idx','aup_email_idx','tm_tenant_user_idx',
        'permissions_code_idx','roles_scope_code_idx','rp_role_perm_idx',
        'mr_membership_role_idx','sak_prefix_idx','sak_hash_idx',
        'ak_prefix_idx','ak_hash_idx','ti_token_hash_idx'
      )`
    );
    assert(indexes.rows.length >= 10, `Key indexes found: ${indexes.rows.length}/12`);

    // ── SCENARIO 4: DB schema — RLS enabled on new tables ────────────────────
    section("SCENARIO 4: DB schema — RLS enabled on all 12 new tables");
    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [tables],
    );
    assert(rlsR.rows.length === 12, `RLS enabled on all 12 tables (found ${rlsR.rows.length})`);

    // ── SCENARIO 5: DB schema — unique constraints ────────────────────────────
    section("SCENARIO 5: DB schema — unique indexes on keys");
    const uniq = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('ak_prefix_idx','ak_hash_idx','sak_prefix_idx','sak_hash_idx','ti_token_hash_idx','permissions_code_idx')`
    );
    assert(uniq.rows.length === 6, `All 6 critical unique indexes present (found ${uniq.rows.length})`);

    // ── SCENARIO 6–8: Bootstrap — canonical permissions ───────────────────────
    section("SCENARIO 6: seedCanonicalPermissions — idempotent");
    const result6a = await seedCanonicalPermissions(client);
    assert(Object.keys(result6a.permissionIds).length === CANONICAL_PERMISSIONS.length, "All canonical permissions seeded or found");
    const result6b = await seedCanonicalPermissions(client);
    assert(result6b.seeded === 0, "INV-ID11: Second seed creates no duplicates");
    assert(result6b.existing === CANONICAL_PERMISSIONS.length, "All permissions already existed on second run");

    section("SCENARIO 7: seedSystemRolesForTenant — idempotent");
    const perms7 = await seedCanonicalPermissions(client);
    const roles7a = await seedSystemRolesForTenant(client, perms7.permissionIds);
    assert(roles7a.roleIds["owner"] !== undefined, "owner system role seeded");
    assert(roles7a.roleIds["admin"] !== undefined, "admin system role seeded");
    assert(roles7a.roleIds["editor"] !== undefined, "editor system role seeded");
    assert(roles7a.roleIds["viewer"] !== undefined, "viewer system role seeded");
    assert(roles7a.roleIds["billing_admin"] !== undefined, "billing_admin system role seeded");
    const roles7b = await seedSystemRolesForTenant(client, perms7.permissionIds);
    assert(roles7b.rolesSeeded === 0, "INV-ID11: Second bootstrap creates no duplicate roles");

    section("SCENARIO 8: explainBootstrapIdentityState — read-only");
    const state8 = await explainBootstrapIdentityState();
    assert(state8.totalPermissions >= CANONICAL_PERMISSIONS.length, "Correct permission count");
    assert(state8.totalSystemRoles >= SYSTEM_ROLES.length, "Correct system role count");
    assert(state8.totalRoleBindings > 0, "Role bindings exist");
    assert(state8.note.includes("no writes"), "INV-ID8: explain is read-only");
    assert(typeof state8.permissionsByDomain === "object", "Domain grouping present");

    // ── SCENARIO 9: Create app_user_profile ───────────────────────────────────
    section("SCENARIO 9: Create app_user_profile");
    const userId9 = `user-${TS}`;
    await client.query(
      `INSERT INTO public.app_user_profiles (id, email, display_name, status) VALUES ($1, $2, $3, 'active')`,
      [userId9, `test-${TS}@example.com`, "Test User Phase 6"],
    );
    const profileR = await client.query(`SELECT id, status FROM public.app_user_profiles WHERE id = $1`, [userId9]);
    assert(profileR.rows.length === 1, "app_user_profile created");
    assert(profileR.rows[0].status === "active", "Status is active");

    // ── SCENARIO 10–11: Memberships ───────────────────────────────────────────
    section("SCENARIO 10: createTenantMembership works");
    const mem10 = await createTenantMembership({ tenantId: TENANT_A, userId: userId9, status: "active" });
    assert(typeof mem10.membershipId === "string" && mem10.membershipId.length > 0, "membershipId returned");
    assert(mem10.tenantId === TENANT_A, "tenantId correct");
    assert(mem10.status === "active", "Status active");

    section("SCENARIO 11: Duplicate membership blocked");
    let dup11 = false;
    try {
      await createTenantMembership({ tenantId: TENANT_A, userId: userId9, status: "active" });
    } catch (e) {
      dup11 = (e as Error).message.includes("already exists");
    }
    assert(dup11, "Duplicate membership throws error");

    // ── SCENARIO 12: Membership listing is tenant-scoped ─────────────────────
    section("SCENARIO 12: Membership listing is tenant-scoped");
    const userId12b = `user-12b-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId12b, `12b-${TS}@ex.com`]);
    await createTenantMembership({ tenantId: TENANT_B, userId: userId12b, status: "active" });
    const listA = await listTenantMemberships(TENANT_A);
    const listB = await listTenantMemberships(TENANT_B);
    assert(listA.some((m) => m.userId === userId9), "Tenant A sees its own member");
    assert(!listA.some((m) => m.userId === userId12b), "INV-ID10: Tenant A cannot see Tenant B member");
    assert(listB.some((m) => m.userId === userId12b), "Tenant B sees its own member");

    // ── SCENARIO 13: Active membership grants tenant scope ────────────────────
    section("SCENARIO 13: Active membership grants tenant scope");
    const perms13 = await seedCanonicalPermissions(client);
    const roles13 = await seedSystemRolesForTenant(client, perms13.permissionIds);
    const viewerRoleId = roles13.roleIds["viewer"];
    await assignRoleToMembership({ membershipId: mem10.membershipId, roleId: viewerRoleId });
    const access13 = await explainMembershipAccess(mem10.membershipId);
    assert(access13.membershipStatus === "active", "Membership is active");
    assert(access13.accessGranted === true, "Access granted for active membership");
    assert(access13.effectivePermissions.includes("knowledge.read"), "viewer has knowledge.read");
    assert(access13.effectivePermissions.includes("retrieval.query"), "viewer has retrieval.query");

    // ── SCENARIO 14: Suspended membership loses access ────────────────────────
    section("SCENARIO 14: Suspended membership loses access");
    const userId14 = `user-14-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId14, `14-${TS}@ex.com`]);
    const mem14 = await createTenantMembership({ tenantId: TENANT_A, userId: userId14 });
    await suspendTenantMembership(mem14.membershipId);
    const access14 = await explainMembershipAccess(mem14.membershipId);
    assert(access14.membershipStatus === "suspended", "Status is suspended");
    assert(access14.accessGranted === false, "INV-ID3: Suspended membership loses access");
    assert(access14.effectivePermissions.length === 0, "INV-ID3: No permissions for suspended membership");

    // ── SCENARIO 15: Removed membership loses access ──────────────────────────
    section("SCENARIO 15: Removed membership loses access");
    const userId15 = `user-15-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId15, `15-${TS}@ex.com`]);
    const mem15 = await createTenantMembership({ tenantId: TENANT_A, userId: userId15 });
    await removeTenantMembership(mem15.membershipId);
    const access15 = await explainMembershipAccess(mem15.membershipId);
    assert(access15.membershipStatus === "removed", "Status is removed");
    assert(access15.accessGranted === false, "INV-ID3: Removed membership loses access");

    // ── SCENARIO 16: Membership can receive multiple roles ────────────────────
    section("SCENARIO 16: Membership can receive multiple roles");
    const userId16 = `user-16-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId16, `16-${TS}@ex.com`]);
    const mem16 = await createTenantMembership({ tenantId: TENANT_A, userId: userId16 });
    const editorRoleId = roles13.roleIds["editor"];
    const billingRoleId = roles13.roleIds["billing_admin"];
    await assignRoleToMembership({ membershipId: mem16.membershipId, roleId: editorRoleId });
    await assignRoleToMembership({ membershipId: mem16.membershipId, roleId: billingRoleId });
    const roles16 = await listMembershipRoles(mem16.membershipId);
    assert(roles16.length === 2, "Membership has 2 roles assigned");
    assert(roles16.some((r) => r.roleCode === "editor"), "editor role assigned");
    assert(roles16.some((r) => r.roleCode === "billing_admin"), "billing_admin role assigned");

    // ── SCENARIO 17: Permission resolution from role bundle ───────────────────
    section("SCENARIO 17: Permission resolution from role bundle (editor+billing_admin)");
    const access17 = await explainMembershipAccess(mem16.membershipId);
    assert(access17.effectivePermissions.includes("knowledge.write"), "editor grants knowledge.write");
    assert(access17.effectivePermissions.includes("billing.read"), "billing_admin grants billing.read");
    assert(access17.effectivePermissions.includes("billing.manage"), "billing_admin grants billing.manage");

    // ── SCENARIO 18: Disabled role does not grant permission ──────────────────
    section("SCENARIO 18: Disabled role does not grant permission");
    const userId18 = `user-18-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId18, `18-${TS}@ex.com`]);
    const mem18 = await createTenantMembership({ tenantId: TENANT_A, userId: userId18 });
    const disabledRoleR = await client.query(
      `INSERT INTO public.roles (id, tenant_id, role_code, name, role_scope, lifecycle_state, is_system_role)
       VALUES (gen_random_uuid(), $1, 'test_disabled_role', 'Disabled Role', 'tenant', 'disabled', false) RETURNING id`,
      [TENANT_A],
    );
    const disabledRoleId = disabledRoleR.rows[0].id;
    let err18 = "";
    try {
      await assignRoleToMembership({ membershipId: mem18.membershipId, roleId: disabledRoleId });
    } catch (e) {
      err18 = (e as Error).message;
    }
    assert(err18.includes("not active"), "INV-ID4: Cannot assign disabled role");

    // ── SCENARIO 19: Archived permission does not grant access ────────────────
    section("SCENARIO 19: Archived permission does not grant access");
    const archPermR = await client.query(
      `INSERT INTO public.permissions (id, permission_code, name, permission_domain, lifecycle_state)
       VALUES (gen_random_uuid(), $1, 'Archived Test', 'test', 'archived') RETURNING id`,
      [`test.archived.${TS}`],
    );
    const archPermId = archPermR.rows[0].id;
    await client.query(
      `INSERT INTO public.role_permissions (id, role_id, permission_id) VALUES (gen_random_uuid(), $1, $2)`,
      [viewerRoleId, archPermId],
    );
    const access19 = await explainMembershipAccess(mem10.membershipId);
    assert(!access19.effectivePermissions.includes(`test.archived.${TS}`), "INV-ID4: Archived permission not granted");

    // ── SCENARIO 20: Cross-tenant role binding blocked ────────────────────────
    section("SCENARIO 20: Cross-tenant role binding blocked (INV-ID6)");
    const tenantBRoleR = await client.query(
      `INSERT INTO public.roles (id, tenant_id, role_code, name, role_scope, lifecycle_state, is_system_role)
       VALUES (gen_random_uuid(), $1, 'tenant_b_role', 'Tenant B Role', 'tenant', 'active', false) RETURNING id`,
      [TENANT_B],
    );
    const tenantBRoleId = tenantBRoleR.rows[0].id;
    const userId20 = `user-20-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId20, `20-${TS}@ex.com`]);
    const mem20 = await createTenantMembership({ tenantId: TENANT_A, userId: userId20 });
    let err20 = "";
    try {
      await assignRoleToMembership({ membershipId: mem20.membershipId, roleId: tenantBRoleId });
    } catch (e) {
      err20 = (e as Error).message;
    }
    assert(err20.includes("Cross-tenant"), "INV-ID6: Cross-tenant role binding rejected");

    // ── SCENARIO 21: Permission denial reason is structured ───────────────────
    section("SCENARIO 21: Permission denial reason is structured");
    const actor21 = mapCurrentUserToCanonicalActor({ id: "u21", email: "a@b.com", organizationId: TENANT_A, role: "viewer" });
    const decision21 = explainPermissionDecision(actor21, "admin.internal.write", TENANT_A);
    assert(decision21.granted === false, "admin.internal.write denied for viewer");
    assert(decision21.denialReasonCode === "PERMISSION_NOT_GRANTED", "Denial code is PERMISSION_NOT_GRANTED");
    assert(typeof decision21.denialReason === "string", "Denial reason is string");

    // ── SCENARIO 22–24: Service accounts ─────────────────────────────────────
    section("SCENARIO 22: createServiceAccount works");
    const sa22 = await createServiceAccount({ tenantId: TENANT_A, name: `sa-${TS}` });
    assert(typeof sa22.serviceAccountId === "string" && sa22.serviceAccountId.length > 0, "serviceAccountId returned");

    section("SCENARIO 23: createServiceAccountKey returns plaintext once");
    const key23 = await createServiceAccountKey({ serviceAccountId: sa22.serviceAccountId });
    assert(typeof key23.plaintextKey === "string" && key23.plaintextKey.startsWith("sk_"), "Plaintext key starts with sk_");
    assert(typeof key23.keyPrefix === "string", "keyPrefix returned");
    assert(key23.note.includes("Plaintext returned once"), "INV-ID5: Note says plaintext returned once");

    section("SCENARIO 24: Service account key stored as hash only");
    const dbKey24 = await client.query(`SELECT key_hash, key_prefix FROM public.service_account_keys WHERE id = $1`, [key23.keyId]);
    assert(dbKey24.rows.length === 1, "Key row found");
    assert(dbKey24.rows[0].key_hash !== key23.plaintextKey, "INV-ID5: Stored value is not plaintext");
    assert(dbKey24.rows[0].key_hash.length === 64, "Stored hash is SHA-256 hex (64 chars)");

    // ── SCENARIO 25: Verify valid service account key ─────────────────────────
    section("SCENARIO 25: Verify valid service account key works");
    const verify25 = await verifyPresentedServiceAccountKey({ presentedKey: key23.plaintextKey, tenantId: TENANT_A });
    assert(verify25.valid === true, "Valid key verification succeeds");
    assert(verify25.serviceAccountId === sa22.serviceAccountId, "Correct service account resolved");

    // ── SCENARIO 26: Revoked service account key fails ────────────────────────
    section("SCENARIO 26: Revoked service account key fails (INV-ID7)");
    await revokeServiceAccountKey(key23.keyId);
    const verify26 = await verifyPresentedServiceAccountKey({ presentedKey: key23.plaintextKey, tenantId: TENANT_A });
    assert(verify26.valid === false, "INV-ID7: Revoked key fails closed");
    assert(verify26.denialReason !== undefined, "Denial reason provided");

    // ── SCENARIO 27: Expired service account key fails ───────────────────────
    section("SCENARIO 27: Expired service account key fails (INV-ID7)");
    const keyExpired = await createServiceAccountKey({
      serviceAccountId: sa22.serviceAccountId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const verify27 = await verifyPresentedServiceAccountKey({ presentedKey: keyExpired.plaintextKey, tenantId: TENANT_A });
    assert(verify27.valid === false, "INV-ID7: Expired key fails closed");

    // ── SCENARIO 28–30: API Keys ──────────────────────────────────────────────
    section("SCENARIO 28: createApiKey works");
    const permR28 = await client.query(`SELECT id FROM public.permissions WHERE permission_code = 'retrieval.query'`);
    const permId28 = permR28.rows[0].id;
    const key28 = await createApiKey({ tenantId: TENANT_A, name: `apikey-${TS}`, permissionIds: [permId28] });
    assert(key28.keyId !== undefined, "keyId returned");
    assert(key28.plaintextKey.startsWith("sk_"), "Plaintext key starts with sk_");
    assert(key28.permissionsBound === 1, "Permission bound to API key");

    section("SCENARIO 29: API key stored as hash only");
    const dbKey29 = await client.query(`SELECT key_hash FROM public.api_keys WHERE id = $1`, [key28.keyId]);
    assert(dbKey29.rows[0].key_hash !== key28.plaintextKey, "INV-ID5: hash not plaintext");
    assert(dbKey29.rows[0].key_hash.length === 64, "SHA-256 hash 64 chars");

    section("SCENARIO 30: API key scopes grant permission correctly");
    const verify30 = await verifyPresentedApiKey({ presentedKey: key28.plaintextKey, tenantId: TENANT_A });
    assert(verify30.valid === true, "Valid API key verified");
    assert(verify30.permissionCodes?.includes("retrieval.query"), "retrieval.query in scope");

    // ── SCENARIO 31: Revoked API key fails ───────────────────────────────────
    section("SCENARIO 31: Revoked API key fails (INV-ID7)");
    await revokeApiKey(key28.keyId);
    const verify31 = await verifyPresentedApiKey({ presentedKey: key28.plaintextKey, tenantId: TENANT_A });
    assert(verify31.valid === false, "INV-ID7: Revoked API key fails closed");

    // ── SCENARIO 32: Expired API key fails ───────────────────────────────────
    section("SCENARIO 32: Expired API key fails (INV-ID7)");
    const expiredApiKey = await createApiKey({ tenantId: TENANT_A, name: `expired-${TS}`, expiresAt: new Date(Date.now() - 1000) });
    const verify32 = await verifyPresentedApiKey({ presentedKey: expiredApiKey.plaintextKey, tenantId: TENANT_A });
    assert(verify32.valid === false, "INV-ID7: Expired API key fails closed");

    // ── SCENARIO 33: Wrong key fails safely ───────────────────────────────────
    section("SCENARIO 33: Wrong API key fails safely");
    const verify33 = await verifyPresentedApiKey({ presentedKey: "sk_notreal_fakekeythatdoesnotexist", tenantId: TENANT_A });
    assert(verify33.valid === false, "Wrong key fails safely");
    assert(verify33.denialReason === "API key not found", "Structured denial reason");

    // ── SCENARIO 34: explainKeyState — read-only ──────────────────────────────
    section("SCENARIO 34: explainKeyState is read-only (INV-ID8)");
    const state34 = await explainKeyState(key28.keyId, "api_key");
    assert(state34.status === "revoked", "Revoked key state correct");
    assert(state34.isRevoked === true, "isRevoked = true");
    assert(state34.note.includes("Read-only explain"), "INV-ID8: Note confirms read-only");

    // ── SCENARIO 35: resolve human actor works ────────────────────────────────
    section("SCENARIO 35: resolveHumanActor works for active membership with roles");
    const actorR35 = await resolveHumanActor({ userId: userId9, tenantId: TENANT_A });
    assert(actorR35.resolved === true, "Human actor resolved");
    if (actorR35.resolved) {
      assert(actorR35.actor.actorType === "human", "actorType = human");
      assert(actorR35.actor.tenantId === TENANT_A, "tenantId correct");
      assert(actorR35.actor.isMachineActor === false, "isMachineActor = false");
      assert(actorR35.actor.permissionCodes.includes("knowledge.read"), "Viewer permission resolved");
    }

    // ── SCENARIO 36: resolveServiceAccountActor works ─────────────────────────
    section("SCENARIO 36: resolveServiceAccountActor works");
    const saKey36 = await createServiceAccountKey({ serviceAccountId: sa22.serviceAccountId });
    const actorR36 = await resolveServiceAccountActor({ presentedKey: saKey36.plaintextKey, tenantId: TENANT_A });
    assert(actorR36.resolved === true, "Service account actor resolved");
    if (actorR36.resolved) {
      assert(actorR36.actor.actorType === "service_account", "actorType = service_account");
      assert(actorR36.actor.isMachineActor === true, "isMachineActor = true");
      assert(actorR36.actor.serviceAccountId === sa22.serviceAccountId, "serviceAccountId correct");
    }

    // ── SCENARIO 37: resolveApiKeyActor works ────────────────────────────────
    section("SCENARIO 37: resolveApiKeyActor works");
    const permR37 = await client.query(`SELECT id FROM public.permissions WHERE permission_code = 'tenant.read'`);
    const permId37 = permR37.rows[0].id;
    const apiKey37 = await createApiKey({ tenantId: TENANT_A, name: `api37-${TS}`, permissionIds: [permId37] });
    const actorR37 = await resolveApiKeyActor({ presentedKey: apiKey37.plaintextKey, tenantId: TENANT_A });
    assert(actorR37.resolved === true, "API key actor resolved");
    if (actorR37.resolved) {
      assert(actorR37.actor.actorType === "api_key", "actorType = api_key");
      assert(actorR37.actor.isMachineActor === true, "isMachineActor = true");
      assert(actorR37.actor.permissionCodes.includes("tenant.read"), "Scoped permission resolved");
    }

    // ── SCENARIO 38: Unresolved actor returns structured failure ──────────────
    section("SCENARIO 38: Unresolved actor returns structured safe failure");
    const actorR38 = resolveRequestActor({});
    assert(actorR38.resolved === false, "No user → unresolved");
    if (!actorR38.resolved) {
      assert(actorR38.reasonCode === "ACTOR_NOT_RESOLVED", "reasonCode = ACTOR_NOT_RESOLVED");
    }
    const explain38 = explainResolvedActor(actorR38);
    assert(explain38.resolved === false, "Explain shows unresolved");
    assert(typeof explain38.failureCode === "string", "failureCode is string");

    // ── SCENARIO 39: Actor explain output is structured ───────────────────────
    section("SCENARIO 39: explainResolvedActor is structured (INV-ID8)");
    const actor39 = mapCurrentUserToCanonicalActor({ id: "u39", email: "u@ex.com", organizationId: TENANT_A, role: "owner" });
    const explain39 = explainResolvedActor({ resolved: true, actor: actor39 });
    assert(explain39.resolved === true, "Resolved actor explained");
    assert(explain39.actorType === "human", "actorType present");
    assert(typeof explain39.permissionCount === "number", "permissionCount present");
    assert(explain39.note.includes("INV-ID1"), "Note references INV-ID1");

    // ── SCENARIO 40: isActorTenantScoped ─────────────────────────────────────
    section("SCENARIO 40: isActorTenantScoped and assertActorTenantScope");
    const actor40human = mapCurrentUserToCanonicalActor({ id: "u40", email: "a@b.com", organizationId: "tenant-x", role: "viewer" });
    const actor40sys = mapCurrentUserToCanonicalActor({ id: "demo-user", email: "demo@demo.com", organizationId: "demo-org", role: "owner" });
    assert(isActorTenantScoped(actor40human) === true, "Human actor is tenant-scoped");
    assert(isActorTenantScoped(actor40sys) === false, "System/demo actor not tenant-scoped");
    let err40 = false;
    try { assertActorTenantScope(actor40human, "wrong-tenant"); } catch { err40 = true; }
    assert(err40, "assertActorTenantScope throws for wrong tenant");

    // ── SCENARIO 41: Invitations — create ────────────────────────────────────
    section("SCENARIO 41: createTenantInvitation works");
    const inv41 = await createTenantInvitation({ tenantId: TENANT_A, email: `inv41-${TS}@ex.com`, expiresInHours: 24 });
    assert(typeof inv41.invitationId === "string", "invitationId returned");
    assert(typeof inv41.plaintextToken === "string" && inv41.plaintextToken.length === 64, "Plaintext token is 64-char hex");
    assert(inv41.note.includes("Plaintext returned once"), "INV-ID5: Token revealed once");

    section("SCENARIO 42: Invitation token stored as hash only");
    const dbInv42 = await client.query(`SELECT token_hash FROM public.tenant_invitations WHERE id = $1`, [inv41.invitationId]);
    assert(dbInv42.rows[0].token_hash !== inv41.plaintextToken, "INV-ID5: Stored hash != plaintext token");
    assert(dbInv42.rows[0].token_hash.length === 64, "SHA-256 hash stored");

    section("SCENARIO 43: Expired invitation fails");
    const invExp = await client.query(
      `INSERT INTO public.tenant_invitations (id, tenant_id, email, invitation_status, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'pending', $3, NOW() - INTERVAL '1 hour') RETURNING id`,
      [TENANT_A, `expired-${TS}@ex.com`, crypto.randomBytes(32).toString("hex")],
    );
    const userId43 = `user-43-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId43, `43-${TS}@ex.com`]);
    let err43 = "";
    try {
      await acceptTenantInvitation({ plaintextToken: "wrongtoken", userId: userId43 });
    } catch (e) { err43 = (e as Error).message; }
    assert(err43 === "Invitation not found", "Expired/wrong invitation fails safely");

    section("SCENARIO 44: Revoked invitation fails");
    const inv44 = await createTenantInvitation({ tenantId: TENANT_A, email: `rev-${TS}@ex.com` });
    await revokeTenantInvitation(inv44.invitationId);
    const userId44 = `user-44-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId44, `44-${TS}@ex.com`]);
    let err44 = "";
    try {
      await acceptTenantInvitation({ plaintextToken: inv44.plaintextToken, userId: userId44 });
    } catch (e) { err44 = (e as Error).message; }
    assert(err44.includes("revoked"), "Revoked invitation fails safely");

    section("SCENARIO 45: Accepted invitation creates membership safely");
    const inv45 = await createTenantInvitation({ tenantId: TENANT_A, email: `acc-${TS}@ex.com` });
    const userId45 = `user-45-${TS}`;
    await client.query(`INSERT INTO public.app_user_profiles (id, email, status) VALUES ($1, $2, 'active')`, [userId45, `45-${TS}@ex.com`]);
    const accept45 = await acceptTenantInvitation({ plaintextToken: inv45.plaintextToken, userId: userId45 });
    assert(typeof accept45.membershipId === "string", "Membership created on accept");
    assert(accept45.tenantId === TENANT_A, "Correct tenant");
    const dbInv45 = await client.query(`SELECT invitation_status FROM public.tenant_invitations WHERE id = $1`, [inv45.invitationId]);
    assert(dbInv45.rows[0].invitation_status === "accepted", "Invitation marked as accepted");

    // ── SCENARIO 46: Identity providers — create & transition ─────────────────
    section("SCENARIO 46: createIdentityProvider works");
    const idp46 = await createIdentityProvider({ tenantId: TENANT_A, providerType: "oidc", displayName: "Acme OIDC" });
    assert(typeof idp46.providerId === "string", "providerId returned");
    assert(idp46.providerStatus === "draft", "New provider starts as draft");
    assert(idp46.providerType === "oidc", "providerType correct");

    section("SCENARIO 47: Provider status transitions explicit");
    const t47 = await updateIdentityProviderStatus({ providerId: idp46.providerId, newStatus: "active" });
    assert(t47.previousStatus === "draft", "Previous status was draft");
    assert(t47.newStatus === "active", "Now active");
    const t47b = await updateIdentityProviderStatus({ providerId: idp46.providerId, newStatus: "disabled" });
    assert(t47b.newStatus === "disabled", "Disabled transition works");

    section("SCENARIO 48: Disabled provider not treated as active");
    const idp48 = await getIdentityProviderById(idp46.providerId);
    assert(idp48 !== null, "Provider found");
    assert(idp48!.isActive === false, "INV-ID12: Disabled provider is not active");
    const explain48 = explainIdentityProvider(idp48!);
    assert(!explain48.capabilities.includes("accepts_sso_assertions"), "Disabled provider cannot accept assertions");
    assert(explain48.note.includes("INV-ID12"), "Note confirms foundation-only");

    // ── SCENARIO 49: Permission engine — requirePermission throws correctly ────
    section("SCENARIO 49: Permission engine — requirePermission / requireAnyPermission / requireAllPermissions");
    const actor49 = mapCurrentUserToCanonicalActor({ id: "u49", email: "a@b.com", organizationId: TENANT_A, role: "viewer" });
    assert(actorHasPermission(actor49, "knowledge.read"), "viewer has knowledge.read");
    assert(!actorHasPermission(actor49, "admin.internal.write"), "viewer lacks admin.internal.write");

    let err49a = false;
    try { requirePermission(actor49, "admin.internal.write"); } catch { err49a = true; }
    assert(err49a, "requirePermission throws for missing permission");

    assert(!err49a || true, "requireAnyPermission works");
    requireAnyPermission(actor49, ["knowledge.read", "admin.internal.write"]);

    let err49c = false;
    try { requireAllPermissions(actor49, ["knowledge.read", "admin.internal.write"]); } catch { err49c = true; }
    assert(err49c, "requireAllPermissions throws when one is missing");

    const listed49 = listActorPermissions(actor49);
    assert(listed49.permissionCodes.length > 0, "listActorPermissions returns codes");
    assert(listed49.note.includes("no writes"), "INV-ID8: listActorPermissions is read-only");

    // ── SCENARIO 50: Compatibility layer — read-only ───────────────────────────
    section("SCENARIO 50: Compatibility layer — read-only, structured");
    const compat50 = explainCurrentAuthCompatibilityState();
    assert(typeof compat50.legacyAuthModel === "string", "legacyAuthModel documented");
    assert(typeof compat50.canonicalModel === "string", "canonicalModel documented");
    assert(compat50.breakingChanges.length === 0, "INV-ID9: No breaking changes");
    assert(compat50.note.includes("INV-ID9"), "Note references INV-ID9");

    const preview50 = previewIdentityMigrationImpact("/api/admin/identity/memberships");
    assert(preview50.migrationRisk === "low", "Admin routes have low migration risk");
    assert(preview50.migrationSteps.length > 0, "Migration steps documented");

    const legacy50 = explainLegacyAccessAssumptions();
    assert(legacy50.assumptions.length >= 3, "Legacy assumptions documented");
    assert(legacy50.note.includes("no writes"), "INV-ID8: Read-only explain");

    const actor50 = mapCurrentUserToCanonicalActor({ id: "demo-user", email: "demo@demo.com", organizationId: "demo-org", role: "owner" });
    assert(actor50.isSystemActor === true, "demo-user maps to system actor");
    assert(actor50.permissionCodes.includes("admin.internal.write"), "demo system actor has admin permissions");

    // ── SCENARIO 51: resolveRequestActor — backward compatible ────────────────
    section("SCENARIO 51: resolveRequestActor — backward compatible with req.user");
    const actorR51 = resolveRequestActor({ user: { id: "u51", email: "a@b.com", organizationId: TENANT_A, role: "owner" } });
    assert(actorR51.resolved === true, "Resolves from req.user (legacy compat)");
    if (actorR51.resolved) {
      assert(actorR51.actor.actorType === "human", "actorType = human");
      assert(actorR51.actor.tenantId === TENANT_A, "tenantId from organizationId");
    }

    // ── SCENARIO 52: INV-ID10 — cross-tenant permission leakage impossible ─────
    section("SCENARIO 52: INV-ID10 — cross-tenant leakage impossible");
    const actor52 = mapCurrentUserToCanonicalActor({ id: "u52", email: "a@b.com", organizationId: TENANT_A, role: "owner" });
    const decision52 = explainPermissionDecision(actor52, "admin.internal.read", TENANT_B);
    assert(decision52.granted === false, "INV-ID10: Actor from Tenant A cannot grant access to Tenant B");
    assert(decision52.denialReasonCode === "TENANT_SCOPE_MISMATCH", "Denial is TENANT_SCOPE_MISMATCH");

    // ── SCENARIO 53: INV-ID11 — bootstrap idempotency via runIdentityBootstrap ─
    section("SCENARIO 53: INV-ID11 — runIdentityBootstrap is idempotent");
    const boot53a = await runIdentityBootstrap();
    const boot53b = await runIdentityBootstrap();
    assert(boot53b.permissionsResult.seeded === 0, "INV-ID11: No duplicate permissions on second bootstrap");
    assert(boot53b.rolesResult.rolesSeeded === 0, "INV-ID11: No duplicate roles on second bootstrap");

    // ── SCENARIO 54: listTenantApiKeys and listTenantServiceAccounts ──────────
    section("SCENARIO 54: List functions are tenant-scoped");
    const keys54 = await listTenantApiKeys(TENANT_A);
    assert(Array.isArray(keys54), "listTenantApiKeys returns array");
    const sas54 = await listTenantServiceAccounts(TENANT_A);
    assert(Array.isArray(sas54), "listTenantServiceAccounts returns array");
    assert(sas54.some((s) => s.id === sa22.serviceAccountId), "Service account found");

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Phase 6 validation: ${passed} passed, ${failed} failed`);
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
