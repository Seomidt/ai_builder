import type { AgentContract, RunContext, AgentOutput } from "./types";
import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { getModelForAgent } from "./model-config";

/**
 * Review Agent
 *
 * Responsibility: Review all artifacts from the run and produce a gate report.
 * Output artifact type: "review"
 *
 * V1: Deterministic completeness checks.
 * V2 (current): LLM-backed semantic review with deterministic fallback.
 */

interface ReviewCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface ReviewOutput {
  runId: string;
  goal: string;
  gateStatus: "approved" | "approved_with_warnings" | "rejected";
  score: number;
  checks: ReviewCheck[];
  summary: { passed: number; warned: number; failed: number; total: number };
  insights?: string[];
  recommendations?: string[];
  artifactsReviewed: Array<{ id: string; type: string; title: string; path: string | null }>;
  recommendation: string;
  agentVersion: string;
}

const SYSTEM_PROMPT = `You are a senior software quality reviewer AI. Review the provided artifacts from a software generation pipeline and produce a structured gate report.

Output ONLY valid JSON matching this exact structure:
{
  "checks": [
    {
      "id": "CHK-<number>",
      "title": "<check title>",
      "status": "pass|warn|fail",
      "detail": "<explanation>"
    }
  ],
  "insights": ["<insight 1>", "<insight 2>", ...],
  "recommendations": ["<recommendation 1>", ...],
  "overallAssessment": "<approved|approved_with_warnings|rejected>",
  "qualityScore": <0-100>
}

Rules:
- Always include 6-8 checks covering: completeness, consistency, coverage, quality, feasibility
- insights should highlight notable strengths or architectural decisions (2-4 items)
- recommendations should be actionable improvements for the next iteration (2-4 items)  
- overallAssessment: "approved" = all pass, "approved_with_warnings" = some warn, "rejected" = any fail
- qualityScore: percentage of passed checks weighted by severity
- Return ONLY the JSON object, no markdown, no extra text`;

export const reviewAgent: AgentContract = {
  agentKey: "review_agent",
  title: "Review Agent",
  description: "Reviews all generated artifacts and produces a gate report with pass/warn/fail checks, insights, and recommendations.",
  outputArtifactTypes: ["review"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const artifacts = ctx.previousArtifacts;
    const artifactTypes = artifacts.map((a) => a.artifactType);

    // Always run deterministic structural checks regardless of LLM availability
    const structuralChecks = buildStructuralChecks(ctx, artifactTypes);

    let review: ReviewOutput;

    if (isOpenAIAvailable() && artifacts.length > 0) {
      try {
        const model = getModelForAgent("review_agent", ctx.agentModelOverrides?.["review_agent"]);
        // Build a compact summary of artifact contents for the LLM to review
        const artifactSummaries = artifacts.map((a) => {
          let contentPreview = "";
          if (a.content) {
            try {
              const parsed = JSON.parse(a.content);
              contentPreview = JSON.stringify(parsed, null, 2).slice(0, 800);
            } catch {
              contentPreview = a.content.slice(0, 400);
            }
          }
          return `--- ${a.artifactType.toUpperCase()} (${a.path ?? "no path"}) ---\n${contentPreview}`;
        });

        const userPrompt = [
          `Goal: ${ctx.goal}`,
          `Pipeline version: ${ctx.pipelineVersion ?? "v2"}`,
          `Artifacts generated: ${artifactTypes.join(", ")}`,
          `\nArtifact contents:\n${artifactSummaries.join("\n\n")}`,
        ].join("\n");

        const raw = await chatJSON<{
          checks?: ReviewCheck[];
          insights?: string[];
          recommendations?: string[];
          overallAssessment?: string;
          qualityScore?: number;
        }>(SYSTEM_PROMPT, userPrompt, model, { agentKey: "review_agent" });

        const llmChecks: ReviewCheck[] = (raw.checks ?? []).map((c, i) => ({
          id: c.id ?? `CHK-LLM-${i + 1}`,
          title: c.title ?? `Check ${i + 1}`,
          status: (["pass", "warn", "fail"].includes(c.status) ? c.status : "warn") as ReviewCheck["status"],
          detail: c.detail ?? "",
        }));

        // Merge structural checks + LLM checks (structural take priority for completeness gates)
        const allChecks = [...structuralChecks, ...llmChecks];
        const passed = allChecks.filter((c) => c.status === "pass").length;
        const warned = allChecks.filter((c) => c.status === "warn").length;
        const failed = allChecks.filter((c) => c.status === "fail").length;

        const gateStatus: ReviewOutput["gateStatus"] =
          failed > 0 ? "rejected" : warned > 0 ? "approved_with_warnings" : "approved";

        const score = raw.qualityScore ?? Math.round((passed / allChecks.length) * 100);

        review = {
          runId: ctx.runId,
          goal: ctx.goal,
          gateStatus,
          score,
          checks: allChecks,
          summary: { passed, warned, failed, total: allChecks.length },
          insights: raw.insights,
          recommendations: raw.recommendations,
          artifactsReviewed: artifacts.map((a) => ({ id: a.id, type: a.artifactType, title: a.title ?? "", path: a.path ?? null })),
          recommendation: buildRecommendation(gateStatus, score),
          agentVersion: "v2-openai",
        };
      } catch (err) {
        console.warn("[review_agent] OpenAI call failed, using fallback:", (err as Error).message);
        review = buildDeterministicReview(ctx, artifacts, artifactTypes, structuralChecks);
      }
    } else {
      review = buildDeterministicReview(ctx, artifacts, artifactTypes, structuralChecks);
    }

    return {
      artifacts: [
        {
          artifactType: "review",
          title: `Review: ${review.gateStatus.replace(/_/g, " ")} (${review.score}/100)`,
          description: review.recommendation,
          content: JSON.stringify(review, null, 2),
          path: "review/gate-report.json",
          version: "v1",
          tags: ["review", review.gateStatus],
          metadata: { gateStatus: review.gateStatus, score: review.score, passed: review.summary.passed, warned: review.summary.warned, failed: review.summary.failed, agentVersion: review.agentVersion },
        },
      ],
      summary: {
        gateStatus: review.gateStatus,
        score: review.score,
        passed: review.summary.passed,
        warned: review.summary.warned,
        failed: review.summary.failed,
        llmBacked: review.agentVersion === "v2-openai",
      },
    };
  },
};

