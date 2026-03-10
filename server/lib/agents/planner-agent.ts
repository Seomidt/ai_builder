import type { AgentContract, RunContext, AgentOutput } from "./types";

/**
 * Planner Agent
 *
 * Responsibility: Parse the run goal into a structured task plan.
 * Output artifact type: "plan"
 *
 * Input: goal text + tags
 * Output: JSON plan with phases, tasks, and expected outputs
 *
 * V1: Deterministic structural generation from goal text.
 * V2: Replace execute() body with OpenAI call using this same contract.
 */
export const plannerAgent: AgentContract = {
  agentKey: "planner_agent",
  title: "Planner Agent",
  description: "Decomposes the run goal into a structured task plan with phases and expected outputs.",
  outputArtifactTypes: ["plan"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const goal = ctx.goal || "Build a feature";
    const tags = ctx.tags ?? [];

    // Derive plan structure from goal text (deterministic V1)
    const taskLines = goal
      .replace(/\band\b/gi, ",")
      .split(/[,;.\n]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 3)
      .slice(0, 8);

    const phases = [
      {
        phase: 1,
        name: "Analysis",
        tasks: taskLines.slice(0, Math.ceil(taskLines.length / 3)).map((t, i) => ({
          id: `task-1-${i + 1}`,
          title: t,
          type: "analysis",
          expectedOutput: "spec",
        })),
      },
      {
        phase: 2,
        name: "Design",
        tasks: taskLines.slice(Math.ceil(taskLines.length / 3), Math.ceil((taskLines.length * 2) / 3)).map((t, i) => ({
          id: `task-2-${i + 1}`,
          title: t,
          type: "design",
          expectedOutput: "design_spec",
        })),
      },
      {
        phase: 3,
        name: "Implementation",
        tasks: taskLines.slice(Math.ceil((taskLines.length * 2) / 3)).map((t, i) => ({
          id: `task-3-${i + 1}`,
          title: t,
          type: "implementation",
          expectedOutput: "code",
        })),
      },
    ].filter((p) => p.tasks.length > 0);

    const plan = {
      goal,
      tags,
      phases,
      totalTasks: phases.reduce((sum, p) => sum + p.tasks.length, 0),
      estimatedComplexity: taskLines.length <= 3 ? "low" : taskLines.length <= 6 ? "medium" : "high",
      generatedAt: new Date().toISOString(),
      agentVersion: "v1.0",
      note: "V1 deterministic plan — replace with LLM-backed planner in Phase 3",
    };

    return {
      artifacts: [
        {
          artifactType: "plan",
          title: `Plan: ${goal.slice(0, 60)}`,
          description: `Structured execution plan with ${plan.totalTasks} tasks across ${phases.length} phases`,
          content: JSON.stringify(plan, null, 2),
          path: "plan/execution-plan.json",
          version: "v1",
          tags: ["plan", ...tags],
          metadata: { totalTasks: plan.totalTasks, complexity: plan.estimatedComplexity },
        },
      ],
      summary: {
        goal,
        phases: phases.length,
        totalTasks: plan.totalTasks,
        complexity: plan.estimatedComplexity,
      },
    };
  },
};
