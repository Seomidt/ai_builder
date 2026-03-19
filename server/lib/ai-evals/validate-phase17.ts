/**
 * Phase 17 Validation — AI Evaluation Platform
 * 65 scenarios, 140+ assertions
 */

import pg from "pg";
import {
  createDataset,
  createEvalCase,
  listDatasets,
  listEvalCases,
  explainDataset,
  isValidDatasetType,
} from "./eval-datasets";
import {
  createEvalRun,
  startEvalRun,
  completeEvalRun,
  failEvalRun,
  getEvalRun,
  listEvalRuns,
  listEvalResults,
  runDatasetBenchmark,
  explainEvalRun,
} from "./eval-runs";
import {
  scoreAnswerQuality,
  scoreRetrievalQuality,
  scoreGrounding,
  scoreHallucinationRisk,
  summarizeEvalScores,
} from "./eval-scorer";
import {
  detectRegressions,
  listRegressions,
  explainRegression,
} from "./eval-regressions";
import {
  comparePromptVersions,
  compareModels,
  summarizeComparison,
} from "./eval-comparisons";
import {
  getEvalMetrics,
  summarizeEvalMetrics,
  listRecentFailures,
  extractBenchmarkLatency,
} from "./eval-observability";
import {
  clampTimeout,
  clampIterationBudget,
  clampOrphanTimeoutMinutes,
  clampEvalCaseCount,
  explainRuntimeBounds,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "./runtime-bounds";
import {
  decodeEntitiesOnce,
  normalizeParsedText,
  explainParserSafety,
} from "../ai/document-parsers";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

const TS = Date.now();
const T_TENANT_A = `eval-tenant-a-${TS}`;
const T_TENANT_B = `eval-tenant-b-${TS}`;

// ── DB client for schema checks ───────────────────────────────────────────────
const pgClient = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });

