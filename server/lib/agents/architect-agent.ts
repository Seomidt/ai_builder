import type { AgentContract, RunContext, AgentOutput } from "./types";

/**
 * Architect Agent
 *
 * Responsibility: Produce a technical architecture specification.
 * Output artifact types: "arch_spec", "file_tree"
 *
 * Input: plan + ux_spec artifacts
 * Output: Architecture spec (stack, components, data model) + proposed file tree
 *
 * V1: Derives architecture from plan and UX spec deterministically.
 * V2: Replace with LLM-backed architect with real code generation.
 */
export const architectAgent: AgentContract = {
  agentKey: "architect_agent",
  title: "Architect Agent",
  description: "Produces technical architecture spec, component graph, and proposed file structure.",
  outputArtifactTypes: ["arch_spec", "file_tree"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const planArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "plan");
    const uxArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "ux_spec");

    let plan: { goal?: string; phases?: { tasks: { title: string; type: string }[] }[]; estimatedComplexity?: string } = { phases: [] };
    let uxSpec: { screens?: { name: string; route: string; components: string[] }[] } = { screens: [] };

    if (planArtifact?.content) {
      try { plan = JSON.parse(planArtifact.content); } catch { /* fallback */ }
    }
    if (uxArtifact?.content) {
      try { uxSpec = JSON.parse(uxArtifact.content); } catch { /* fallback */ }
    }

    const goal = plan.goal || ctx.goal || "Build feature";
    const screens = uxSpec.screens ?? [];
    const allTasks = (plan.phases ?? []).flatMap((p) => p.tasks);

    const components = [
      ...screens.map((s) => ({
        name: s.name.replace(/\s+/g, ""),
        type: "page" as const,
        route: s.route,
        dependencies: s.components,
      })),
      { name: "AppShell", type: "layout" as const, route: null, dependencies: [] },
      { name: "ApiClient", type: "service" as const, route: null, dependencies: [] },
      { name: "Store", type: "store" as const, route: null, dependencies: [] },
    ];

    const stack = {
      frontend: "React + TypeScript + TanStack Query",
      backend: "Express.js + Drizzle ORM",
      database: "PostgreSQL (Supabase)",
      auth: "Supabase Auth",
      deployment: "Vercel (Phase 2+)",
    };

    const archSpec = {
      goal,
      stack,
      components,
      dataModel: allTasks
        .filter((t) => t.type === "analysis")
        .map((t, i) => ({
          entity: `Entity${i + 1}`,
          description: t.title,
          fields: ["id", "created_at", "updated_at"],
        })),
      apiEndpoints: screens.map((s) => ({
        path: `/api${s.route}`,
        method: "GET",
        description: `Fetch data for ${s.name}`,
      })),
      complexity: plan.estimatedComplexity || "medium",
      generatedAt: new Date().toISOString(),
      agentVersion: "v1.0",
      note: "V1 deterministic arch spec — replace with LLM-backed architect in Phase 3",
    };

    const fileTree = {
      root: "src/",
      structure: {
        "src/": {
          "components/": screens.reduce((acc, s) => {
            acc[`${s.name.replace(/\s+/g, "")}.tsx`] = `// ${s.name} component`;
            return acc;
          }, {} as Record<string, string>),
          "pages/": screens.reduce((acc, s) => {
            const name = s.route.replace("/", "") || "index";
            acc[`${name}.tsx`] = `// ${s.name} page`;
            return acc;
          }, {} as Record<string, string>),
          "lib/": { "api.ts": "// API client", "types.ts": "// Shared types" },
          "App.tsx": "// Root component",
        },
        "server/": {
          "routes/": archSpec.apiEndpoints.reduce((acc, ep) => {
            const name = ep.path.replace("/api/", "").replace("/", "-") || "index";
            acc[`${name}.ts`] = `// ${ep.description}`;
            return acc;
          }, {} as Record<string, string>),
        },
      },
      totalFiles: components.length + 3,
      generatedAt: new Date().toISOString(),
    };

    return {
      artifacts: [
        {
          artifactType: "arch_spec",
          title: `Architecture Spec: ${goal.slice(0, 60)}`,
          description: `Technical architecture with ${components.length} components and ${archSpec.apiEndpoints.length} API endpoints`,
          content: JSON.stringify(archSpec, null, 2),
          path: "architecture/arch-spec.json",
          version: "v1",
          tags: ["architecture", "spec"],
          metadata: { componentCount: components.length, endpointCount: archSpec.apiEndpoints.length },
        },
        {
          artifactType: "file_tree",
          title: `File Tree: ${goal.slice(0, 60)}`,
          description: `Proposed file structure with ${fileTree.totalFiles} files`,
          content: JSON.stringify(fileTree, null, 2),
          path: "architecture/file-tree.json",
          version: "v1",
          tags: ["file-tree", "structure"],
          metadata: { totalFiles: fileTree.totalFiles },
        },
      ],
      summary: {
        goal,
        components: components.length,
        endpoints: archSpec.apiEndpoints.length,
        stack,
      },
    };
  },
};
