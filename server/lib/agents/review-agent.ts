import type { AgentContract, RunContext, AgentOutput } from "./types";

/**
 * Review Agent
 *
 * Responsibility: Review all artifacts from the run and produce a gate report.
 * Output artifact type: "review"
 *
 * Input: all previous artifacts (plan, ux_spec, arch_spec, file_tree)
 * Output: JSON review report with pass/warn/fail checks
 *
 * V1: Deterministic checks on artifact completeness and consistency.
 * V2: LLM-backed review with semantic analysis.
 */
export const reviewAgent: AgentContract = {
  agentKey: "review_agent",
  title: "Review Agent",
  description: "Reviews all generated artifacts and produces a gate report with pass/warn/fail checks.",
  outputArtifactTypes: ["review"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const artifacts = ctx.previousArtifacts;
    const artifactTypes = artifacts.map((a) => a.artifactType);

    const checks: { id: string; title: string; status: "pass" | "warn" | "fail"; detail: string }[] = [
      {
        id: "CHK-001",
        title: "Plan artifact present",
        status: artifactTypes.includes("plan") ? "pass" : "fail",
        detail: artifactTypes.includes("plan") ? "Execution plan found" : "Missing plan artifact — planner_agent may have failed",
      },
      {
        id: "CHK-002",
        title: "UX spec present",
        status: artifactTypes.includes("ux_spec") ? "pass" : "warn",
        detail: artifactTypes.includes("ux_spec") ? "UX spec found" : "No UX spec — pipeline may have skipped ux_agent",
      },
      {
        id: "CHK-003",
        title: "Architecture spec present",
        status: artifactTypes.includes("arch_spec") ? "pass" : "fail",
        detail: artifactTypes.includes("arch_spec") ? "Architecture spec found" : "Missing arch spec — architect_agent may have failed",
      },
      {
        id: "CHK-004",
        title: "File tree generated",
        status: artifactTypes.includes("file_tree") ? "pass" : "warn",
        detail: artifactTypes.includes("file_tree") ? "File tree found" : "No file tree — skipped or not configured",
      },
      {
        id: "CHK-005",
        title: "Goal provided",
        status: ctx.goal ? "pass" : "warn",
        detail: ctx.goal ? `Goal: "${ctx.goal.slice(0, 80)}"` : "No goal specified — artifacts may be generic",
      },
      {
        id: "CHK-006",
        title: "Artifact count",
        status: artifacts.length >= 3 ? "pass" : artifacts.length >= 1 ? "warn" : "fail",
        detail: `${artifacts.length} artifact(s) generated across ${artifactTypes.length} types`,
      },
    ];

    const passed = checks.filter((c) => c.status === "pass").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    const failed = checks.filter((c) => c.status === "fail").length;

    const gateStatus: "approved" | "approved_with_warnings" | "rejected" =
      failed > 0 ? "rejected" : warned > 0 ? "approved_with_warnings" : "approved";

    const review = {
      runId: ctx.runId,
      goal: ctx.goal,
      gateStatus,
      score: Math.round((passed / checks.length) * 100),
      checks,
      summary: {
        passed,
        warned,
        failed,
        total: checks.length,
      },
      artifactsReviewed: artifacts.map((a) => ({
        id: a.id,
        type: a.artifactType,
        title: a.title,
        path: a.path,
      })),
      recommendation: gateStatus === "approved"
        ? "All checks passed. Ready for GitHub commit when write pipeline is enabled."
        : gateStatus === "approved_with_warnings"
        ? "Minor issues detected. Review warnings before enabling GitHub write."
        : "Critical checks failed. Re-run pipeline before proceeding.",
      generatedAt: new Date().toISOString(),
      agentVersion: "v1.0",
      note: "V1 deterministic review — replace with LLM-backed review in Phase 3",
    };

    return {
      artifacts: [
        {
          artifactType: "review",
          title: `Review: ${gateStatus.replace(/_/g, " ")} (${review.score}/100)`,
          description: review.recommendation,
          content: JSON.stringify(review, null, 2),
          path: "review/gate-report.json",
          version: "v1",
          tags: ["review", gateStatus],
          metadata: { gateStatus, score: review.score, passed, warned, failed },
        },
      ],
      summary: {
        gateStatus,
        score: review.score,
        passed,
        warned,
        failed,
      },
    };
  },
};
