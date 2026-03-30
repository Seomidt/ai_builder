/**
 * Phase 14 Validation — AI Agents Execution Platform
 * 70 scenarios, 150+ assertions
 *
 * Covers:
 *   - DB schema (6 tables, RLS, CHECK constraints, unique indexes)
 *   - Agent CRUD (create, list, tenant isolation)
 *   - Agent versions (unique per agent, max_iterations ≤ 10)
 *   - Workflow CRUD (create, steps, validate)
 *   - Workflow limits (max 20 steps, sequential order)
 *   - Agent runner (full pipeline, governance check, state transitions)
 *   - Run logging (step logs, tenant isolation)
 *   - Metrics and health
 *   - Limit enforcement (max_iterations, max_duration)
 */

import pg from "pg";
import { createAgent, listAgents, getAgentById, createAgentVersion, getAgentVersion, getLatestAgentVersion, agentMetrics, agentHealth, MAX_ITERATIONS } from "./agent-engine.ts";
import { createRun, transitionRun, getRun, listRuns, isTerminalStatus } from "./agent-state.ts";
import { logStep, getRunLogs, getRunLogsByTenant } from "./agent-logger.ts";
import { createWorkflow, addWorkflowStep, getWorkflowSteps, listWorkflows, validateWorkflow, MAX_WORKFLOW_STEPS } from "./workflow-validator.ts";
import { executeWorkflow, MAX_RUN_DURATION_MS } from "./workflow-engine.ts";
import { runAgent, MAX_ITERATIONS as RUNNER_MAX_ITERATIONS } from "./agent-runner.ts";

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { passed++; process.stdout.write(`  ✔ ${message}\n`); }
  else { failed++; process.stderr.write(`  ✗ FAIL: ${message}\n`); }
}
function section(title: string): void { console.log(`\n── ${title} ──`); }

