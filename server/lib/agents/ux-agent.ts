import type { AgentContract, RunContext, AgentOutput } from "./types";
import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { getModelForAgent } from "./model-config";

/**
 * UX Agent
 *
 * Responsibility: Translate the plan into a UX specification.
 * Output artifact type: "ux_spec"
 *
 * V1: Deterministic structural generation.
 * V2 (current): LLM-backed via OpenAI with deterministic fallback.
 */

interface UxSpecOutput {
  goal: string;
  screens: Array<{
    id: string;
    name: string;
    route: string;
    purpose: string;
    components: string[];
    userFlow: string;
    interactions?: string[];
  }>;
  designTokens: {
    colorScheme: string;
    primaryColor: string;
    fontScale: string;
    spacing?: string;
  };
  accessibility: string[];
  responsiveBreakpoints: string[];
  userJourney?: string[];
  agentVersion: string;
}

const SYSTEM_PROMPT = `You are a senior UX designer AI. Given a software goal and execution plan, produce a detailed UX specification.

Output ONLY valid JSON matching this exact structure:
{
  "screens": [
    {
      "id": "screen-<slug>",
      "name": "<Screen Name>",
      "route": "/<route>",
      "purpose": "<what this screen does>",
      "components": ["<ComponentName>", ...],
      "userFlow": "<entry|<phase-name>>",
      "interactions": ["<interaction 1>", ...]
    }
  ],
  "designTokens": {
    "colorScheme": "dark|light",
    "primaryColor": "<hex>",
    "fontScale": "sm|base|lg",
    "spacing": "tight|comfortable|spacious"
  },
  "accessibility": ["<requirement 1>", ...],
  "responsiveBreakpoints": ["mobile", "tablet", "desktop"],
  "userJourney": ["<step 1>", "<step 2>", ...]
}

Rules:
- Produce 3-6 screens that cover the full user journey
- components must be realistic React component names (PascalCase)
- userJourney must describe the end-to-end flow in 4-6 steps
- accessibility must list at least 3 WCAG considerations
- Return ONLY the JSON object, no markdown, no extra text`;

export const uxAgent: AgentContract = {
  agentKey: "ux_agent",
  title: "UX Agent",
  description: "Translates the execution plan into a UX specification with screens, components, and user flows.",
  outputArtifactTypes: ["ux_spec"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const goal = ctx.goal || "Build a software feature";
    const tags = ctx.tags ?? [];

    const planArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "plan");
    let planSummary = "";
    if (planArtifact?.content) {
      try {
        const plan = JSON.parse(planArtifact.content);
        const tasks = (plan.phases ?? []).flatMap((p: { tasks: { title: string }[] }) => p.tasks.map((t: { title: string }) => t.title));
        planSummary = `Plan phases: ${(plan.phases ?? []).map((p: { name: string }) => p.name).join(", ")}\nKey tasks: ${tasks.slice(0, 6).join(", ")}`;
      } catch { /* ignore */ }
    }

    let uxSpec: UxSpecOutput;

    if (isOpenAIAvailable()) {
      try {
        const model = getModelForAgent("ux_agent", ctx.agentModelOverrides?.["ux_agent"]);
        const userPrompt = [
          `Goal: ${goal}`,
          `Tags: ${tags.join(", ") || "none"}`,
          planSummary ? `\n${planSummary}` : "",
        ].filter(Boolean).join("\n");

        const raw = await chatJSON<Partial<UxSpecOutput>>(SYSTEM_PROMPT, userPrompt, model, { agentKey: "ux_agent" });

        uxSpec = {
          goal,
          screens: raw.screens ?? [],
          designTokens: raw.designTokens ?? { colorScheme: "dark", primaryColor: "#0ea5e9", fontScale: "base" },
          accessibility: raw.accessibility ?? ["keyboard-navigation", "aria-labels", "color-contrast"],
          responsiveBreakpoints: raw.responsiveBreakpoints ?? ["mobile", "tablet", "desktop"],
          userJourney: raw.userJourney,
          agentVersion: "v2-openai",
        };
      } catch (err) {
        console.warn("[ux_agent] OpenAI call failed, using fallback:", (err as Error).message);
        uxSpec = buildDeterministicUxSpec(goal, tags, planArtifact?.content);
      }
    } else {
      uxSpec = buildDeterministicUxSpec(goal, tags, planArtifact?.content);
    }

    uxSpec.goal = goal;

    return {
      artifacts: [
        {
          artifactType: "ux_spec",
          title: `UX Spec: ${goal.slice(0, 60)}`,
          description: `UX specification with ${uxSpec.screens.length} screens and component definitions`,
          content: JSON.stringify(uxSpec, null, 2),
          path: "design/ux-spec.json",
          version: "v1",
          tags: ["ux", "design", ...tags],
          metadata: { screenCount: uxSpec.screens.length, agentVersion: uxSpec.agentVersion },
        },
      ],
      summary: {
        goal,
        screens: uxSpec.screens.length,
        screenNames: uxSpec.screens.map((s) => s.name),
        llmBacked: uxSpec.agentVersion === "v2-openai",
      },
    };
  },
};

function buildDeterministicUxSpec(goal: string, tags: string[], planContent?: string | null): UxSpecOutput {
  let phases: { name: string; tasks: { title: string }[] }[] = [];
  if (planContent) {
    try { phases = JSON.parse(planContent).phases ?? []; } catch { /* ignore */ }
  }

  const screens = [
    { id: "screen-main", name: "Main View", route: "/", purpose: `Primary interface for: ${goal.slice(0, 80)}`, components: ["Header", "ContentArea", "ActionBar"], userFlow: "entry" },
    ...phases.map((phase, i) => ({
      id: `screen-${i + 1}`,
      name: `${phase.name} Screen`,
      route: `/${phase.name.toLowerCase().replace(/\s+/g, "-")}`,
      purpose: `Handles: ${phase.tasks.map((t) => t.title).join(", ").slice(0, 100)}`,
      components: ["Breadcrumb", "Form", "ActionButtons"],
      userFlow: `phase-${i + 1}`,
    })),
  ];

  return {
    goal,
    screens,
    designTokens: { colorScheme: "dark", primaryColor: "#0ea5e9", fontScale: "base" },
    accessibility: ["keyboard-navigation", "aria-labels", "color-contrast"],
    responsiveBreakpoints: ["mobile", "tablet", "desktop"],
    agentVersion: "v1-deterministic",
  };
}