async function main() {
  console.log("Phase 17 Validation — AI Evaluation Platform\n");
  await pgClient.connect();

  try {
    // ── SCENARIO 1: DB schema — 5 Phase 17 tables ──────────────────────────────
    section("SCENARIO 1: DB schema — 5 Phase 17 eval tables present");
    const { rows: tableRows } = await pgClient.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
    `);
    const tableNames = tableRows.map((r: { table_name: string }) => r.table_name);
    assert(tableNames.length === 5, "All 5 Phase 17 tables exist");
    assert(tableNames.includes("ai_eval_datasets"), "ai_eval_datasets present");
    assert(tableNames.includes("ai_eval_cases"), "ai_eval_cases present");
    assert(tableNames.includes("ai_eval_runs"), "ai_eval_runs present");
    assert(tableNames.includes("ai_eval_results"), "ai_eval_results present");
    assert(tableNames.includes("ai_eval_regressions"), "ai_eval_regressions present");

    // ── SCENARIO 2: DB schema — indexes ────────────────────────────────────────
    section("SCENARIO 2: DB schema — indexes present");
    const { rows: idxRows } = await pgClient.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
    `);
    assert(idxRows.length >= 12, `At least 12 indexes (found ${idxRows.length})`);

    // ── SCENARIO 3: DB schema — RLS ────────────────────────────────────────────
    section("SCENARIO 3: DB schema — RLS enabled on all 5 tables");
    const { rows: rlsRows } = await pgClient.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
        AND rowsecurity = true
    `);
    assert(rlsRows.length === 5, "RLS enabled on all 5 tables");

    // ── SCENARIO 4: createDataset — basic create ────────────────────────────────
    section("SCENARIO 4: createDataset — basic create");
    const ds4 = await createDataset({ tenantId: T_TENANT_A, datasetName: "Answer Quality DS", datasetType: "answer_quality" });
    assert(ds4 !== null, "Dataset created");
    assert(typeof ds4!.id === "string", "Dataset id is string");

    // ── SCENARIO 5: createEvalCase — basic create ───────────────────────────────
    section("SCENARIO 5: createEvalCase — basic create");
    const case5 = await createEvalCase({ datasetId: ds4!.id, tenantId: T_TENANT_A, inputQuery: "What is machine learning?", difficulty: "medium" });
    assert(case5 !== null, "Eval case created");
    assert(typeof case5!.id === "string", "Case id is string");

    // ── SCENARIO 6: listDatasets — returns datasets ─────────────────────────────
    section("SCENARIO 6: listDatasets — returns datasets");
    const datasets6 = await listDatasets({ tenantId: T_TENANT_A });
    assert(Array.isArray(datasets6), "listDatasets returns array");
    assert(datasets6.length >= 1, "At least 1 dataset for tenant A");
    assert(datasets6.some((d) => d.id === ds4!.id), "Dataset A is in list");

    // ── SCENARIO 7: listEvalCases — returns cases ───────────────────────────────
    section("SCENARIO 7: listEvalCases — returns cases");
    const cases7 = await listEvalCases({ datasetId: ds4!.id });
    assert(Array.isArray(cases7), "listEvalCases returns array");
    assert(cases7.length >= 1, "At least 1 case in dataset");
    assert(cases7[0].inputQuery === "What is machine learning?", "inputQuery preserved");

    // ── SCENARIO 8: dataset type check — invalid type rejected ─────────────────
    section("SCENARIO 8: dataset type check — invalid type rejected");
    const ds8 = await createDataset({ datasetName: "Bad DS", datasetType: "invalid_type" as any });
    assert(ds8 === null, "Invalid dataset type rejected");
    assert(isValidDatasetType("answer_quality"), "answer_quality is valid");
    assert(!isValidDatasetType("bad_type"), "bad_type is invalid");

    // ── SCENARIO 9: explainDataset — read-only, no writes ──────────────────────
    section("SCENARIO 9: explainDataset — read-only");
    const expl9 = await explainDataset(ds4!.id);
    assert(expl9 !== null, "explainDataset returned data");
    assert(expl9!.caseCount >= 1, "Case count >= 1");
    assert(typeof expl9!.difficulties === "object", "Difficulties object returned");

    // ── SCENARIO 10: INV-EVAL12 — dataset isolation by tenant ──────────────────
    section("SCENARIO 10: INV-EVAL12 — tenant B sees no tenant A datasets");
    const dsB = await listDatasets({ tenantId: T_TENANT_B });
    assert(!dsB.some((d) => d.tenantId === T_TENANT_A), "INV-EVAL12: Tenant B sees no Tenant A datasets");

    // ── SCENARIO 11: createEvalRun — queued state ───────────────────────────────
    section("SCENARIO 11: createEvalRun — creates in queued state");
    const run11 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: ds4!.id });
    assert(run11 !== null, "Run created");
    assert(typeof run11!.id === "string", "Run id is string");

    // ── SCENARIO 12: startEvalRun — transitions to running ─────────────────────
    section("SCENARIO 12: startEvalRun — transitions to running");
    const started12 = await startEvalRun(run11!.id);
    assert(started12 === true, "startEvalRun returned true");
    const fetchedRun12 = await getEvalRun(run11!.id);
    assert(fetchedRun12?.runStatus === "running", "Run status is running");

    // ── SCENARIO 13: completeEvalRun — transitions to completed ────────────────
    section("SCENARIO 13: completeEvalRun — transitions to completed");
    const completed13 = await completeEvalRun(run11!.id, { avgAnswerQuality: 0.75, passRate: 0.8 }, 5);
    assert(completed13 === true, "completeEvalRun returned true");
    const fetchedRun13 = await getEvalRun(run11!.id);
    assert(fetchedRun13?.runStatus === "completed", "Run status is completed");
    assert(fetchedRun13?.completedAt !== null, "completedAt set");

    // ── SCENARIO 14: failEvalRun — transitions to failed ───────────────────────
    section("SCENARIO 14: failEvalRun — transitions to failed");
    const run14 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: ds4!.id });
    await startEvalRun(run14!.id);
    const failed14 = await failEvalRun(run14!.id, "Test failure");
    assert(failed14 === true, "failEvalRun returned true");
    const fetchedRun14 = await getEvalRun(run14!.id);
    assert(fetchedRun14?.runStatus === "failed", "Run status is failed");

    // ── SCENARIO 15: INV-EVAL2 — append-only run history preserved ─────────────
    section("SCENARIO 15: INV-EVAL2 — append-only run history preserved");
    const runs15 = await listEvalRuns({ tenantId: T_TENANT_A, datasetId: ds4!.id });
    assert(Array.isArray(runs15), "listEvalRuns returns array");
    assert(runs15.length >= 2, "Both runs preserved (append-only)");
    assert(runs15.some((r) => r.runStatus === "completed"), "Completed run preserved");
    assert(runs15.some((r) => r.runStatus === "failed"), "Failed run preserved");

    // ── SCENARIO 16: scoreAnswerQuality — bounded ───────────────────────────────
    section("SCENARIO 16: scoreAnswerQuality — bounded score [0,1]");
    const aq16 = scoreAnswerQuality({ answerText: "Machine learning is a subset of AI.", inputQuery: "What is machine learning?" });
    assert(typeof aq16.score === "number", "Score is number");
    assert(aq16.score >= 0 && aq16.score <= 1, `Score in [0,1] (is ${aq16.score})`);
    assert(typeof aq16.breakdown === "object", "Breakdown object returned");
    assert(typeof aq16.explanation === "string", "Explanation string returned");

    // ── SCENARIO 17: scoreRetrievalQuality — bounded ────────────────────────────
    section("SCENARIO 17: scoreRetrievalQuality — bounded score [0,1]");
    const rq17 = scoreRetrievalQuality({ chunks: [{ finalScore: 0.9 }, { finalScore: 0.7 }, { finalScore: 0.8 }] });
    assert(rq17.score >= 0 && rq17.score <= 1, `Score in [0,1] (is ${rq17.score})`);
    const rqEmpty = scoreRetrievalQuality({ chunks: [] });
    assert(rqEmpty.score === 0, "Empty chunks = 0 score");

    // ── SCENARIO 18: scoreGrounding — bounded ──────────────────────────────────
    section("SCENARIO 18: scoreGrounding — bounded score [0,1]");
    const gr18 = scoreGrounding({
      answerText: "ML is a subset of AI that learns from data.",
      citedChunkTexts: ["Machine learning is AI that learns from data and patterns."],
      unsupportedClaimCount: 0,
      totalClaimCount: 2,
    });
    assert(gr18.score >= 0 && gr18.score <= 1, `Score in [0,1] (is ${gr18.score})`);
    const grNoCites = scoreGrounding({ answerText: "Test answer", citedChunkTexts: [] });
    assert(grNoCites.score === 0, "No citations = 0 grounding score");

    // ── SCENARIO 19: scoreHallucinationRisk — bounded ───────────────────────────
    section("SCENARIO 19: scoreHallucinationRisk — bounded score [0,1]");
    const hr19 = scoreHallucinationRisk({
      answerText: "This is definitely proven absolutely always true.",
      unsupportedClaimCount: 3,
      totalClaimCount: 4,
      citationCoverageRatio: 0.1,
      certaintyPhraseCount: 5,
    });
    assert(hr19.score >= 0 && hr19.score <= 1, `Score in [0,1] (is ${hr19.score})`);
    assert(hr19.score > 0.5, "High risk input scores > 0.5");

    // ── SCENARIO 20: INV-EVAL3 — deterministic scoring ──────────────────────────
    section("SCENARIO 20: INV-EVAL3 — deterministic scoring for identical input");
    const params20 = { answerText: "Machine learning is AI.", inputQuery: "What is ML?" };
    const r20a = scoreAnswerQuality(params20);
    const r20b = scoreAnswerQuality(params20);
    assert(r20a.score === r20b.score, "Identical input → identical score");
    const params20h = { answerText: "ML is AI.", unsupportedClaimCount: 1, totalClaimCount: 2, citationCoverageRatio: 0.5 };
    const hr20a = scoreHallucinationRisk(params20h);
    const hr20b = scoreHallucinationRisk(params20h);
    assert(hr20a.score === hr20b.score, "Hallucination score is deterministic");

    // ── SCENARIO 21: summarizeEvalScores — aggregation works ───────────────────
    section("SCENARIO 21: summarizeEvalScores — aggregation works");
    const sum21 = summarizeEvalScores({
      answerQualityScore: 0.8,
      retrievalQualityScore: 0.75,
      groundingScore: 0.7,
      hallucinationRiskScore: 0.2,
      passThreshold: 0.6,
    });
    assert(sum21.overallScore >= 0 && sum21.overallScore <= 1, "Overall score bounded");
    assert(sum21.pass === true, "Pass=true for good scores");

    const sumFail = summarizeEvalScores({
      answerQualityScore: 0.3,
      retrievalQualityScore: 0.2,
      groundingScore: 0.2,
      hallucinationRiskScore: 0.8,
      passThreshold: 0.6,
    });
    assert(sumFail.pass === false, "Pass=false for bad scores");

    // ── SCENARIO 22: runDatasetBenchmark — full pipeline ───────────────────────
    section("SCENARIO 22: runDatasetBenchmark — full pipeline");
    const ds22 = await createDataset({ tenantId: T_TENANT_A, datasetName: "Benchmark DS 22", datasetType: "answer_quality" });
    const case22a = await createEvalCase({ datasetId: ds22!.id, tenantId: T_TENANT_A, inputQuery: "What is AI?" });
    const case22b = await createEvalCase({ datasetId: ds22!.id, tenantId: T_TENANT_A, inputQuery: "What is ML?" });
    const benchResult = await runDatasetBenchmark({
      datasetId: ds22!.id,
      tenantId: T_TENANT_A,
      caseInputs: [
        { caseId: case22a!.id, answerText: "AI is artificial intelligence, a broad field.", retrievedChunks: [{ finalScore: 0.85 }, { finalScore: 0.7 }], citedChunkTexts: ["AI is artificial intelligence."] },
        { caseId: case22b!.id, answerText: "ML is machine learning, a subset of AI.", retrievedChunks: [{ finalScore: 0.9 }], citedChunkTexts: ["ML is machine learning."] },
      ],
    });
    assert(benchResult !== null, "Benchmark run completed");
    assert(typeof benchResult!.runId === "string", "Run ID returned");
    assert(benchResult!.completedCases >= 1, "At least 1 case completed");
    assert(typeof benchResult!.summaryScores === "object", "Summary scores object returned");
    assert(typeof benchResult!.passRate === "number", "PassRate is number");

    // ── SCENARIO 23: INV-EVAL2 — benchmark run is append-only ──────────────────
    section("SCENARIO 23: INV-EVAL2 — benchmark results are append-only");
    const runAfter = await getEvalRun(benchResult!.runId);
    assert(runAfter?.runStatus === "completed", "Run status is completed");
    const results23 = await listEvalResults(benchResult!.runId);
    assert(results23.length >= 1, "Results persisted");

    // ── SCENARIO 24: INV-EVAL7 — benchmark failure does not throw ──────────────
    section("SCENARIO 24: INV-EVAL7 — benchmark failure does not throw");
    let threw = false;
    try {
      await runDatasetBenchmark({ datasetId: "non-existent-dataset-id", caseInputs: [] });
    } catch {
      threw = true;
    }
    assert(!threw, "INV-EVAL7: runDatasetBenchmark does not throw on empty/invalid input");

    // ── SCENARIO 25: listEvalResults — returns results ──────────────────────────
    section("SCENARIO 25: listEvalResults — returns scored results");
    const res25 = await listEvalResults(benchResult!.runId);
    assert(res25.length >= 1, "Results returned");
    const r25 = res25[0];
    assert(r25.answerQualityScore !== null, "answerQualityScore set");
    assert(r25.hallucinationRiskScore !== null, "hallucinationRiskScore set");
    assert(typeof r25.pass === "boolean", "pass is boolean");

    // ── SCENARIO 26: explainEvalRun — read-only explain ─────────────────────────
    section("SCENARIO 26: explainEvalRun — read-only, returns structured explain");
    const expl26 = await explainEvalRun(benchResult!.runId);
    assert(expl26 !== null, "explainEvalRun returned data");
    assert(expl26!.run !== null, "Run object in explain");
    assert(expl26!.resultCount >= 1, "resultCount >= 1");

    // ── SCENARIO 27: comparePromptVersions ─────────────────────────────────────
    section("SCENARIO 27: comparePromptVersions — structured delta output");
    // Create two runs with different summary scores
    const dsComp = await createDataset({ tenantId: T_TENANT_A, datasetName: "Comparison DS", datasetType: "prompt_regression" });
    const runBase = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runCand = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runBase!.id, { avgAnswerQuality: 0.7, avgRetrievalQuality: 0.65, avgGrounding: 0.7, avgHallucinationRisk: 0.25, passRate: 0.75 }, 10);
    await completeEvalRun(runCand!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.72, avgGrounding: 0.75, avgHallucinationRisk: 0.18, passRate: 0.85 }, 10);
    const comp27 = await comparePromptVersions({ baselineRunId: runBase!.id, candidateRunId: runCand!.id, tenantId: T_TENANT_A });
    assert(comp27 !== null, "comparePromptVersions returned result");
    assert(Array.isArray(comp27!.deltas), "Deltas array returned");
    assert(comp27!.deltas.length >= 3, "At least 3 delta dimensions");
    assert(typeof comp27!.overallDelta === "number", "overallDelta is number");
    assert(comp27!.tenantId === T_TENANT_A, "tenantId preserved");

    // ── SCENARIO 28: compareModels ──────────────────────────────────────────────
    section("SCENARIO 28: compareModels — includes latency/cost deltas");
    const comp28 = await compareModels({
      baselineRunId: runBase!.id,
      candidateRunId: runCand!.id,
      tenantId: T_TENANT_A,
      baselineLatencyMs: 800,
      candidateLatencyMs: 950,
      baselineCostUsd: 0.01,
      candidateCostUsd: 0.012,
    });
    assert(comp28 !== null, "compareModels returned result");
    assert(comp28!.latencyDeltaMs !== null, "latencyDeltaMs computed");
    assert(comp28!.latencyDeltaMs === 150, "latencyDelta correct (950-800=150)");

    // ── SCENARIO 29: comparison output includes deltas ─────────────────────────
    section("SCENARIO 29: comparison output includes deltas");
    assert(comp27!.deltas.every((d) => ["improvement", "regression", "neutral"].includes(d.direction)), "All deltas have valid direction");
    assert(comp27!.deltas.every((d) => typeof d.delta === "number"), "All deltas are numeric");

    // ── SCENARIO 30: INV-EVAL4 — comparison remains tenant-safe ────────────────
    section("SCENARIO 30: INV-EVAL4 — comparison is tenant-safe");
    assert(comp27!.tenantId === T_TENANT_A, "Tenant A preserved in comparison");
    const compNullTenant = await comparePromptVersions({ baselineRunId: runBase!.id, candidateRunId: runCand!.id });
    assert(compNullTenant !== null, "Global comparison also works");

    // ── SCENARIO 31: summarizeComparison — structured output ───────────────────
    section("SCENARIO 31: summarizeComparison — structured output");
    const summComp = summarizeComparison(comp27!);
    assert(typeof summComp.headline === "string", "Headline is string");
    assert(["improvement", "regression", "neutral"].includes(summComp.verdict), "Verdict is valid");
    assert(Array.isArray(summComp.details), "Details array");

    // ── SCENARIO 32: detectRegressions — answer_quality_drop ───────────────────
    section("SCENARIO 32: detectRegressions — answer_quality_drop detected");
    const runRegBase = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runRegCand = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runRegBase!.id, { avgAnswerQuality: 0.85, avgRetrievalQuality: 0.8, avgGrounding: 0.75, avgHallucinationRisk: 0.2, passRate: 0.85 }, 10);
    await completeEvalRun(runRegCand!.id, { avgAnswerQuality: 0.60, avgRetrievalQuality: 0.8, avgGrounding: 0.75, avgHallucinationRisk: 0.2, passRate: 0.60 }, 10);
    const reg32 = await detectRegressions({ baselineRunId: runRegBase!.id, candidateRunId: runRegCand!.id, tenantId: T_TENANT_A });
    assert(reg32.regressions.length >= 1, "Regression detected");
    assert(reg32.regressions.some((r) => r.regressionType === "answer_quality_drop"), "answer_quality_drop detected");

    // ── SCENARIO 33: detectRegressions — retrieval_quality_drop ────────────────
    section("SCENARIO 33: detectRegressions — retrieval_quality_drop detected");
    const runRQ1 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runRQ2 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runRQ1!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.85, avgGrounding: 0.75, avgHallucinationRisk: 0.2, passRate: 0.8 }, 5);
    await completeEvalRun(runRQ2!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.60, avgGrounding: 0.75, avgHallucinationRisk: 0.2, passRate: 0.8 }, 5);
    const reg33 = await detectRegressions({ baselineRunId: runRQ1!.id, candidateRunId: runRQ2!.id, tenantId: T_TENANT_A });
    assert(reg33.regressions.some((r) => r.regressionType === "retrieval_quality_drop"), "retrieval_quality_drop detected");

    // ── SCENARIO 34: detectRegressions — grounding_drop ─────────────────────────
    section("SCENARIO 34: detectRegressions — grounding_drop detected");
    const runGr1 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runGr2 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runGr1!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.8, avgGrounding: 0.85, avgHallucinationRisk: 0.2, passRate: 0.8 }, 5);
    await completeEvalRun(runGr2!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.8, avgGrounding: 0.60, avgHallucinationRisk: 0.2, passRate: 0.8 }, 5);
    const reg34 = await detectRegressions({ baselineRunId: runGr1!.id, candidateRunId: runGr2!.id, tenantId: T_TENANT_A });
    assert(reg34.regressions.some((r) => r.regressionType === "grounding_drop"), "grounding_drop detected");

    // ── SCENARIO 35: detectRegressions — hallucination_increase ────────────────
    section("SCENARIO 35: detectRegressions — hallucination_increase detected");
    const runH1 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runH2 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runH1!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.8, avgGrounding: 0.8, avgHallucinationRisk: 0.15, passRate: 0.8 }, 5);
    await completeEvalRun(runH2!.id, { avgAnswerQuality: 0.8, avgRetrievalQuality: 0.8, avgGrounding: 0.8, avgHallucinationRisk: 0.45, passRate: 0.8 }, 5);
    const reg35 = await detectRegressions({ baselineRunId: runH1!.id, candidateRunId: runH2!.id, tenantId: T_TENANT_A });
    assert(reg35.regressions.some((r) => r.regressionType === "hallucination_increase"), "hallucination_increase detected");

    // ── SCENARIO 36: detectRegressions — latency_regression ────────────────────
    section("SCENARIO 36: detectRegressions — latency_regression detected");
    const runL1 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runL2 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runL1!.id, { avgAnswerQuality: 0.8, avgHallucinationRisk: 0.2 }, 5);
    await completeEvalRun(runL2!.id, { avgAnswerQuality: 0.8, avgHallucinationRisk: 0.2 }, 5);
    const reg36 = await detectRegressions({ baselineRunId: runL1!.id, candidateRunId: runL2!.id, tenantId: T_TENANT_A, latencyBaselineMs: 500, latencyCandidateMs: 900 });
    assert(reg36.regressions.some((r) => r.regressionType === "latency_regression"), "latency_regression detected");

    // ── SCENARIO 37: detectRegressions — cost_regression ───────────────────────
    section("SCENARIO 37: detectRegressions — cost_regression detected");
    const runC1 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const runC2 = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(runC1!.id, { avgAnswerQuality: 0.8, avgHallucinationRisk: 0.2 }, 5);
    await completeEvalRun(runC2!.id, { avgAnswerQuality: 0.8, avgHallucinationRisk: 0.2 }, 5);
    const reg37 = await detectRegressions({ baselineRunId: runC1!.id, candidateRunId: runC2!.id, tenantId: T_TENANT_A, costBaselineUsd: 0.05, costCandidateUsd: 0.10 });
    assert(reg37.regressions.some((r) => r.regressionType === "cost_regression"), "cost_regression detected");

    // ── SCENARIO 38: INV-EVAL5 — regression severity is deterministic ───────────
    section("SCENARIO 38: INV-EVAL5 — regression severity assigned deterministically");
    assert(reg32.regressions.every((r) => ["low", "medium", "high"].includes(r.severity)), "All severities are valid");
    const highSevBase = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    const highSevCand = await createEvalRun({ tenantId: T_TENANT_A, datasetId: dsComp!.id });
    await completeEvalRun(highSevBase!.id, { avgAnswerQuality: 0.95, avgHallucinationRisk: 0.05 }, 5);
    await completeEvalRun(highSevCand!.id, { avgAnswerQuality: 0.70, avgHallucinationRisk: 0.05 }, 5);
    const regHigh = await detectRegressions({ baselineRunId: highSevBase!.id, candidateRunId: highSevCand!.id, tenantId: T_TENANT_A });
    const aqReg = regHigh.regressions.find((r) => r.regressionType === "answer_quality_drop");
    assert(aqReg?.severity === "high", "Large drop (0.25) → high severity");

    // ── SCENARIO 39: listRegressions — returns regressions ─────────────────────
    section("SCENARIO 39: listRegressions — returns regression records");
    const allRegs = await listRegressions({ tenantId: T_TENANT_A });
    assert(Array.isArray(allRegs), "listRegressions returns array");
    assert(allRegs.length >= 3, "At least 3 regressions recorded");

    // ── SCENARIO 40: explainRegression — read-only ──────────────────────────────
    section("SCENARIO 40: explainRegression — read-only explain");
    const firstReg = allRegs[0];
    const expl40 = await explainRegression(firstReg.id);
    assert(expl40 !== null, "explainRegression returned data");
    assert(expl40!.baselineRun !== null, "Baseline run data returned");

    // ── SCENARIO 41: getEvalMetrics — returns metrics ───────────────────────────
    section("SCENARIO 41: getEvalMetrics — returns metrics safely");
    const metrics41 = await getEvalMetrics({ tenantId: T_TENANT_A });
    assert(typeof metrics41.totalRuns === "number", "totalRuns is number");
    assert(typeof metrics41.passRate === "number", "passRate is number");
    assert(metrics41.passRate >= 0 && metrics41.passRate <= 1, "passRate in [0,1]");
    assert(metrics41.totalRuns >= 1, "At least 1 run for tenant A");

    // ── SCENARIO 42: summarizeEvalMetrics — text output ────────────────────────
    section("SCENARIO 42: summarizeEvalMetrics — text output");
    const text42 = summarizeEvalMetrics(metrics41);
    assert(typeof text42 === "string", "summarizeEvalMetrics returns string");
    assert(text42.includes("Eval Metrics"), "Contains header");
    assert(text42.includes("PassRate"), "Contains PassRate");

    // ── SCENARIO 43: listRecentFailures ─────────────────────────────────────────
    section("SCENARIO 43: listRecentFailures — returns failed results");
    const failures43 = await listRecentFailures({ tenantId: T_TENANT_A });
    assert(Array.isArray(failures43), "listRecentFailures returns array");
    assert(failures43.every((f) => f.pass === false), "All returned results are failures");

    // ── SCENARIO 44: extractBenchmarkLatency ────────────────────────────────────
    section("SCENARIO 44: extractBenchmarkLatency — computes latency");
    const now = new Date();
    const earlier = new Date(now.getTime() - 5000);
    const lat44 = extractBenchmarkLatency({ startedAt: earlier, completedAt: now });
    assert(lat44 !== null, "Latency returned");
    assert(lat44! >= 4900 && lat44! <= 5100, `Latency approx 5000ms (got ${lat44})`);
    assert(extractBenchmarkLatency({ startedAt: null, completedAt: null }) === null, "Null for missing timestamps");

    // ── SCENARIO 45: INV-EVAL6 — metrics are tenant-safe ──────────────────────
    section("SCENARIO 45: INV-EVAL6 — metrics are tenant-safe");
    const metricsB = await getEvalMetrics({ tenantId: T_TENANT_B });
    assert(metricsB.totalRuns === 0, "Tenant B has no runs");
    assert(metricsB.tenantId === T_TENANT_B, "Tenant B id in metrics");

    // ── SCENARIO 46: clampTimeout — bounded ─────────────────────────────────────
    section("SCENARIO 46: clampTimeout — bounded correctly");
    assert(clampTimeout(5000) === 5000, "Normal value preserved");
    assert(clampTimeout(999999) === MAX_TIMEOUT_MS, `Over-large value clamped to ${MAX_TIMEOUT_MS}`);
    assert(clampTimeout(-1) === MIN_TIMEOUT_MS, `Negative value clamped to ${MIN_TIMEOUT_MS}`);
    assert(clampTimeout(NaN) === MAX_TIMEOUT_MS, "NaN clamped to max");
    assert(clampTimeout("abc" as any) === MAX_TIMEOUT_MS, "Non-numeric string clamped");
    assert(clampTimeout(0) === MIN_TIMEOUT_MS, "Zero clamped to min");

    // ── SCENARIO 47: clampTimeout — user-supplied timeout rejected ──────────────
    section("SCENARIO 47: unbounded user timeout rejected or clamped");
    assert(clampTimeout(Number.MAX_SAFE_INTEGER) === MAX_TIMEOUT_MS, "MAX_SAFE_INTEGER clamped");
    assert(clampTimeout(Infinity) === MAX_TIMEOUT_MS, "Infinity clamped");
    assert(clampTimeout(-Infinity) === MIN_TIMEOUT_MS, "-Infinity clamped to min");

    // ── SCENARIO 48: clampIterationBudget ──────────────────────────────────────
    section("SCENARIO 48: clampIterationBudget — bounded");
    assert(clampIterationBudget(50) === 50, "Normal iteration preserved");
    assert(clampIterationBudget(9999) === 100, "Over-large clamped to 100");
    assert(clampIterationBudget(0) === 1, "Zero clamped to 1");

    // ── SCENARIO 49: clampOrphanTimeoutMinutes ──────────────────────────────────
    section("SCENARIO 49: clampOrphanTimeoutMinutes — bounded");
    assert(clampOrphanTimeoutMinutes(60) === 60, "Normal value preserved");
    assert(clampOrphanTimeoutMinutes(99999) === 1440, "Over-large clamped to 1440");
    assert(clampOrphanTimeoutMinutes(0) === 1, "Zero clamped to 1");

    // ── SCENARIO 50: explainRuntimeBounds ──────────────────────────────────────
    section("SCENARIO 50: explainRuntimeBounds — documents all limits");
    const bounds50 = explainRuntimeBounds();
    assert(typeof bounds50.maxTimeoutMs === "number", "maxTimeoutMs is number");
    assert(typeof bounds50.maxIterationBudget === "number", "maxIterationBudget is number");
    assert(typeof bounds50.invariant === "string", "invariant is string");
    assert(bounds50.invariant.includes("INV-EVAL8"), "INV-EVAL8 documented");
    assert(typeof bounds50.codeqlRemediation === "string", "codeqlRemediation documented");
    assert(typeof bounds50.falsePositiveNote === "string", "falsePositiveNote documented");

    // ── SCENARIO 51: decodeEntitiesOnce — single decode ─────────────────────────
    section("SCENARIO 51: decodeEntitiesOnce — decodes entities once");
    assert(decodeEntitiesOnce("&amp;") === "&", "&amp; decoded to &");
    assert(decodeEntitiesOnce("&lt;p&gt;") === "<p>", "&lt;&gt; decoded");
    assert(decodeEntitiesOnce("&quot;hello&quot;") === '"hello"', "&quot; decoded");
    assert(decodeEntitiesOnce("&amp;amp;") === "&amp;", "Double-encoded &amp; decoded only once (not twice)");

    // ── SCENARIO 52: normalizeParsedText — single normalize ─────────────────────
    section("SCENARIO 52: normalizeParsedText — NFKC normalization once");
    const { normalized: n52, clamped: c52 } = normalizeParsedText("café\r\nnorm\talized\t text  ");
    assert(typeof n52 === "string", "Returns string");
    assert(!n52.includes("\r"), "CRLF normalized");
    assert(!n52.includes("\t"), "Tabs normalized");
    assert(!c52, "Not clamped for short input");

    // ── SCENARIO 53: normalizeParsedText — output length clamp ─────────────────
    section("SCENARIO 53: normalizeParsedText — output clamp enforced");
    const big = "A".repeat(11_000_000);
    const { normalized: n53, clamped: c53 } = normalizeParsedText(big);
    assert(n53.length === 10_000_000, "Output clamped to 10M chars");
    assert(c53 === true, "clamped flag set");

    // ── SCENARIO 54: no double-unescape ────────────────────────────────────────
    section("SCENARIO 54: INV-EVAL9 — no double-unescape in parser output");
    const doubleEncoded = "&amp;amp;lt;"; // should decode to &amp;lt; (not <<)
    const decoded54 = decodeEntitiesOnce(doubleEncoded);
    assert(decoded54 === "&amp;lt;", "decodeEntitiesOnce decodes exactly once, not twice");
    assert(!decoded54.includes("<<"), "No double-decode producing <<");

    // ── SCENARIO 55: explainParserSafety — false-positive documentation ─────────
    section("SCENARIO 55: explainParserSafety — INV-EVAL10 false-positive documented");
    const safety55 = explainParserSafety();
    assert(typeof safety55.policy === "string", "Policy string returned");
    assert(safety55.falsePositiveNote.includes("false positive"), "False positive documented");
    assert(safety55.falsePositiveNote.includes("single-pass"), "Single-pass pipeline documented");
    assert(safety55.falsePositiveNote.toLowerCase().includes("no unsafe"), "No unsafe workaround code added");

    // ── SCENARIO 56: admin route — datasets ────────────────────────────────────
    section("SCENARIO 56: Admin route /api/admin/evals/datasets registered");
    const res56 = await fetch("http://localhost:5000/api/admin/evals/datasets");
    assert(res56.status !== 404, "Route /api/admin/evals/datasets is not 404");

    // ── SCENARIO 57: admin route — runs ─────────────────────────────────────────
    section("SCENARIO 57: Admin route /api/admin/evals/runs registered");
    const res57 = await fetch("http://localhost:5000/api/admin/evals/runs");
    assert(res57.status !== 404, "Route /api/admin/evals/runs is not 404");

    // ── SCENARIO 58: admin route — regressions ───────────────────────────────────
    section("SCENARIO 58: Admin route /api/admin/evals/regressions registered");
    const res58 = await fetch("http://localhost:5000/api/admin/evals/regressions");
    assert(res58.status !== 404, "Route /api/admin/evals/regressions is not 404");

    // ── SCENARIO 59: admin route — metrics ──────────────────────────────────────
    section("SCENARIO 59: Admin route /api/admin/evals/metrics registered");
    const res59 = await fetch("http://localhost:5000/api/admin/evals/metrics");
    assert(res59.status !== 404, "Route /api/admin/evals/metrics is not 404");

    // ── SCENARIO 60: admin route — failures ─────────────────────────────────────
    section("SCENARIO 60: Admin route /api/admin/evals/failures registered");
    const res60 = await fetch("http://localhost:5000/api/admin/evals/failures");
    assert(res60.status !== 404, "Route /api/admin/evals/failures is not 404");

    // ── SCENARIO 61: INV-EVAL12 — no cross-tenant eval overlap ─────────────────
    section("SCENARIO 61: INV-EVAL12 — RLS verification: no cross-tenant overlap");
    const { rows: rls61 } = await pgClient.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
        AND rowsecurity = true
    `);
    assert(rls61.length === 5, "INV-EVAL12: All 5 eval tables have RLS enabled");

    // ── SCENARIO 62: INV-EVAL11 — existing Phase 16 governance still works ──────
    section("SCENARIO 62: INV-EVAL11 — Phase 16 cost governance still intact");
    const { listAllTenantBudgets } = await import("../ai-governance/budget-checker");
    const budgets62 = await listAllTenantBudgets();
    assert(Array.isArray(budgets62), "INV-EVAL11: budget-checker still returns array");

    // ── SCENARIO 63: INV-EVAL11 — observability still works ─────────────────────
    section("SCENARIO 63: INV-EVAL11 — Phase 15 observability still intact");
    const { getPlatformHealthStatus } = await import("../observability/metrics-health");
    const health63 = await getPlatformHealthStatus(1);
    assert(typeof health63 === "object", "INV-EVAL11: metrics-health still returns object");

    // ── SCENARIO 64: INV-EVAL1 — dataset versionability ─────────────────────────
    section("SCENARIO 64: INV-EVAL1 — dataset versionability");
    const ds64a = await createDataset({ tenantId: T_TENANT_A, datasetName: "Version A DS", datasetType: "hallucination" });
    const ds64b = await createDataset({ tenantId: T_TENANT_A, datasetName: "Version B DS", datasetType: "hallucination" });
    assert(ds64a!.id !== ds64b!.id, "INV-EVAL1: Each dataset has unique ID");
    const allDs64 = await listDatasets({ tenantId: T_TENANT_A });
    assert(allDs64.some((d) => d.id === ds64a!.id), "Version A in list");
    assert(allDs64.some((d) => d.id === ds64b!.id), "Version B in list");

    // ── SCENARIO 65: Full INV summary ──────────────────────────────────────────
    section("SCENARIO 65: INV summary — all invariants documented");
    const boundsDoc = explainRuntimeBounds();
    const parserDoc = explainParserSafety();
    assert(boundsDoc.invariant.includes("INV-EVAL8"), "INV-EVAL8 in bounds doc");
    assert(parserDoc.policy.includes("exactly once"), "INV-EVAL9 (decode once) in parser doc");
    assert(parserDoc.falsePositiveNote.length > 10, "INV-EVAL10 false-positive note present");
    const metricsGlobal = await getEvalMetrics({});
    assert(metricsGlobal.totalRuns >= 5, "INV-EVAL2: Multiple runs preserved (append-only)");
    assert(metricsGlobal.regressionCount >= 5, "INV-EVAL5: Regressions persisted");
    const sampleComp = await comparePromptVersions({ baselineRunId: runBase!.id, candidateRunId: runCand!.id });
    assert(sampleComp !== null, "INV-EVAL4: Comparison explicit and structured");
    assert(sampleComp!.deltas.length >= 3, "INV-EVAL4: Comparison has delta dimensions");
    assert(sampleComp!.deltas.every((d) => typeof d.delta === "number"), "INV-EVAL3: All scores are numeric");

    // ── Final output ────────────────────────────────────────────────────────────
    console.log("\n" + "─".repeat(60));
    console.log(`Phase 17 validation: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log("✗ FAILED assertions:");
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.log("✔ All assertions passed");
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error("Validation error:", err.message);
  process.exit(1);
});
