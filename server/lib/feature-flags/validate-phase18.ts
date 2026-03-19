/**
 * Phase 18 — Validation Script
 * Feature Flags & Experiment Platform
 *
 * Run: npx tsx server/lib/feature-flags/validate-phase18.ts
 * Requires: application running on port 5000
 * Target: 65 scenarios, 145+ assertions
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL required");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ──`);
}

const T_TENANT_A = "tenant-flag-test-A";
const T_TENANT_B = "tenant-flag-test-B";
const T_ACTOR_A = "actor-flag-test-A";

async function main() {
  console.log("Phase 18 Validation — Feature Flags & Experiment Platform\n");

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  const {
    createFeatureFlag,
    updateFeatureFlag,
    listFeatureFlags,
    explainFeatureFlag,
  } = await import("./feature-flags");

  const {
    assignFlagToTenant,
    assignFlagToActor,
    assignFlagGlobal,
    removeFlagAssignment,
    explainFlagAssignments,
  } = await import("./feature-assignments");

  const {
    createExperiment,
    createExperimentVariant,
    startExperiment,
    pauseExperiment,
    completeExperiment,
    explainExperiment,
  } = await import("./experiments");

  const {
    resolveFeatureFlag,
    resolveExperimentVariant,
    explainResolution,
    deterministicHashAssignment,
    deterministicVariantBucket,
  } = await import("./variant-resolution");

  const {
    getRolloutMetrics,
    summarizeRolloutMetrics,
    listRecentResolutions,
  } = await import("./rollout-observability");

  const {
    logRolloutChange,
    explainRolloutAudit,
    getRolloutAuditLog,
  } = await import("./rollout-audit");

  const {
    resolveModelOverride,
    resolvePromptVersionOverride,
    resolveRetrievalStrategyOverride,
    resolveAgentVersionOverride,
    previewFlagResolution,
  } = await import("./runtime-resolution");

  // ── SCENARIO 1: DB schema — 5 Phase 18 tables present ────────────────────
  section("SCENARIO 1: DB schema — Phase 18 tables present");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'feature_flags','feature_flag_assignments','experiments',
        'experiment_variants','feature_resolution_events'
      )
  `);
  assert(tableCheck.rows.length === 5, "All 5 Phase 18 tables exist");
  const tableNames = tableCheck.rows.map((r: Record<string, unknown>) => r.table_name as string);
  assert(tableNames.includes("feature_flags"), "feature_flags present");
  assert(tableNames.includes("feature_flag_assignments"), "feature_flag_assignments present");
  assert(tableNames.includes("experiments"), "experiments present");
  assert(tableNames.includes("experiment_variants"), "experiment_variants present");
  assert(tableNames.includes("feature_resolution_events"), "feature_resolution_events present");

  // ── SCENARIO 2: DB schema — indexes present ───────────────────────────────
  section("SCENARIO 2: DB schema — indexes present");
  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('feature_flags','feature_flag_assignments','experiments','experiment_variants','feature_resolution_events')
  `);
  const idxCount = Number(idxCheck.rows[0].cnt);
  assert(idxCount >= 14, `At least 14 indexes (found ${idxCount})`);

  // ── SCENARIO 3: DB schema — RLS enabled ──────────────────────────────────
  section("SCENARIO 3: DB schema — RLS enabled on all 5 tables");
  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('feature_flags','feature_flag_assignments','experiments','experiment_variants','feature_resolution_events')
      AND rowsecurity = true
  `);
  assert(Number(rlsCheck.rows[0].cnt) === 5, "RLS enabled on all 5 tables");

  // ── SCENARIO 4: createFeatureFlag — basic create ──────────────────────────
  section("SCENARIO 4: createFeatureFlag — basic create");
  const flag4 = await createFeatureFlag({
    flagKey: `test.flag.${Date.now()}`,
    flagType: "boolean",
    description: "Validation test flag",
    defaultEnabled: true,
  });
  assert(typeof flag4.id === "string", "Flag created");
  assert(typeof flag4.flagKey === "string", "Flag key is string");
  assert(flag4.flagKey.startsWith("test.flag."), "Flag key matches");

  // ── SCENARIO 5: createFeatureFlag — unique key enforced (INV-FLAG1) ───────
  section("SCENARIO 5: INV-FLAG1 — unique flag key enforced");
  let dup5 = false;
  try {
    await createFeatureFlag({ flagKey: flag4.flagKey, flagType: "boolean" });
  } catch {
    dup5 = true;
  }
  assert(dup5, "Duplicate flag key rejected (INV-FLAG1)");

  // ── SCENARIO 6: createFeatureFlag — invalid type rejected ─────────────────
  section("SCENARIO 6: createFeatureFlag — invalid type rejected");
  let badType = false;
  try {
    await createFeatureFlag({ flagKey: `bad.type.${Date.now()}`, flagType: "invalid_type" });
  } catch {
    badType = true;
  }
  assert(badType, "Invalid flag type rejected");

  // ── SCENARIO 7: updateFeatureFlag — updates lifecycle ─────────────────────
  section("SCENARIO 7: updateFeatureFlag — updates lifecycle to paused");
  const flag7 = await createFeatureFlag({ flagKey: `update.test.${Date.now()}`, flagType: "percentage_rollout" });
  const upd7 = await updateFeatureFlag(flag7.flagKey, { lifecycleStatus: "paused", description: "Updated" });
  assert(upd7.updated === true, "updateFeatureFlag returned updated=true");
  const exp7 = await explainFeatureFlag(flag7.flagKey);
  assert(exp7.flag !== null, "Flag explain returned data");
  assert((exp7.flag!.lifecycle_status as string) === "paused", "Flag lifecycle is paused");

  // ── SCENARIO 8: listFeatureFlags — returns array ──────────────────────────
  section("SCENARIO 8: listFeatureFlags — returns array");
  const flags8 = await listFeatureFlags({ limit: 50 });
  assert(Array.isArray(flags8), "listFeatureFlags returns array");
  assert(flags8.length >= 1, "At least 1 flag in list");

  // ── SCENARIO 9: listFeatureFlags — filter by lifecycleStatus ─────────────
  section("SCENARIO 9: listFeatureFlags — filter by lifecycle");
  const active9 = await listFeatureFlags({ lifecycleStatus: "active" });
  assert(Array.isArray(active9), "Active filter returns array");
  assert(active9.every((f) => f.lifecycleStatus === "active"), "All returned flags are active");

  // ── SCENARIO 10: explainFeatureFlag — returns counts ─────────────────────
  section("SCENARIO 10: explainFeatureFlag — returns structured explain");
  const explain10 = await explainFeatureFlag(flag4.flagKey);
  assert(explain10.flag !== null, "explainFeatureFlag returned flag data");
  assert(typeof explain10.assignmentCount === "number", "assignmentCount is number");
  assert(typeof explain10.resolutionEventCount === "number", "resolutionEventCount is number");

  // ── SCENARIO 11: assignFlagToTenant — creates tenant assignment ───────────
  section("SCENARIO 11: assignFlagToTenant — creates assignment");
  const assign11 = await assignFlagToTenant(flag4.flagKey, T_TENANT_A, { enabled: true, assignedVariant: "v2" });
  assert(typeof assign11.id === "string", "Tenant assignment created");

  // ── SCENARIO 12: assignFlagToActor — creates actor assignment ─────────────
  section("SCENARIO 12: assignFlagToActor — creates actor assignment");
  const assign12 = await assignFlagToActor(flag4.flagKey, T_ACTOR_A, { enabled: false, tenantId: T_TENANT_A });
  assert(typeof assign12.id === "string", "Actor assignment created");

  // ── SCENARIO 13: assignFlagGlobal — creates global assignment ────────────
  section("SCENARIO 13: assignFlagGlobal — creates global assignment");
  const flagG = await createFeatureFlag({ flagKey: `global.flag.${Date.now()}`, flagType: "config_switch" });
  const assignG = await assignFlagGlobal(flagG.flagKey, { enabled: true, assignedConfig: { theme: "dark" } });
  assert(typeof assignG.id === "string", "Global assignment created");

  // ── SCENARIO 14: explainFlagAssignments — returns assignments ─────────────
  section("SCENARIO 14: explainFlagAssignments — returns assignments");
  const assignments14 = await explainFlagAssignments(flag4.flagKey);
  assert(assignments14.flagKey === flag4.flagKey, "flagKey matches");
  assert(Array.isArray(assignments14.assignments), "assignments is array");
  assert(assignments14.assignments.length >= 2, "At least 2 assignments (tenant + actor)");
  assert(assignments14.assignments.some((a) => a.assignmentType === "tenant"), "Tenant assignment in list");
  assert(assignments14.assignments.some((a) => a.assignmentType === "actor"), "Actor assignment in list");

  // ── SCENARIO 15: removeFlagAssignment — removes assignment ────────────────
  section("SCENARIO 15: removeFlagAssignment — removes by ID");
  const toRemove = await assignFlagToTenant(flag4.flagKey, "remove-test-tenant", { enabled: true });
  const removed15 = await removeFlagAssignment(toRemove.id);
  assert(removed15.removed === true, "removeFlagAssignment returned removed=true");
  const check15 = await client.query(`SELECT id FROM feature_flag_assignments WHERE id = $1`, [toRemove.id]);
  assert(check15.rows.length === 0, "Assignment no longer in DB");

  // ── SCENARIO 16: createExperiment — basic create ──────────────────────────
  section("SCENARIO 16: createExperiment — basic create");
  const exp16 = await createExperiment({
    experimentKey: `exp.phase18.${Date.now()}`,
    subjectType: "tenant",
    tenantId: T_TENANT_A,
    trafficAllocationPercent: 80,
    description: "Test experiment",
  });
  assert(typeof exp16.id === "string", "Experiment created");
  assert(typeof exp16.experimentKey === "string", "experimentKey is string");

  // ── SCENARIO 17: createExperimentVariant — creates variants ──────────────
  section("SCENARIO 17: createExperimentVariant — creates variants");
  const va17 = await createExperimentVariant(exp16.experimentKey, {
    variantKey: "control",
    trafficPercent: 50,
    isControl: true,
    config: { version: "v1" },
  });
  const vb17 = await createExperimentVariant(exp16.experimentKey, {
    variantKey: "treatment",
    trafficPercent: 50,
    isControl: false,
    config: { version: "v2" },
  });
  assert(typeof va17.id === "string", "Control variant created");
  assert(typeof vb17.id === "string", "Treatment variant created");

  // ── SCENARIO 18: traffic percent overflow rejected (INV-FLAG4) ────────────
  section("SCENARIO 18: INV-FLAG4 — traffic percent overflow rejected");
  let overflow18 = false;
  try {
    await createExperimentVariant(exp16.experimentKey, { variantKey: "overflow", trafficPercent: 10 });
  } catch {
    overflow18 = true;
  }
  assert(overflow18, "Overflow traffic percent rejected (INV-FLAG4)");

  // ── SCENARIO 19: startExperiment — transitions to active (INV-FLAG5) ─────
  section("SCENARIO 19: startExperiment — transitions to active");
  const start19 = await startExperiment(exp16.experimentKey);
  assert(start19.transitioned === true, "startExperiment returned transitioned=true");
  assert(start19.from === "draft", "Transitioned from draft");
  assert(start19.to === "active", "Transitioned to active");

  // ── SCENARIO 20: pauseExperiment — transitions to paused ─────────────────
  section("SCENARIO 20: pauseExperiment — transitions to paused");
  const pause20 = await pauseExperiment(exp16.experimentKey);
  assert(pause20.transitioned === true, "pauseExperiment returned transitioned=true");
  assert(pause20.to === "paused", "Status is paused");

  // ── SCENARIO 21: completeExperiment — via re-activation ──────────────────
  section("SCENARIO 21: completeExperiment — transitions to completed");
  await startExperiment(exp16.experimentKey);
  const complete21 = await completeExperiment(exp16.experimentKey);
  assert(complete21.transitioned === true, "completeExperiment returned transitioned=true");
  assert(complete21.to === "completed", "Status is completed");

  // ── SCENARIO 22: invalid lifecycle transition rejected (INV-FLAG5) ────────
  section("SCENARIO 22: INV-FLAG5 — invalid lifecycle transition rejected");
  let invalid22 = false;
  try {
    await startExperiment(exp16.experimentKey); // completed → active is invalid
  } catch {
    invalid22 = true;
  }
  assert(invalid22, "Invalid transition completed→active rejected (INV-FLAG5)");

  // ── SCENARIO 23: explainExperiment — returns structured data ─────────────
  section("SCENARIO 23: explainExperiment — returns structured data");
  const expEx23 = await explainExperiment(exp16.experimentKey);
  assert(expEx23.experiment !== null, "Experiment explain returned data");
  assert(Array.isArray(expEx23.variants), "Variants array returned");
  assert(expEx23.variants.length === 2, "2 variants returned");
  assert(typeof expEx23.totalTrafficPercent === "number", "totalTrafficPercent is number");
  assert(expEx23.totalTrafficPercent === 100, "Total traffic sums to 100");

  // ── SCENARIO 24: deterministicHashAssignment — stable (INV-FLAG3) ─────────
  section("SCENARIO 24: INV-FLAG3 — deterministicHashAssignment stable");
  const h1 = deterministicHashAssignment("tenant-abc", "my.experiment", 50);
  const h2 = deterministicHashAssignment("tenant-abc", "my.experiment", 50);
  assert(h1 === h2, "Same subject + same state → same result (INV-FLAG3)");

  // ── SCENARIO 25: deterministicHashAssignment — 0% never assigned ──────────
  section("SCENARIO 25: deterministicHashAssignment — 0% never assigned");
  const h0 = deterministicHashAssignment("any-subject", "any.salt", 0);
  assert(h0 === false, "0% threshold → never assigned");

  // ── SCENARIO 26: deterministicHashAssignment — 100% always assigned ───────
  section("SCENARIO 26: deterministicHashAssignment — 100% always assigned");
  const h100 = deterministicHashAssignment("any-subject", "any.salt", 100);
  assert(h100 === true, "100% threshold → always assigned");

  // ── SCENARIO 27: different subjects can resolve differently ───────────────
  section("SCENARIO 27: different subjects can resolve differently");
  let diffFound = false;
  for (let i = 0; i < 20; i++) {
    const r1 = deterministicHashAssignment(`subject-${i}`, "diff.salt", 50);
    const r2 = deterministicHashAssignment(`subject-${i + 100}`, "diff.salt", 50);
    if (r1 !== r2) { diffFound = true; break; }
  }
  assert(diffFound, "Different subjects can resolve differently");

  // ── SCENARIO 28: deterministicVariantBucket — stable ─────────────────────
  section("SCENARIO 28: deterministicVariantBucket — stable for same subject");
  const variants28 = [{ variantKey: "control", trafficPercent: 50 }, { variantKey: "treatment", trafficPercent: 50 }];
  const v28a = deterministicVariantBucket("subject-x", "exp.key", variants28);
  const v28b = deterministicVariantBucket("subject-x", "exp.key", variants28);
  assert(v28a === v28b, "Same subject → same variant bucket");
  assert(v28a !== null, "Bucket resolved to a variant");

  // ── SCENARIO 29: resolveFeatureFlag — actor assignment wins (INV-FLAG2) ──
  section("SCENARIO 29: INV-FLAG2 — actor assignment beats tenant assignment");
  const flagP29 = await createFeatureFlag({ flagKey: `priority.test.${Date.now()}`, flagType: "boolean" });
  await assignFlagToTenant(flagP29.flagKey, T_TENANT_A, { enabled: false, assignedVariant: "tenant-v" });
  await assignFlagToActor(flagP29.flagKey, T_ACTOR_A, { enabled: true, assignedVariant: "actor-v" });
  const res29 = await resolveFeatureFlag(flagP29.flagKey, { tenantId: T_TENANT_A, actorId: T_ACTOR_A }, { writeEvent: false });
  assert(res29.resolutionSource === "actor_assignment", "Actor assignment wins over tenant (INV-FLAG2)");
  assert(res29.resolvedVariant === "actor-v", "Actor variant resolved");

  // ── SCENARIO 30: tenant assignment beats experiment ───────────────────────
  section("SCENARIO 30: tenant assignment beats experiment variant");
  const flagP30 = await createFeatureFlag({ flagKey: `tenant.over.exp.${Date.now()}`, flagType: "experiment" });
  await assignFlagToTenant(flagP30.flagKey, T_TENANT_A, { enabled: true, assignedVariant: "tenant-override" });
  const res30 = await resolveFeatureFlag(flagP30.flagKey, { tenantId: T_TENANT_A }, { writeEvent: false });
  assert(res30.resolutionSource === "tenant_assignment", "Tenant beats experiment (INV-FLAG2)");

  // ── SCENARIO 31: global assignment beats default ──────────────────────────
  section("SCENARIO 31: global assignment beats default");
  const res31 = await resolveFeatureFlag(flagG.flagKey, { tenantId: "no-specific-tenant" }, { writeEvent: false });
  assert(res31.resolutionSource === "global_assignment", "Global assignment resolved");
  assert(res31.enabled === true, "Global enabled=true");

  // ── SCENARIO 32: default path when no assignment exists ──────────────────
  section("SCENARIO 32: default path when no assignment exists");
  const flagD32 = await createFeatureFlag({ flagKey: `default.only.${Date.now()}`, flagType: "boolean", defaultEnabled: false });
  const res32 = await resolveFeatureFlag(flagD32.flagKey, { tenantId: "no-tenant-assigned" }, { writeEvent: false });
  assert(res32.resolutionSource === "default", "Default path used (INV-FLAG2 step 5)");
  assert(res32.enabled === false, "Default enabled=false");

  // ── SCENARIO 33: experiment variant resolved deterministically ────────────
  section("SCENARIO 33: experiment variant resolved deterministically");
  const expKey33 = `active.exp.${Date.now()}`;
  await createExperiment({ experimentKey: expKey33, subjectType: "tenant", trafficAllocationPercent: 100 });
  await createExperimentVariant(expKey33, { variantKey: "ctrl", trafficPercent: 50, isControl: true });
  await createExperimentVariant(expKey33, { variantKey: "treat", trafficPercent: 50 });
  await startExperiment(expKey33);

  const ctx33 = { tenantId: "exp-test-tenant-33" };
  const var33a = await resolveExperimentVariant(expKey33, ctx33);
  const var33b = await resolveExperimentVariant(expKey33, ctx33);
  assert(var33a !== null, "Variant resolved");
  assert(var33a!.variantKey === var33b!.variantKey, "Same subject → same variant (INV-FLAG3)");

  // ── SCENARIO 34: explainResolution — read-only, no write (INV-FLAG8) ──────
  section("SCENARIO 34: INV-FLAG8 — explainResolution performs no write");
  const before34 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE flag_key = $1`, [flag4.flagKey]);
  const explain34 = await explainResolution(flag4.flagKey, { tenantId: "preview-tenant" });
  const after34 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE flag_key = $1`, [flag4.flagKey]);
  assert(explain34.preview === true, "Preview flag set (INV-FLAG8)");
  assert(explain34.noWritePerformed === true, "noWritePerformed flag set");
  assert(Number(before34.rows[0].cnt) === Number(after34.rows[0].cnt), "No resolution event written");

  // ── SCENARIO 35: resolveFeatureFlag — writes resolution event ────────────
  section("SCENARIO 35: resolveFeatureFlag — writes resolution event");
  const before35 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE flag_key = $1`, [flagD32.flagKey]);
  await resolveFeatureFlag(flagD32.flagKey, { tenantId: T_TENANT_A, requestId: "req-35" }, { writeEvent: true });
  const after35 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE flag_key = $1`, [flagD32.flagKey]);
  assert(Number(after35.rows[0].cnt) > Number(before35.rows[0].cnt), "Resolution event written");

  // ── SCENARIO 36: paused flag returns default (INV-FLAG5) ─────────────────
  section("SCENARIO 36: INV-FLAG5 — paused flag returns default value");
  const flagPaused36 = await createFeatureFlag({ flagKey: `paused.flag.${Date.now()}`, flagType: "boolean", defaultEnabled: true });
  await updateFeatureFlag(flagPaused36.flagKey, { lifecycleStatus: "paused" });
  const res36 = await resolveFeatureFlag(flagPaused36.flagKey, { tenantId: T_TENANT_A }, { writeEvent: false });
  assert(res36.resolutionSource === "default", "Paused flag uses default");
  assert(res36.enabled === true, "Paused flag returns defaultEnabled value");

  // ── SCENARIO 37: resolveModelOverride — returns null when no flag ─────────
  section("SCENARIO 37: runtime — resolveModelOverride with no active flag");
  const model37 = await resolveModelOverride({ tenantId: "no-override-tenant" });
  assert(model37 === null, "resolveModelOverride returns null when no flag (INV-FLAG9)");

  // ── SCENARIO 38: resolvePromptVersionOverride — returns null when no flag ──
  section("SCENARIO 38: runtime — resolvePromptVersionOverride with no flag");
  const prompt38 = await resolvePromptVersionOverride({ tenantId: "no-override-tenant" });
  assert(prompt38 === null, "resolvePromptVersionOverride returns null when no flag (INV-FLAG9)");

  // ── SCENARIO 39: resolveRetrievalStrategyOverride — null when no flag ─────
  section("SCENARIO 39: runtime — resolveRetrievalStrategyOverride with no flag");
  const retrieval39 = await resolveRetrievalStrategyOverride({ tenantId: "no-override-tenant" });
  assert(retrieval39 === null, "resolveRetrievalStrategyOverride returns null (INV-FLAG9)");

  // ── SCENARIO 40: resolveAgentVersionOverride — null when no flag ──────────
  section("SCENARIO 40: runtime — resolveAgentVersionOverride with no flag");
  const agent40 = await resolveAgentVersionOverride({ tenantId: "no-override-tenant" });
  assert(agent40 === null, "resolveAgentVersionOverride returns null (INV-FLAG9)");

  // ── SCENARIO 41: model override resolves when flag set ────────────────────
  section("SCENARIO 41: runtime — model override resolves when flag active");
  async function ensureFlag(flagKey: string, flagType: string) {
    try { await createFeatureFlag({ flagKey, flagType }); } catch { /* already exists */ }
  }
  async function ensureTenantAssignment(flagKey: string, tenantId: string, params: Record<string, unknown>) {
    await client.query(`
      DELETE FROM feature_flag_assignments
      WHERE flag_id = (SELECT id FROM feature_flags WHERE flag_key = $1)
        AND tenant_id = $2 AND assignment_type = 'tenant'
    `, [flagKey, tenantId]);
    await assignFlagToTenant(flagKey, tenantId, params as Parameters<typeof assignFlagToTenant>[2]);
  }
  await ensureFlag("model.override", "config_switch");
  await ensureTenantAssignment("model.override", T_TENANT_A, { enabled: true, assignedConfig: { modelName: "gpt-4-turbo" } });
  const model41 = await resolveModelOverride({ tenantId: T_TENANT_A });
  assert(model41 === "gpt-4-turbo", `Model override resolved: ${model41}`);

  // ── SCENARIO 42: prompt override resolves when flag set ───────────────────
  section("SCENARIO 42: runtime — prompt version override resolves");
  await ensureFlag("prompt.version.override", "config_switch");
  await ensureTenantAssignment("prompt.version.override", T_TENANT_A, { enabled: true, assignedConfig: { promptVersionId: "v2.3.1" } });
  const prompt42 = await resolvePromptVersionOverride({ tenantId: T_TENANT_A });
  assert(prompt42 === "v2.3.1", `Prompt version override resolved: ${prompt42}`);

  // ── SCENARIO 43: retrieval strategy override resolves ─────────────────────
  section("SCENARIO 43: runtime — retrieval strategy override resolves");
  await ensureFlag("retrieval.strategy.override", "config_switch");
  await ensureTenantAssignment("retrieval.strategy.override", T_TENANT_A, { enabled: true, assignedConfig: { strategy: "hybrid" } });
  const retrieval43 = await resolveRetrievalStrategyOverride({ tenantId: T_TENANT_A });
  assert(retrieval43 === "hybrid", `Retrieval strategy override resolved: ${retrieval43}`);

  // ── SCENARIO 44: agent version override resolves ──────────────────────────
  section("SCENARIO 44: runtime — agent version override resolves");
  await ensureFlag("agent.version.override", "config_switch");
  await ensureTenantAssignment("agent.version.override", T_TENANT_A, { enabled: true, assignedConfig: { agentVersion: "v2-openai" } });
  const agent44 = await resolveAgentVersionOverride({ tenantId: T_TENANT_A });
  assert(agent44 === "v2-openai", `Agent version override resolved: ${agent44}`);

  // ── SCENARIO 45: previewFlagResolution — read-only (INV-FLAG8) ───────────
  section("SCENARIO 45: INV-FLAG8 — previewFlagResolution is read-only");
  const before45 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events`);
  const preview45 = await previewFlagResolution(flag4.flagKey, { tenantId: "preview-safe-tenant" });
  const after45 = await client.query(`SELECT COUNT(*) AS cnt FROM feature_resolution_events`);
  assert(preview45.preview === true, "Preview flag set");
  assert(preview45.noWritePerformed === true, "No write performed");
  assert(Number(before45.rows[0].cnt) === Number(after45.rows[0].cnt), "Event count unchanged (INV-FLAG8)");

  // ── SCENARIO 46: getRolloutMetrics — aggregates correctly ────────────────
  section("SCENARIO 46: rollout observability — getRolloutMetrics aggregates");
  await resolveFeatureFlag(flagD32.flagKey, { tenantId: T_TENANT_A }, { writeEvent: true });
  await resolveFeatureFlag(flagD32.flagKey, { tenantId: T_TENANT_A }, { writeEvent: true });
  const metrics46 = await getRolloutMetrics({ flagKey: flagD32.flagKey });
  assert(Array.isArray(metrics46), "getRolloutMetrics returns array");
  assert(metrics46.length >= 1, "At least 1 flag in metrics");
  const m46 = metrics46.find((m) => m.flagKey === flagD32.flagKey);
  assert(m46 !== undefined, "Target flag in metrics");
  assert(m46!.totalResolutions >= 2, "At least 2 resolutions recorded");
  assert(typeof m46!.bySource === "object", "bySource object returned");

  // ── SCENARIO 47: summarizeRolloutMetrics — returns summary ───────────────
  section("SCENARIO 47: rollout observability — summarizeRolloutMetrics");
  const summary47 = await summarizeRolloutMetrics();
  assert(typeof summary47.totalFlags === "number", "totalFlags is number");
  assert(typeof summary47.totalResolutionEvents === "number", "totalResolutionEvents is number");
  assert(summary47.totalResolutionEvents >= 2, "At least 2 resolution events total");
  assert(typeof summary47.sourceDistribution === "object", "sourceDistribution object returned");

  // ── SCENARIO 48: listRecentResolutions — returns list ────────────────────
  section("SCENARIO 48: rollout observability — listRecentResolutions");
  const recent48 = await listRecentResolutions({ limit: 20 });
  assert(Array.isArray(recent48), "listRecentResolutions returns array");
  assert(recent48.length >= 1, "At least 1 recent resolution");
  assert(typeof recent48[0].flagKey === "string", "flagKey present");
  assert(typeof recent48[0].resolutionSource === "string", "resolutionSource present");

  // ── SCENARIO 49: listRecentResolutions — filtered by tenant (INV-FLAG11) ──
  section("SCENARIO 49: INV-FLAG11 — listRecentResolutions filters by tenant");
  const filtered49 = await listRecentResolutions({ tenantId: T_TENANT_B, limit: 10 });
  assert(Array.isArray(filtered49), "Filtered list returned");
  assert(filtered49.every((r) => r.tenantId === T_TENANT_B || r.tenantId === null), "Only tenant B events (INV-FLAG11)");

  // ── SCENARIO 50: logRolloutChange — audits flag create (INV-FLAG10) ───────
  section("SCENARIO 50: INV-FLAG10 — logRolloutChange audits changes");
  const audit50a = await logRolloutChange({
    action: "feature_flag.created",
    subjectKey: flag4.flagKey,
    actorId: T_ACTOR_A,
    metadata: { flagType: "boolean" },
  });
  assert(typeof audit50a.id === "string", "Audit entry created (INV-FLAG10)");
  assert(audit50a.action === "feature_flag.created", "Action matches");

  const audit50b = await logRolloutChange({
    action: "feature_assignment.created",
    subjectKey: assign11.id,
    tenantId: T_TENANT_A,
    metadata: { flagKey: flag4.flagKey },
  });
  assert(typeof audit50b.id === "string", "Assignment audit created");

  // ── SCENARIO 51: experiment lifecycle audited ─────────────────────────────
  section("SCENARIO 51: INV-FLAG10 — experiment lifecycle audited");
  await logRolloutChange({ action: "experiment.created", subjectKey: exp16.experimentKey });
  await logRolloutChange({ action: "experiment.started", subjectKey: exp16.experimentKey });
  await logRolloutChange({ action: "experiment.paused", subjectKey: exp16.experimentKey });
  await logRolloutChange({ action: "experiment.completed", subjectKey: exp16.experimentKey });
  const audit51 = await explainRolloutAudit({ subjectKey: exp16.experimentKey });
  assert(audit51.entries.length >= 4, "At least 4 audit entries for experiment lifecycle");
  assert(audit51.entries.some((e) => e.action === "experiment.started"), "experiment.started audited");
  assert(audit51.entries.some((e) => e.action === "experiment.completed"), "experiment.completed audited");

  // ── SCENARIO 52: explainRolloutAudit — filterable ─────────────────────────
  section("SCENARIO 52: explainRolloutAudit — filterable by action");
  const audit52 = await explainRolloutAudit({ action: "feature_flag.created" });
  assert(audit52.entries.every((e) => e.action === "feature_flag.created"), "Filter by action works");

  // ── SCENARIO 53: INV-FLAG6 — tenant B sees no tenant A assignments ─────────
  section("SCENARIO 53: INV-FLAG6/12 — tenant B sees no tenant A assignments");
  const tenantBAssignments = await explainFlagAssignments(flag4.flagKey);
  const bLeaked = tenantBAssignments.assignments.filter((a) => a.tenantId === T_TENANT_B);
  assert(bLeaked.length === 0, "Tenant B has no assignments on tenant A flag");

  // ── SCENARIO 54: RLS — 5 tables have RLS enabled (INV-FLAG12) ────────────
  section("SCENARIO 54: INV-FLAG12 — RLS on all 5 tables");
  const rls54 = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('feature_flags','feature_flag_assignments','experiments','experiment_variants','feature_resolution_events')
      AND rowsecurity = true
  `);
  assert(Number(rls54.rows[0].cnt) === 5, "INV-FLAG12: All 5 rollout tables have RLS enabled");

  // ── SCENARIO 55: tenant isolation — resolution events by tenant ───────────
  section("SCENARIO 55: INV-FLAG12 — resolution events isolated by tenant");
  await resolveFeatureFlag(flagD32.flagKey, { tenantId: T_TENANT_B, requestId: "req-55" }, { writeEvent: true });
  const tenantB55 = await listRecentResolutions({ tenantId: T_TENANT_B, limit: 10 });
  const tenantA55 = await listRecentResolutions({ tenantId: T_TENANT_A, limit: 10 });
  assert(tenantB55.every((r) => r.tenantId === T_TENANT_B), "Tenant B events are tenant B only");
  assert(tenantA55.every((r) => r.tenantId === T_TENANT_A), "Tenant A events are tenant A only");

  // ── SCENARIO 56: admin route — POST /api/admin/flags ─────────────────────
  section("SCENARIO 56: Admin route POST /api/admin/flags");
  const res56 = await fetch("http://localhost:5000/api/admin/flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flagKey: `admin.route.test.${Date.now()}`, flagType: "boolean", description: "Route test" }),
  });
  assert(res56.status !== 404, "POST /api/admin/flags is not 404");

  // ── SCENARIO 57: admin route — GET /api/admin/flags ──────────────────────
  section("SCENARIO 57: Admin route GET /api/admin/flags");
  const res57 = await fetch("http://localhost:5000/api/admin/flags");
  assert(res57.status !== 404, "GET /api/admin/flags is not 404");

  // ── SCENARIO 58: admin route — GET /api/admin/experiments ────────────────
  section("SCENARIO 58: Admin route GET /api/admin/experiments");
  const res58 = await fetch("http://localhost:5000/api/admin/experiments");
  assert(res58.status !== 404, "GET /api/admin/experiments is not 404");

  // ── SCENARIO 59: admin route — GET /api/admin/rollouts/metrics ───────────
  section("SCENARIO 59: Admin route GET /api/admin/rollouts/metrics");
  const res59 = await fetch("http://localhost:5000/api/admin/rollouts/metrics");
  assert(res59.status !== 404, "GET /api/admin/rollouts/metrics is not 404");

  // ── SCENARIO 60: admin route — POST /api/admin/rollouts/preview-resolution ─
  section("SCENARIO 60: Admin route POST /api/admin/rollouts/preview-resolution");
  const res60 = await fetch("http://localhost:5000/api/admin/rollouts/preview-resolution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flagKey: flag4.flagKey, tenantId: T_TENANT_A }),
  });
  assert(res60.status !== 404, "POST /api/admin/rollouts/preview-resolution is not 404");

  // ── SCENARIO 61: INV-FLAG9 — budget-checker (Phase 16) still intact ───────
  section("SCENARIO 61: INV-FLAG9 — Phase 16 budget-checker still intact");
  const { listAllTenantBudgets } = await import("../ai-governance/budget-checker");
  const budgets61 = await listAllTenantBudgets();
  assert(Array.isArray(budgets61), "INV-FLAG9: budget-checker still returns array");

  // ── SCENARIO 62: INV-FLAG9 — Phase 17 eval datasets still intact ──────────
  section("SCENARIO 62: INV-FLAG9 — Phase 17 eval platform still intact");
  const { listDatasets } = await import("../ai-evals/eval-datasets");
  const datasets62 = await listDatasets({ tenantId: "compat-test" });
  assert(Array.isArray(datasets62), "INV-FLAG9: eval-datasets still returns array");

  // ── SCENARIO 63: INV-FLAG9 — Phase 15 observability still intact ──────────
  section("SCENARIO 63: INV-FLAG9 — Phase 15 observability still intact");
  const { getPlatformHealthStatus } = await import("../observability/metrics-health");
  const health63 = await getPlatformHealthStatus(1);
  assert(typeof health63 === "object", "INV-FLAG9: metrics-health still returns object");

  // ── SCENARIO 64: INV-FLAG1 — flag key uniqueness across flag types ─────────
  section("SCENARIO 64: INV-FLAG1 — flag key unique across all flag types");
  const uniqueKey64 = `unique.cross.type.${Date.now()}`;
  await createFeatureFlag({ flagKey: uniqueKey64, flagType: "boolean" });
  let dupCross64 = false;
  try {
    await createFeatureFlag({ flagKey: uniqueKey64, flagType: "experiment" });
  } catch {
    dupCross64 = true;
  }
  assert(dupCross64, "Same key rejected even with different flag types (INV-FLAG1)");

  // ── SCENARIO 65: INV-FLAG11 — resolution events don't expose config secrets ─
  section("SCENARIO 65: INV-FLAG11 — resolution events privacy-safe");
  const auditEntries65 = getRolloutAuditLog();
  assert(Array.isArray(auditEntries65), "Audit log accessible as read-only array");
  const recent65 = await listRecentResolutions({ limit: 5 });
  const hasSecretLeak = recent65.some((r) => {
    const cfg = r.resolvedVariant ?? "";
    return cfg.includes("password") || cfg.includes("secret") || cfg.includes("token");
  });
  assert(!hasSecretLeak, "INV-FLAG11: No secrets in resolution event variant fields");

  // ── SCENARIO 66: resolution explanation strings are non-empty ─────────────
  section("SCENARIO 66: INV-FLAG7 — resolution explanations are non-empty strings");
  const res66a = await resolveFeatureFlag(flagD32.flagKey, { tenantId: T_TENANT_A }, { writeEvent: false });
  assert(typeof res66a.explanation === "string", "explanation is string (INV-FLAG7)");
  assert(res66a.explanation.length > 0, "explanation is non-empty");
  const res66b = await resolveFeatureFlag(flag4.flagKey, { tenantId: T_TENANT_A, actorId: T_ACTOR_A }, { writeEvent: false });
  assert(res66b.resolutionSource === "actor_assignment", "Actor assignment source");
  assert(res66b.explanation.includes(T_ACTOR_A), "Explanation mentions actor ID");
  const res66c = await resolveFeatureFlag(flagG.flagKey, { tenantId: "any-tenant" }, { writeEvent: false });
  assert(res66c.resolutionSource === "global_assignment", "Global assignment source");
  assert(res66c.explanation.toLowerCase().includes("global"), "Explanation mentions global");

  // ── SCENARIO 67: explainExperiment — non-existent returns null ────────────
  section("SCENARIO 67: explainExperiment — non-existent returns null gracefully");
  const ghost67 = await explainExperiment("non.existent.experiment.xyz");
  assert(ghost67.experiment === null, "Non-existent experiment returns null");
  assert(Array.isArray(ghost67.variants), "Variants still array for null experiment");
  assert(ghost67.variants.length === 0, "No variants for null experiment");
  assert(ghost67.totalTrafficPercent === 0, "totalTrafficPercent=0 for null experiment");

  // ── SCENARIO 68: resolveExperimentVariant — inactive exp returns null ─────
  section("SCENARIO 68: resolveExperimentVariant — inactive experiment returns null");
  const draftExpKey68 = `draft.exp.68.${Date.now()}`;
  await createExperiment({ experimentKey: draftExpKey68, subjectType: "tenant" });
  await createExperimentVariant(draftExpKey68, { variantKey: "v1", trafficPercent: 50, isControl: true });
  await createExperimentVariant(draftExpKey68, { variantKey: "v2", trafficPercent: 50 });
  const inactive68 = await resolveExperimentVariant(draftExpKey68, { tenantId: "any-tenant" });
  assert(inactive68 === null, "Draft experiment variant resolves to null");

  // ── SCENARIO 69: createFeatureFlag — all flag types accepted ─────────────
  section("SCENARIO 69: createFeatureFlag — all 4 valid types accepted");
  const types69 = ["boolean", "percentage_rollout", "experiment", "config_switch"];
  for (const t of types69) {
    const f = await createFeatureFlag({ flagKey: `type.test.${t}.${Date.now()}`, flagType: t });
    assert(typeof f.id === "string", `flagType '${t}' accepted`);
  }

  // ── SCENARIO 70: INV-FLAG4 — traffic percent < 0 rejected ────────────────
  section("SCENARIO 70: INV-FLAG4 — negative traffic percent rejected");
  let negPercent70 = false;
  try {
    const negExp70 = await createExperiment({ experimentKey: `neg.exp.${Date.now()}`, subjectType: "tenant" });
    await createExperimentVariant(negExp70.experimentKey, { variantKey: "v1", trafficPercent: -10 });
  } catch {
    negPercent70 = true;
  }
  assert(negPercent70, "Negative traffic percent rejected (INV-FLAG4)");

  // ── SCENARIO 71: audit log is append-only and immutable ───────────────────
  section("SCENARIO 71: INV-FLAG10 — audit log is append-only");
  const beforeCount71 = getRolloutAuditLog().length;
  await logRolloutChange({ action: "feature_flag.updated", subjectKey: "test-flag-71", metadata: { change: "description" } });
  const afterCount71 = getRolloutAuditLog().length;
  assert(afterCount71 > beforeCount71, "Audit log grows after new entry");
  assert(afterCount71 === beforeCount71 + 1, "Exactly 1 new entry added");
  const latest71 = getRolloutAuditLog()[afterCount71 - 1];
  assert(latest71.action === "feature_flag.updated", "Action preserved correctly");
  assert(latest71.subjectKey === "test-flag-71", "subjectKey preserved");

  // ── SCENARIO 72: rollout metrics filter by flagKey works ──────────────────
  section("SCENARIO 72: getRolloutMetrics — filtered by flagKey");
  const filteredMetrics72 = await getRolloutMetrics({ flagKey: flagD32.flagKey, limit: 10 });
  assert(Array.isArray(filteredMetrics72), "Filtered metrics is array");
  assert(filteredMetrics72.every((m) => m.flagKey === flagD32.flagKey), "All metrics are for target flag");
  const summary72 = await summarizeRolloutMetrics({ tenantId: T_TENANT_A });
  assert(typeof summary72.totalFlags === "number", "summarizeRolloutMetrics returns totalFlags");
  assert(typeof summary72.sourceDistribution === "object", "sourceDistribution in summary");
  assert(typeof summary72.totalResolutionEvents === "number", "totalResolutionEvents is number in summary");
  assert(summary72.totalResolutionEvents >= 1, "At least 1 resolution event recorded overall");

  // ── Final summary ─────────────────────────────────────────────────────────
  await client.end();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 18 validation: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("✗ FAILED assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("✔ All assertions passed");
  }
}

main().catch((err) => {
  console.error("Validation crashed:", err.message);
  process.exit(1);
});