function buildStructuralChecks(ctx: RunContext, artifactTypes: string[]): ReviewCheck[] {
  return [
    {
      id: "CHK-001",
      title: "Plan artifact present",
      status: artifactTypes.includes("plan") ? "pass" : "fail",
      detail: artifactTypes.includes("plan") ? "Execution plan found" : "Missing plan artifact",
    },
    {
      id: "CHK-002",
      title: "UX spec present",
      status: artifactTypes.includes("ux_spec") ? "pass" : "warn",
      detail: artifactTypes.includes("ux_spec") ? "UX spec found" : "No UX spec generated",
    },
    {
      id: "CHK-003",
      title: "Architecture spec present",
      status: artifactTypes.includes("arch_spec") ? "pass" : "fail",
      detail: artifactTypes.includes("arch_spec") ? "Architecture spec found" : "Missing arch spec",
    },
    {
      id: "CHK-004",
      title: "File tree generated",
      status: artifactTypes.includes("file_tree") ? "pass" : "warn",
      detail: artifactTypes.includes("file_tree") ? "File tree found" : "No file tree generated",
    },
    {
      id: "CHK-005",
      title: "Goal specified",
      status: ctx.goal ? "pass" : "warn",
      detail: ctx.goal ? `Goal: "${ctx.goal.slice(0, 80)}"` : "No goal specified",
    },
  ];
}

function buildDeterministicReview(
  ctx: RunContext,
  artifacts: typeof ctx.previousArtifacts,
  artifactTypes: string[],
  structuralChecks: ReviewCheck[],
): ReviewOutput {
  const checks = [
    ...structuralChecks,
    {
      id: "CHK-006",
      title: "Artifact count",
      status: (artifacts.length >= 3 ? "pass" : artifacts.length >= 1 ? "warn" : "fail") as ReviewCheck["status"],
      detail: `${artifacts.length} artifact(s) generated across ${artifactTypes.length} types`,
    },
  ];

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  const gateStatus: ReviewOutput["gateStatus"] =
    failed > 0 ? "rejected" : warned > 0 ? "approved_with_warnings" : "approved";

  const score = Math.round((passed / checks.length) * 100);

  return {
    runId: ctx.runId,
    goal: ctx.goal,
    gateStatus,
    score,
    checks,
    summary: { passed, warned, failed, total: checks.length },
    artifactsReviewed: artifacts.map((a) => ({ id: a.id, type: a.artifactType, title: a.title ?? "", path: a.path ?? null })),
    recommendation: buildRecommendation(gateStatus, score),
    agentVersion: "v1-deterministic",
  };
}

function buildRecommendation(gateStatus: ReviewOutput["gateStatus"], score: number): string {
  if (gateStatus === "approved") return `All checks passed (${score}/100). Ready for GitHub commit when write pipeline is enabled.`;
  if (gateStatus === "approved_with_warnings") return `Minor issues detected (${score}/100). Review warnings before enabling GitHub write.`;
  return `Critical checks failed (${score}/100). Re-run pipeline before proceeding.`;
}
