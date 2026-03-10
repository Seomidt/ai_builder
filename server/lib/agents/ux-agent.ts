import type { AgentContract, RunContext, AgentOutput } from "./types";

/**
 * UX Agent
 *
 * Responsibility: Translate the plan into a UX specification.
 * Output artifact type: "ux_spec"
 *
 * Input: plan artifact from planner_agent
 * Output: JSON UX spec with screens, components, user flows
 *
 * V1: Derives screens from plan phases deterministically.
 * V2: Replace with LLM call using OpenAI function-calling.
 */
export const uxAgent: AgentContract = {
  agentKey: "ux_agent",
  title: "UX Agent",
  description: "Translates the execution plan into a UX specification with screens, components, and user flows.",
  outputArtifactTypes: ["ux_spec"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const planArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "plan");
    let plan: { goal?: string; phases?: { name: string; tasks: { title: string }[] }[]; tags?: string[] } = {
      goal: ctx.goal,
      phases: [],
    };

    if (planArtifact?.content) {
      try { plan = JSON.parse(planArtifact.content); } catch { /* use fallback */ }
    }

    const goal = plan.goal || ctx.goal || "Build feature";
    const phases = plan.phases ?? [];

    // Derive screens from plan phases
    const screens = [
      {
        id: "screen-main",
        name: "Main View",
        route: "/",
        purpose: `Primary interface for: ${goal.slice(0, 80)}`,
        components: ["Header", "ContentArea", "ActionBar"],
        userFlow: "entry",
      },
      ...phases.map((phase, i) => ({
        id: `screen-${i + 1}`,
        name: `${phase.name} Screen`,
        route: `/${phase.name.toLowerCase().replace(/\s+/g, "-")}`,
        purpose: `Handles: ${phase.tasks.map((t) => t.title).join(", ").slice(0, 100)}`,
        components: ["Breadcrumb", "Form", "ActionButtons"],
        userFlow: `phase-${i + 1}`,
      })),
    ];

    const uxSpec = {
      goal,
      screens,
      designTokens: {
        colorScheme: "dark",
        primaryColor: "#0ea5e9",
        fontScale: "base",
      },
      accessibility: ["keyboard-navigation", "aria-labels", "color-contrast"],
      responsiveBreakpoints: ["mobile", "tablet", "desktop"],
      generatedAt: new Date().toISOString(),
      agentVersion: "v1.0",
      note: "V1 deterministic UX spec — replace with LLM-backed UX agent in Phase 3",
    };

    return {
      artifacts: [
        {
          artifactType: "ux_spec",
          title: `UX Spec: ${goal.slice(0, 60)}`,
          description: `UX specification with ${screens.length} screens and component definitions`,
          content: JSON.stringify(uxSpec, null, 2),
          path: "design/ux-spec.json",
          version: "v1",
          tags: ["ux", "design", ...(plan.tags ?? [])],
          metadata: { screenCount: screens.length },
        },
      ],
      summary: {
        goal,
        screens: screens.length,
        screenNames: screens.map((s) => s.name),
      },
    };
  },
};
