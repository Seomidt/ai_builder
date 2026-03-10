import type { AgentContract, RunContext, AgentOutput } from "./types";
import { chatJSON, isOpenAIAvailable } from "../openai-client";

/**
 * Planner Agent
 *
 * Responsibility: Parse the run goal into a structured task plan.
 * Output artifact type: "plan"
 *
 * V1: Deterministic structural generation from goal text.
 * V2 (current): LLM-backed via OpenAI with deterministic fallback.
 */

interface PlanOutput {
  goal: string;
  tags: string[];
  phases: Array<{
    phase: number;
    name: string;
    tasks: Array<{
      id: string;
      title: string;
      type: string;
      expectedOutput: string;
      description?: string;
    }>;
  }>;
  totalTasks: number;
  estimatedComplexity: "low" | "medium" | "high";
  technicalConsiderations?: string[];
  successCriteria?: string[];
  agentVersion: string;
}

const SYSTEM_PROMPT = `You are a senior software project planner AI. Your job is to break down a software goal into a structured execution plan.

Output ONLY valid JSON matching this exact structure:
{
  "goal": "<the original goal>",
  "tags": ["<tag1>", "<tag2>"],
  "phases": [
    {
      "phase": 1,
      "name": "<phase name>",
      "tasks": [
        {
          "id": "task-1-1",
          "title": "<task title>",
          "type": "analysis|design|implementation|testing",
          "expectedOutput": "<what this task produces>",
          "description": "<brief description>"
        }
      ]
    }
  ],
  "totalTasks": <number>,
  "estimatedComplexity": "low|medium|high",
  "technicalConsiderations": ["<consideration 1>", "<consideration 2>"],
  "successCriteria": ["<criterion 1>", "<criterion 2>"]
}

Rules:
- Use exactly 3 phases: Analysis, Design, Implementation
- Each phase should have 2-4 tasks
- estimatedComplexity: "low" = < 5 tasks, "medium" = 5-10, "high" = > 10
- tasks.type must be one of: analysis, design, implementation, testing
- Return ONLY the JSON object, no markdown, no extra text`;

export const plannerAgent: AgentContract = {
  agentKey: "planner_agent",
  title: "Planner Agent",
  description: "Decomposes the run goal into a structured task plan with phases and expected outputs.",
  outputArtifactTypes: ["plan"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const goal = ctx.goal || "Build a software feature";
    const tags = ctx.tags ?? [];

    let plan: PlanOutput;

    if (isOpenAIAvailable()) {
      try {
        const userPrompt = `Goal: ${goal}\nTags: ${tags.join(", ") || "none"}\nArchitecture pipeline version: ${ctx.pipelineVersion ?? "v2"}`;
        const raw = await chatJSON<Partial<PlanOutput>>(SYSTEM_PROMPT, userPrompt);

        plan = {
          goal,
          tags,
          phases: raw.phases ?? [],
          totalTasks: raw.totalTasks ?? (raw.phases ?? []).reduce((s, p) => s + p.tasks.length, 0),
          estimatedComplexity: raw.estimatedComplexity ?? "medium",
          technicalConsiderations: raw.technicalConsiderations,
          successCriteria: raw.successCriteria,
          agentVersion: "v2-openai",
        };
      } catch (err) {
        console.warn("[planner_agent] OpenAI call failed, using fallback:", (err as Error).message);
        plan = buildDeterministicPlan(goal, tags);
      }
    } else {
      plan = buildDeterministicPlan(goal, tags);
    }

    plan.goal = goal;
    plan.tags = tags;

    return {
      artifacts: [
        {
          artifactType: "plan",
          title: `Plan: ${goal.slice(0, 60)}`,
          description: `Structured execution plan with ${plan.totalTasks} tasks across ${plan.phases.length} phases`,
          content: JSON.stringify(plan, null, 2),
          path: "plan/execution-plan.json",
          version: "v1",
          tags: ["plan", ...tags],
          metadata: { totalTasks: plan.totalTasks, complexity: plan.estimatedComplexity, agentVersion: plan.agentVersion },
        },
      ],
      summary: {
        goal,
        phases: plan.phases.length,
        totalTasks: plan.totalTasks,
        complexity: plan.estimatedComplexity,
        llmBacked: plan.agentVersion === "v2-openai",
      },
    };
  },
};

function buildDeterministicPlan(goal: string, tags: string[]): PlanOutput {
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
        description: `Analyse: ${t}`,
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
        description: `Design: ${t}`,
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
        description: `Implement: ${t}`,
      })),
    },
  ].filter((p) => p.tasks.length > 0);

  const totalTasks = phases.reduce((s, p) => s + p.tasks.length, 0);

  return {
    goal,
    tags,
    phases,
    totalTasks,
    estimatedComplexity: totalTasks <= 3 ? "low" : totalTasks <= 6 ? "medium" : "high",
    agentVersion: "v1-deterministic",
  };
}