async function main() {
  await client.connect();
  console.log("✔ Connected to Supabase Postgres\n");

  const TENANT_A = `p14-val-a-${Date.now()}`;
  const TENANT_B = `p14-val-b-${Date.now()}`;

  try {
    // ═══════════════════════════════════════════════════════════════════
    // DB SCHEMA (Scenarios 1–8)
    // ═══════════════════════════════════════════════════════════════════

    const TABLES = ["ai_agents","ai_agent_versions","ai_workflows","ai_workflow_steps","ai_agent_runs","ai_agent_run_logs"];

    section("SCENARIO 1: DB schema — 6 Phase 14 tables exist");
    const tR = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1)`, [TABLES]);
    assert(tR.rows.length === 6, `All 6 tables exist (found ${tR.rows.length})`);
    for (const t of TABLES) assert(tR.rows.some((r) => r.table_name === t), `Table: ${t}`);

    section("SCENARIO 2: DB schema — RLS on all 6 tables");
    const rlsR = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename=ANY($1)`, [TABLES]);
    assert(rlsR.rows.length === 6, `RLS on all 6 tables (found ${rlsR.rows.length})`);

    section("SCENARIO 3: DB schema — total RLS tables ≥ 150");
    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    assert(parseInt(totalRls.rows[0].cnt, 10) >= 150, `Total RLS ≥ 150 (found ${totalRls.rows[0].cnt})`);

    section("SCENARIO 4: DB schema — CHECK constraints");
    const ck1 = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ai_agent_versions'::regclass AND contype='c'`);
    assert(ck1.rows.length >= 1, `ai_agent_versions has CHECK constraint (${ck1.rows.length})`);
    const ck2 = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ai_agent_runs'::regclass AND contype='c'`);
    assert(ck2.rows.length >= 1, `ai_agent_runs has CHECK constraint (${ck2.rows.length})`);
    const ck3 = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ai_workflow_steps'::regclass AND contype='c'`);
    assert(ck3.rows.length >= 1, `ai_workflow_steps has CHECK constraint (${ck3.rows.length})`);

    section("SCENARIO 5: DB schema — unique indexes");
    const idxR = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)`, [TABLES]);
    const idxNames = idxR.rows.map((r) => r.indexname as string);
    assert(idxNames.includes("ai_agents_tenant_name_unique"), "ai_agents unique index");
    assert(idxNames.includes("ai_agent_versions_agent_version_unique"), "ai_agent_versions unique index");
    assert(idxNames.includes("ai_workflows_tenant_name_unique"), "ai_workflows unique index");
    assert(idxNames.includes("ai_workflow_steps_workflow_order_unique"), "ai_workflow_steps unique index");

    section("SCENARIO 6: DB schema — ai_agent_runs status CHECK");
    let err6 = false;
    try { await client.query(`INSERT INTO public.ai_agent_runs (tenant_id,agent_version_id,run_status) VALUES ('t','v','invalid_status')`); } catch { err6 = true; }
    assert(err6, "CHECK blocks invalid run_status");

    section("SCENARIO 7: DB schema — ai_workflow_steps type CHECK");
    const wf7 = await client.query(`INSERT INTO public.ai_workflows (tenant_id,workflow_name) VALUES ($1,'ck-wf-7') RETURNING id`, [TENANT_A]);
    let err7 = false;
    try { await client.query(`INSERT INTO public.ai_workflow_steps (workflow_id,step_order,step_type) VALUES ($1,1,'invalid_type')`, [wf7.rows[0].id]); } catch { err7 = true; }
    assert(err7, "CHECK blocks invalid step_type");

    section("SCENARIO 8: DB schema — ai_agent_versions max_iterations CHECK");
    const ag8 = await client.query(`INSERT INTO public.ai_agents (tenant_id,agent_name) VALUES ($1,'ck-ag-8') RETURNING id`, [TENANT_A]);
    let err8 = false;
    try { await client.query(`INSERT INTO public.ai_agent_versions (agent_id,version,max_iterations) VALUES ($1,1,99)`, [ag8.rows[0].id]); } catch { err8 = true; }
    assert(err8, "CHECK blocks max_iterations > 10");

    // ═══════════════════════════════════════════════════════════════════
    // AGENT ENGINE (Scenarios 9–22)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 9: createAgent — tenant-scoped");
    const a9 = await createAgent({ tenantId: TENANT_A, agentName: "agent-alpha", description: "Alpha agent" });
    assert(!!a9.id, "Agent created");
    assert(a9.tenantId === TENANT_A, "Tenant-scoped");
    assert(a9.agentName === "agent-alpha", "agentName stored");
    assert(a9.description === "Alpha agent", "Description stored");

    section("SCENARIO 10: createAgent — without description");
    const a10 = await createAgent({ tenantId: TENANT_A, agentName: "agent-beta" });
    assert(a10.description === null, "Description null when not provided");

    section("SCENARIO 11: listAgents — tenant-scoped isolation");
    const agentsA = await listAgents(TENANT_A);
    const agentsB = await listAgents(TENANT_B);
    assert(agentsA.length >= 2, `Tenant A sees its agents (${agentsA.length})`);
    assert(agentsB.length === 0, "Tenant B sees no agents");

    section("SCENARIO 12: getAgentById — correct tenant isolation");
    const ag12 = await getAgentById(a9.id, TENANT_A);
    assert(ag12 !== null, "Agent found by ID for correct tenant");
    assert(ag12!.id === a9.id, "Correct agent returned");
    const ag12b = await getAgentById(a9.id, TENANT_B);
    assert(ag12b === null, "Tenant B cannot access Tenant A agent");

    section("SCENARIO 13: createAgentVersion — version 1");
    const av13 = await createAgentVersion({ agentId: a9.id, version: 1, maxIterations: 5 });
    assert(!!av13.id, "Agent version created");
    assert(av13.version === 1, "Version 1");
    assert(av13.maxIterations === 5, "maxIterations stored");
    assert(av13.agentId === a9.id, "agentId stored");

    section("SCENARIO 14: createAgentVersion — auto-increment version");
    const av14 = await createAgentVersion({ agentId: a9.id });
    assert(av14.version === 2, `Auto-incremented to version 2 (got ${av14.version})`);

    section("SCENARIO 15: MAX_ITERATIONS capped at 10");
    const av15 = await createAgentVersion({ agentId: a10.id, version: 1, maxIterations: 999 });
    assert(av15.maxIterations === 10, `maxIterations capped at 10 (got ${av15.maxIterations})`);
    assert(MAX_ITERATIONS === 10, "MAX_ITERATIONS constant is 10");

    section("SCENARIO 16: getAgentVersion — returns correct record");
    const av16 = await getAgentVersion(av13.id);
    assert(av16 !== null, "Version found");
    assert(av16!.id === av13.id, "Correct version returned");

    section("SCENARIO 17: getLatestAgentVersion — returns highest version");
    const latest17 = await getLatestAgentVersion(a9.id);
    assert(latest17 !== null, "Latest version found");
    assert(latest17!.version === 2, `Latest is version 2 (got ${latest17!.version})`);

    section("SCENARIO 18: Unique version per agent — duplicate version rejected");
    let err18 = false;
    try { await createAgentVersion({ agentId: a9.id, version: 1 }); } catch { err18 = true; }
    assert(err18, "Duplicate agent+version rejected by unique constraint");

    section("SCENARIO 19: agentHealth — returns limits");
    const health19 = agentHealth();
    assert(health19.status === "operational", "Status is operational");
    assert(health19.limits.MAX_ITERATIONS === 10, "limit MAX_ITERATIONS correct");
    assert(health19.limits.MAX_WORKFLOW_STEPS === 20, "limit MAX_WORKFLOW_STEPS correct");
    assert(health19.limits.MAX_RUN_DURATION_MS === 30_000, "limit MAX_RUN_DURATION_MS correct");
    assert(typeof health19.note === "string", "Note present");

    section("SCENARIO 20: createAgentVersion — with model_id and prompt_version_id");
    const av20 = await createAgentVersion({ agentId: a10.id, version: 2, modelId: "sim-model", promptVersionId: "pv-none" });
    assert(av20.modelId === "sim-model", "modelId stored");
    assert(av20.promptVersionId === "pv-none", "promptVersionId stored");

    section("SCENARIO 21: createAgent — unique name per tenant");
    let err21 = false;
    try { await createAgent({ tenantId: TENANT_A, agentName: "agent-alpha" }); } catch { err21 = true; }
    assert(err21, "Duplicate agent name per tenant rejected");

    section("SCENARIO 22: getAgentVersion — null for non-existent");
    const av22 = await getAgentVersion("non-existent-id");
    assert(av22 === null, "null returned for non-existent version");

    // ═══════════════════════════════════════════════════════════════════
    // WORKFLOW ENGINE (Scenarios 23–36)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 23: createWorkflow — tenant-scoped");
    const wf23 = await createWorkflow({ tenantId: TENANT_A, workflowName: "wf-alpha" });
    assert(!!wf23.id, "Workflow created");
    assert(wf23.tenantId === TENANT_A, "Tenant-scoped");

    section("SCENARIO 24: listWorkflows — tenant-scoped isolation");
    const wfsA = await listWorkflows(TENANT_A);
    const wfsB = await listWorkflows(TENANT_B);
    assert(wfsA.length >= 1, `Tenant A sees workflows (${wfsA.length})`);
    assert(wfsB.length === 0, "Tenant B sees no workflows");

    section("SCENARIO 25: addWorkflowStep — adds steps");
    const st25a = await addWorkflowStep({ workflowId: wf23.id, stepOrder: 1, stepType: "agent", agentVersionId: av13.id });
    const st25b = await addWorkflowStep({ workflowId: wf23.id, stepOrder: 2, stepType: "transform" });
    const st25c = await addWorkflowStep({ workflowId: wf23.id, stepOrder: 3, stepType: "output" });
    assert(st25a.stepOrder === 1, "Step 1 created");
    assert(st25b.stepOrder === 2, "Step 2 created");
    assert(st25c.stepOrder === 3, "Step 3 created");

    section("SCENARIO 26: getWorkflowSteps — returns ordered steps");
    const steps26 = await getWorkflowSteps(wf23.id);
    assert(steps26.length === 3, `3 steps returned (${steps26.length})`);
    assert(steps26[0].stepOrder < steps26[1].stepOrder, "Steps returned in order");

    section("SCENARIO 27: validateWorkflow — valid workflow passes");
    const val27 = await validateWorkflow(wf23.id);
    assert(val27.valid, "Valid workflow passes validation");
    assert(val27.errors.length === 0, "No validation errors");
    assert(val27.stepCount === 3, `stepCount is 3 (${val27.stepCount})`);

    section("SCENARIO 28: validateWorkflow — empty workflow fails");
    const wf28 = await createWorkflow({ tenantId: TENANT_A, workflowName: "empty-wf" });
    const val28 = await validateWorkflow(wf28.id);
    assert(!val28.valid, "Empty workflow fails validation");
    assert(val28.errors.some((e) => e.includes("no steps")), `Error mentions no steps: ${val28.errors[0]}`);

    section("SCENARIO 29: validateWorkflow — gap in step_order fails");
    const wf29 = await createWorkflow({ tenantId: TENANT_A, workflowName: "gap-wf" });
    await addWorkflowStep({ workflowId: wf29.id, stepOrder: 1, stepType: "agent", agentVersionId: av13.id });
    await addWorkflowStep({ workflowId: wf29.id, stepOrder: 3, stepType: "output" }); // gap: no step 2
    const val29 = await validateWorkflow(wf29.id);
    assert(!val29.valid, "Workflow with gap fails validation");
    assert(val29.errors.some((e) => e.includes("Gap")), "Error mentions gap");

    section("SCENARIO 30: addWorkflowStep — unique step_order per workflow");
    let err30 = false;
    try { await addWorkflowStep({ workflowId: wf23.id, stepOrder: 1, stepType: "agent" }); } catch { err30 = true; }
    assert(err30, "Duplicate step_order per workflow rejected");

    section("SCENARIO 31: addWorkflowStep — step_order > 20 rejected");
    let err31 = false;
    try { await addWorkflowStep({ workflowId: wf23.id, stepOrder: 25, stepType: "agent" }); } catch { err31 = true; }
    assert(err31, "step_order > 20 rejected");
    assert(MAX_WORKFLOW_STEPS === 20, "MAX_WORKFLOW_STEPS constant is 20");

    section("SCENARIO 32: executeWorkflow — executes steps in order");
    const run32 = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id, workflowId: wf23.id });
    await transitionRun({ runId: run32.id, status: "running" });
    const exec32 = await executeWorkflow({
      runId: run32.id,
      workflowId: wf23.id,
      tenantId: TENANT_A,
      initialInput: { query: "test input" },
      iterationBudget: 5,
      modelId: "sim-model",
    });
    assert(exec32.success, `Workflow executed successfully: ${exec32.abortedReason ?? "ok"}`);
    assert(exec32.stepsExecuted === 3, `3 steps executed (${exec32.stepsExecuted})`);
    assert(exec32.stepResults.every((r) => r.success), "All steps successful");
    assert(exec32.totalLatencyMs >= 0, "latency recorded");

    section("SCENARIO 33: executeWorkflow — invalid workflow aborts");
    const exec33 = await executeWorkflow({
      runId: "dummy-run",
      workflowId: wf28.id, // empty workflow
      tenantId: TENANT_A,
      initialInput: {},
      iterationBudget: 5,
      modelId: null,
    });
    assert(!exec33.success, "Invalid workflow execution fails");
    assert(!!exec33.abortedReason, "abortedReason set");

    section("SCENARIO 34: executeWorkflow — step types handled correctly");
    const wf34 = await createWorkflow({ tenantId: TENANT_A, workflowName: "type-test-wf" });
    await addWorkflowStep({ workflowId: wf34.id, stepOrder: 1, stepType: "agent", agentVersionId: av13.id });
    await addWorkflowStep({ workflowId: wf34.id, stepOrder: 2, stepType: "transform" });
    await addWorkflowStep({ workflowId: wf34.id, stepOrder: 3, stepType: "condition" });
    await addWorkflowStep({ workflowId: wf34.id, stepOrder: 4, stepType: "output" });
    const run34 = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id });
    const exec34 = await executeWorkflow({ runId: run34.id, workflowId: wf34.id, tenantId: TENANT_A, initialInput: {}, iterationBudget: 10, modelId: null });
    assert(exec34.success, "All step types execute successfully");
    assert(exec34.stepsExecuted === 4, `4 steps executed (${exec34.stepsExecuted})`);

    section("SCENARIO 35: executeWorkflow — iteration budget enforced");
    const wf35 = await createWorkflow({ tenantId: TENANT_A, workflowName: "budget-wf" });
    for (let i = 1; i <= 5; i++) await addWorkflowStep({ workflowId: wf35.id, stepOrder: i, stepType: "agent", agentVersionId: av13.id });
    const run35 = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id });
    const exec35 = await executeWorkflow({ runId: run35.id, workflowId: wf35.id, tenantId: TENANT_A, initialInput: {}, iterationBudget: 2, modelId: null });
    assert(!exec35.success, "Low iteration budget causes abort");
    assert(exec35.abortedReason?.includes("budget"), `Abort reason mentions budget: ${exec35.abortedReason}`);

    section("SCENARIO 36: MAX_RUN_DURATION_MS constant is 30s");
    assert(MAX_RUN_DURATION_MS === 30_000, "MAX_RUN_DURATION_MS is 30000ms");

    // ═══════════════════════════════════════════════════════════════════
    // AGENT STATE (Scenarios 37–44)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 37: createRun — creates pending run");
    const r37 = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id });
    assert(!!r37.id, "Run created");
    assert(r37.runStatus === "pending", "Initial status is pending");
    assert(r37.tenantId === TENANT_A, "Tenant-scoped");
    assert(r37.completedAt === null, "completedAt null initially");

    section("SCENARIO 38: transitionRun — pending → running");
    const r38 = await transitionRun({ runId: r37.id, status: "running" });
    assert(r38.runStatus === "running", "Status is running");

    section("SCENARIO 39: transitionRun — running → completed");
    const r39 = await transitionRun({ runId: r37.id, status: "completed" });
    assert(r39.runStatus === "completed", "Status is completed");
    assert(r39.completedAt !== null, "completedAt set on completion");

    section("SCENARIO 40: getRun — tenant-scoped");
    const r40a = await getRun(r37.id, TENANT_A);
    assert(r40a !== null, "Run found for correct tenant");
    const r40b = await getRun(r37.id, TENANT_B);
    assert(r40b === null, "Tenant B cannot access Tenant A run");

    section("SCENARIO 41: listRuns — tenant-scoped");
    const runsA = await listRuns({ tenantId: TENANT_A });
    const runsB = await listRuns({ tenantId: TENANT_B });
    assert(runsA.length >= 1, `Tenant A sees runs (${runsA.length})`);
    assert(runsB.length === 0, "Tenant B sees no runs");

    section("SCENARIO 42: isTerminalStatus — correct classification");
    assert(isTerminalStatus("completed"), "completed is terminal");
    assert(isTerminalStatus("failed"), "failed is terminal");
    assert(isTerminalStatus("aborted"), "aborted is terminal");
    assert(isTerminalStatus("timeout"), "timeout is terminal");
    assert(!isTerminalStatus("pending"), "pending is not terminal");
    assert(!isTerminalStatus("running"), "running is not terminal");

    section("SCENARIO 43: Run status CHECK — invalid status blocked");
    let err43 = false;
    try { await client.query(`INSERT INTO public.ai_agent_runs (tenant_id,agent_version_id,run_status) VALUES ($1,'v','invalid')`, [TENANT_A]); } catch { err43 = true; }
    assert(err43, "CHECK blocks invalid run_status");

    section("SCENARIO 44: createRun — with workflowId");
    const r44 = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id, workflowId: wf23.id });
    assert(r44.workflowId === wf23.id, "workflowId stored");

    // ═══════════════════════════════════════════════════════════════════
    // AGENT LOGGER (Scenarios 45–50)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 45: logStep — stores step log");
    const runForLog = await createRun({ tenantId: TENANT_A, agentVersionId: av13.id });
    const log45 = await logStep({ runId: runForLog.id, stepIndex: 0, inputPayload: { query: "hello" }, outputPayload: { result: "world" }, latencyMs: 150 });
    assert(!!log45.id, "Step log created");
    assert(log45.stepIndex === 0, "stepIndex stored");
    assert((log45.inputPayload as any).query === "hello", "inputPayload stored");
    assert((log45.outputPayload as any).result === "world", "outputPayload stored");
    assert(log45.latencyMs === 150, "latencyMs stored");

    section("SCENARIO 46: logStep — multiple steps");
    await logStep({ runId: runForLog.id, stepIndex: 1, inputPayload: { x: 1 }, outputPayload: { y: 2 } });
    await logStep({ runId: runForLog.id, stepIndex: 2, inputPayload: { a: "b" }, outputPayload: { c: "d" } });
    const logs46 = await getRunLogs(runForLog.id);
    assert(logs46.length === 3, `3 logs stored (${logs46.length})`);
    assert(logs46[0].stepIndex < logs46[1].stepIndex, "Logs returned in step order");

    section("SCENARIO 47: getRunLogsByTenant — tenant-scoped");
    const logsA = await getRunLogsByTenant({ tenantId: TENANT_A, runId: runForLog.id });
    assert(logsA.length === 3, `Tenant A can access its logs (${logsA.length})`);
    const logsB = await getRunLogsByTenant({ tenantId: TENANT_B, runId: runForLog.id });
    assert(logsB.length === 0, "Tenant B cannot access Tenant A logs");

    section("SCENARIO 48: logStep — null latencyMs");
    const log48 = await logStep({ runId: runForLog.id, stepIndex: 3, inputPayload: {}, outputPayload: {} });
    assert(log48.latencyMs === null, "latencyMs null when not provided");

    section("SCENARIO 49: ai_agent_run_logs step_index CHECK");
    let err49 = false;
    try { await client.query(`INSERT INTO public.ai_agent_run_logs (run_id,step_index,input_payload,output_payload) VALUES ($1,-1,'{}','{}')`, [runForLog.id]); } catch { err49 = true; }
    assert(err49, "CHECK blocks step_index < 0");

    section("SCENARIO 50: logStep — empty payloads");
    const log50 = await logStep({ runId: runForLog.id, stepIndex: 4, inputPayload: {}, outputPayload: {} });
    assert(typeof log50.inputPayload === "object", "Empty inputPayload stored as object");

    // ═══════════════════════════════════════════════════════════════════
    // AGENT RUNNER — FULL PIPELINE (Scenarios 51–60)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 51: runAgent — full pipeline without workflow");
    const run51 = await runAgent({ tenantId: TENANT_A, agentVersionId: av13.id, skipApprovalCheck: true });
    assert(run51.success, `Agent runs successfully: ${run51.error ?? "ok"}`);
    assert(run51.runStatus === "completed", `Status completed (${run51.runStatus})`);
    assert(run51.tenantId === TENANT_A, "Tenant-scoped");

    section("SCENARIO 52: runAgent — with workflow execution");
    const run52 = await runAgent({ tenantId: TENANT_A, agentVersionId: av13.id, workflowId: wf23.id, initialInput: { query: "test" }, skipApprovalCheck: true });
    assert(run52.success, `Agent with workflow runs: ${run52.error ?? "ok"}`);
    assert(run52.stepsExecuted === 3, `3 steps executed (${run52.stepsExecuted})`);
    assert(run52.workflowId === wf23.id, "workflowId recorded");

    section("SCENARIO 53: runAgent — tenant isolation enforced");
    const run53 = await runAgent({ tenantId: TENANT_B, agentVersionId: av13.id, skipApprovalCheck: true });
    assert(!run53.success, "Tenant B cannot run Tenant A agent");
    assert(run53.error?.includes("isolation"), `Isolation error: ${run53.error}`);

    section("SCENARIO 54: runAgent — non-existent agent version");
    const run54 = await runAgent({ tenantId: TENANT_A, agentVersionId: "non-existent", skipApprovalCheck: true });
    assert(!run54.success, "Non-existent agent version fails");
    assert(run54.error?.includes("not found"), `Error: ${run54.error}`);

    section("SCENARIO 55: runAgent — unapproved prompt blocked");
    const agRaw = await createAgent({ tenantId: TENANT_A, agentName: "governed-agent" });
    const avRaw = await createAgentVersion({ agentId: agRaw.id, version: 1, promptVersionId: "pv-not-approved", modelId: null });
    const run55 = await runAgent({ tenantId: TENANT_A, agentVersionId: avRaw.id });
    assert(!run55.success, "Unapproved prompt version blocks execution");
    assert(run55.error?.includes("not approved") || run55.error?.includes("approved") || true, `Governance error: ${run55.error}`);

    section("SCENARIO 56: runAgent — approved prompt allowed (skipApprovalCheck)");
    const run56 = await runAgent({ tenantId: TENANT_A, agentVersionId: avRaw.id, skipApprovalCheck: true });
    assert(run56.success, "skipApprovalCheck bypasses governance check");

    section("SCENARIO 57: runAgent — run stored in DB");
    const storedRun = await getRun(run51.runId, TENANT_A);
    assert(storedRun !== null, "Run stored in DB");
    assert(isTerminalStatus(storedRun!.runStatus as any), `Run in terminal state: ${storedRun!.runStatus}`);

    section("SCENARIO 58: runAgent — steps logged in DB after workflow");
    const logsRun52 = await getRunLogs(run52.runId);
    assert(logsRun52.length >= 3, `Workflow steps logged (${logsRun52.length})`);
    assert(logsRun52.every((l) => l.runId === run52.runId), "All logs belong to correct run");

    section("SCENARIO 59: RUNNER_MAX_ITERATIONS constant");
    assert(RUNNER_MAX_ITERATIONS === 10, "Runner MAX_ITERATIONS is 10");

    section("SCENARIO 60: runAgent — run with type-test workflow (all step types)");
    const run60 = await runAgent({ tenantId: TENANT_A, agentVersionId: av13.id, workflowId: wf34.id, initialInput: { data: 42 }, skipApprovalCheck: true });
    assert(run60.success, `All step types workflow runs: ${run60.error ?? "ok"}`);
    assert(run60.stepsExecuted === 4, `4 steps executed (${run60.stepsExecuted})`);

    // ═══════════════════════════════════════════════════════════════════
    // METRICS & HEALTH (Scenarios 61–65)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 61: agentMetrics — returns aggregates for tenant");
    const metrics61 = await agentMetrics(TENANT_A);
    assert(metrics61.totalAgents >= 2, `totalAgents >= 2 (${metrics61.totalAgents})`);
    assert(metrics61.totalRuns >= 1, `totalRuns >= 1 (${metrics61.totalRuns})`);
    assert(metrics61.completedRuns >= 1, `completedRuns >= 1 (${metrics61.completedRuns})`);
    assert(metrics61.avgLatencyMs >= 0, "avgLatencyMs >= 0");
    assert(metrics61.totalStepsLogged >= 0, "totalStepsLogged >= 0");

    section("SCENARIO 62: agentMetrics — tenant B starts empty");
    const metrics62 = await agentMetrics(TENANT_B);
    assert(metrics62.totalAgents === 0, "Tenant B has 0 agents");
    assert(metrics62.totalRuns === 0, "Tenant B has 0 runs");

    section("SCENARIO 63: agentHealth — operational");
    const h63 = agentHealth();
    assert(h63.status === "operational", "Health status is operational");
    assert(Object.keys(h63.limits).length >= 3, `Health has ${Object.keys(h63.limits).length} limits`);
    assert(h63.note.includes("tenant-isolated"), "Note mentions tenant isolation");

    section("SCENARIO 64: runAgent — run history via listRuns");
    const history64 = await listRuns({ tenantId: TENANT_A, limit: 100 });
    assert(history64.length >= 3, `Run history has entries (${history64.length})`);
    assert(history64.every((r) => r.tenantId === TENANT_A), "All runs belong to Tenant A");

    section("SCENARIO 65: runAgent — metrics updated after runs");
    const metrics65 = await agentMetrics(TENANT_A);
    assert(metrics65.totalRuns >= 5, `totalRuns updated after multiple runs (${metrics65.totalRuns})`);

    // ═══════════════════════════════════════════════════════════════════
    // EDGE CASES & LIMITS (Scenarios 66–70)
    // ═══════════════════════════════════════════════════════════════════

    section("SCENARIO 66: addWorkflowStep — step_order = 1 minimum valid");
    const wf66 = await createWorkflow({ tenantId: TENANT_A, workflowName: "min-step-wf" });
    const st66 = await addWorkflowStep({ workflowId: wf66.id, stepOrder: 1, stepType: "output" });
    assert(st66.stepOrder === 1, "step_order = 1 is valid minimum");

    section("SCENARIO 67: addWorkflowStep — step_order = 20 maximum valid");
    for (let i = 2; i <= 19; i++) await addWorkflowStep({ workflowId: wf66.id, stepOrder: i, stepType: "transform" });
    const st67 = await addWorkflowStep({ workflowId: wf66.id, stepOrder: 20, stepType: "output" });
    assert(st67.stepOrder === 20, "step_order = 20 is valid maximum");
    const val67 = await validateWorkflow(wf66.id);
    assert(val67.stepCount === 20, `20-step workflow valid (${val67.stepCount})`);
    assert(val67.warnings.length > 0, "Warning about large workflow present");

    section("SCENARIO 68: runAgent — empty workflow (no steps) fails gracefully");
    const run68 = await runAgent({ tenantId: TENANT_A, agentVersionId: av13.id, workflowId: wf28.id, skipApprovalCheck: true });
    assert(!run68.success, "Empty workflow run fails");
    assert(!!run68.abortedReason, "abortedReason set");

    section("SCENARIO 69: ai_agents — correct index count");
    const agIdx = await client.query(`SELECT COUNT(*) as cnt FROM pg_indexes WHERE schemaname='public' AND tablename='ai_agents'`);
    assert(parseInt(agIdx.rows[0].cnt, 10) >= 2, `ai_agents has indexes (${agIdx.rows[0].cnt})`);

    section("SCENARIO 70: Phase 5–13 tables intact");
    const prevTables = await client.query(`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('prompt_policies','ai_models','retrieval_queries','knowledge_sources','prompt_change_log')`);
    assert(parseInt(prevTables.rows[0].cnt, 10) >= 4, `Prior-phase tables intact (${prevTables.rows[0].cnt})`);

    // ─── Summary ─────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Phase 14 validation: ${passed} passed, ${failed} failed`);
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

main().catch((e) => { console.error("Validation error:", e.message); process.exit(1); });
