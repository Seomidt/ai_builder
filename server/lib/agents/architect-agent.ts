import type { AgentContract, RunContext, AgentOutput } from "./types";
import { chatJSON, isOpenAIAvailable } from "../openai-client";
import { getModelForAgent } from "./model-config";

/**
 * Architect Agent
 *
 * Responsibility: Produce a technical architecture specification + file tree.
 * Output artifact types: "arch_spec", "file_tree"
 *
 * V1: Deterministic structural generation.
 * V2 (current): LLM-backed via OpenAI with deterministic fallback.
 */

interface ArchSpecOutput {
  goal: string;
  stack: {
    frontend: string;
    backend: string;
    database: string;
    auth: string;
    deployment: string;
  };
  components: Array<{
    name: string;
    type: "page" | "layout" | "service" | "store" | "hook" | "component";
    route: string | null;
    dependencies: string[];
    description?: string;
  }>;
  dataModel: Array<{
    entity: string;
    description: string;
    fields: string[];
    relationships?: string[];
  }>;
  apiEndpoints: Array<{
    path: string;
    method: string;
    description: string;
    requestBody?: string;
    responseType?: string;
  }>;
  complexity: string;
  keyDecisions?: string[];
  agentVersion: string;
}

interface FileTreeOutput {
  root: string;
  structure: Record<string, unknown>;
  totalFiles: number;
  agentVersion: string;
}

const SYSTEM_PROMPT = `You are a senior software architect AI. Given a software goal, plan, and UX spec, produce a technical architecture specification.

Output ONLY valid JSON with this exact structure:
{
  "stack": {
    "frontend": "<framework + key libs>",
    "backend": "<framework + ORM>",
    "database": "<db + hosting>",
    "auth": "<auth provider/strategy>",
    "deployment": "<deployment target>"
  },
  "components": [
    {
      "name": "<ComponentName>",
      "type": "page|layout|service|store|hook|component",
      "route": "/<route> or null",
      "dependencies": ["<dep1>", ...],
      "description": "<what it does>"
    }
  ],
  "dataModel": [
    {
      "entity": "<EntityName>",
      "description": "<what it represents>",
      "fields": ["id", "created_at", "<field3>", ...],
      "relationships": ["<entity> has many <other>", ...]
    }
  ],
  "apiEndpoints": [
    {
      "path": "/api/<path>",
      "method": "GET|POST|PUT|PATCH|DELETE",
      "description": "<what this endpoint does>",
      "requestBody": "<shape description or null>",
      "responseType": "<shape description>"
    }
  ],
  "keyDecisions": ["<decision 1>", "<decision 2>", ...]
}

Rules:
- Use the existing stack: React + TypeScript + Express + Drizzle ORM + PostgreSQL + Supabase Auth
- Produce 4-8 components covering all pages + key services
- dataModel must reflect entities needed by the goal (2-4 entities)
- apiEndpoints must cover all CRUD operations needed (4-8 endpoints)
- keyDecisions should capture important architectural choices (2-4 items)
- Return ONLY the JSON object, no markdown, no extra text`;

const FILE_TREE_PROMPT = `You are a senior software architect AI. Given an architecture spec, produce a proposed file tree for the project.

Output ONLY valid JSON with this exact structure:
{
  "root": "src/",
  "structure": {
    "src/": {
      "components/": {
        "<ComponentName>.tsx": "// <brief description>"
      },
      "pages/": {
        "<page-name>.tsx": "// <brief description>"
      },
      "lib/": {
        "api.ts": "// API client",
        "types.ts": "// Shared types"
      },
      "hooks/": {
        "use<Name>.ts": "// <brief description>"
      },
      "App.tsx": "// Root component"
    },
    "server/": {
      "routes/": {
        "<entity>.ts": "// <brief description>"
      },
      "services/": {
        "<entity>.service.ts": "// <brief description>"
      }
    }
  },
  "totalFiles": <number>
}

Rules:
- Map all components from the arch spec to files
- Use .tsx for React components, .ts for services/hooks
- Return ONLY the JSON object, no markdown, no extra text`;

export const architectAgent: AgentContract = {
  agentKey: "architect_agent",
  title: "Architect Agent",
  description: "Produces technical architecture spec, component graph, data model, API endpoints, and proposed file structure.",
  outputArtifactTypes: ["arch_spec", "file_tree"],

  async execute(ctx: RunContext): Promise<AgentOutput> {
    const goal = ctx.goal || "Build a software feature";
    const tags = ctx.tags ?? [];

    const planArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "plan");
    const uxArtifact = ctx.previousArtifacts.find((a) => a.artifactType === "ux_spec");

    let planSummary = "";
    let uxSummary = "";

    if (planArtifact?.content) {
      try {
        const plan = JSON.parse(planArtifact.content);
        const allTasks = (plan.phases ?? []).flatMap((p: { tasks: { title: string }[] }) => p.tasks.map((t: { title: string }) => t.title));
        planSummary = `Plan: ${allTasks.slice(0, 8).join(", ")}. Complexity: ${plan.estimatedComplexity}.`;
      } catch { /* ignore */ }
    }

    if (uxArtifact?.content) {
      try {
        const ux = JSON.parse(uxArtifact.content);
        const screens = (ux.screens ?? []).map((s: { name: string; route: string }) => `${s.name} (${s.route})`);
        uxSummary = `Screens: ${screens.slice(0, 6).join(", ")}.`;
      } catch { /* ignore */ }
    }

    let archSpec: ArchSpecOutput;
    let fileTree: FileTreeOutput;

    if (isOpenAIAvailable()) {
      try {
        const model = getModelForAgent("architect_agent", ctx.agentModelOverrides?.["architect_agent"]);
        const userPrompt = [
          `Goal: ${goal}`,
          `Tags: ${tags.join(", ") || "none"}`,
          planSummary ? `\nExecution plan: ${planSummary}` : "",
          uxSummary ? `UX spec: ${uxSummary}` : "",
        ].filter(Boolean).join("\n");

        const rawArch = await chatJSON<Partial<ArchSpecOutput>>(SYSTEM_PROMPT, userPrompt, model, { agentKey: "architect_agent" });

        archSpec = {
          goal,
          stack: rawArch.stack ?? {
            frontend: "React + TypeScript + TanStack Query",
            backend: "Express.js + Drizzle ORM",
            database: "PostgreSQL (Supabase)",
            auth: "Supabase Auth",
            deployment: "Vercel",
          },
          components: rawArch.components ?? [],
          dataModel: rawArch.dataModel ?? [],
          apiEndpoints: rawArch.apiEndpoints ?? [],
          complexity: rawArch.complexity ?? "medium",
          keyDecisions: rawArch.keyDecisions,
          agentVersion: "v2-openai",
        };

        // Generate file tree based on arch spec
        try {
          const ftPrompt = `Architecture spec:\n${JSON.stringify({ components: archSpec.components, apiEndpoints: archSpec.apiEndpoints }, null, 2).slice(0, 1500)}`;
          const rawFt = await chatJSON<Partial<FileTreeOutput>>(FILE_TREE_PROMPT, ftPrompt, model, { agentKey: "architect_agent" });
          fileTree = {
            root: rawFt.root ?? "src/",
            structure: rawFt.structure ?? {},
            totalFiles: rawFt.totalFiles ?? archSpec.components.length + 5,
            agentVersion: "v2-openai",
          };
        } catch {
          fileTree = buildDeterministicFileTree(archSpec.components, archSpec.apiEndpoints);
        }
      } catch (err) {
        console.warn("[architect_agent] OpenAI call failed, using fallback:", (err as Error).message);
        const fallback = buildDeterministicArchSpec(goal, tags, planArtifact?.content, uxArtifact?.content);
        archSpec = fallback.archSpec;
        fileTree = fallback.fileTree;
      }
    } else {
      const fallback = buildDeterministicArchSpec(goal, tags, planArtifact?.content, uxArtifact?.content);
      archSpec = fallback.archSpec;
      fileTree = fallback.fileTree;
    }

    archSpec.goal = goal;

    return {
      artifacts: [
        {
          artifactType: "arch_spec",
          title: `Architecture Spec: ${goal.slice(0, 60)}`,
          description: `Technical architecture with ${archSpec.components.length} components and ${archSpec.apiEndpoints.length} API endpoints`,
          content: JSON.stringify(archSpec, null, 2),
          path: "architecture/arch-spec.json",
          version: "v1",
          tags: ["architecture", "spec", ...tags],
          metadata: { componentCount: archSpec.components.length, endpointCount: archSpec.apiEndpoints.length, agentVersion: archSpec.agentVersion },
        },
        {
          artifactType: "file_tree",
          title: `File Tree: ${goal.slice(0, 60)}`,
          description: `Proposed file structure with ${fileTree.totalFiles} files`,
          content: JSON.stringify(fileTree, null, 2),
          path: "architecture/file-tree.json",
          version: "v1",
          tags: ["file-tree", "structure"],
          metadata: { totalFiles: fileTree.totalFiles, agentVersion: fileTree.agentVersion },
        },
      ],
      summary: {
        goal,
        components: archSpec.components.length,
        endpoints: archSpec.apiEndpoints.length,
        entities: archSpec.dataModel.length,
        stack: archSpec.stack,
        llmBacked: archSpec.agentVersion === "v2-openai",
      },
    };
  },
};

type ArchSpecComponent = ArchSpecOutput["components"][number];
type ArchSpecEndpoint = ArchSpecOutput["apiEndpoints"][number];

function buildDeterministicFileTree(
  components: ArchSpecComponent[],
  endpoints: ArchSpecEndpoint[],
): FileTreeOutput {
  const structure: Record<string, unknown> = {
    "src/": {
      "components/": Object.fromEntries(
        components.filter((c) => c.type === "component" || c.type === "layout").map((c) => [`${c.name}.tsx`, `// ${c.description ?? c.name}`]),
      ),
      "pages/": Object.fromEntries(
        components.filter((c) => c.type === "page").map((c) => [`${c.name}.tsx`, `// ${c.description ?? c.name}`]),
      ),
      "lib/": { "api.ts": "// API client", "types.ts": "// Shared types" },
      "App.tsx": "// Root component",
    },
    "server/": {
      "routes/": Object.fromEntries(
        Array.from(new Set(endpoints.map((e) => e.path.split("/")[2] ?? "index"))).map((name) => [`${name}.ts`, `// ${name} routes`]),
      ),
    },
  };
  return { root: "src/", structure, totalFiles: components.length + 3, agentVersion: "v1-deterministic" };
}

function buildDeterministicArchSpec(
  goal: string,
  tags: string[],
  planContent?: string | null,
  uxContent?: string | null,
): { archSpec: ArchSpecOutput; fileTree: FileTreeOutput } {
  let screens: { name: string; route: string; components: string[] }[] = [];
  let allTasks: { title: string; type: string }[] = [];
  let complexity = "medium";

  if (planContent) {
    try {
      const plan = JSON.parse(planContent);
      allTasks = (plan.phases ?? []).flatMap((p: { tasks: { title: string; type: string }[] }) => p.tasks);
      complexity = plan.estimatedComplexity ?? "medium";
    } catch { /* ignore */ }
  }
  if (uxContent) {
    try { screens = JSON.parse(uxContent).screens ?? []; } catch { /* ignore */ }
  }

  const components: ArchSpecComponent[] = [
    ...screens.map((s) => ({ name: s.name.replace(/\s+/g, ""), type: "page" as const, route: s.route, dependencies: s.components, description: `Page for ${s.name}` })),
    { name: "AppShell", type: "layout", route: null, dependencies: [], description: "Root layout" },
    { name: "ApiClient", type: "service", route: null, dependencies: [], description: "HTTP client" },
    { name: "Store", type: "store", route: null, dependencies: [], description: "Global state" },
  ];

  const apiEndpoints: ArchSpecEndpoint[] = screens.map((s) => ({
    path: `/api${s.route}`,
    method: "GET",
    description: `Fetch data for ${s.name}`,
    responseType: "JSON",
  }));

  const dataModel = allTasks
    .filter((t) => t.type === "analysis")
    .slice(0, 3)
    .map((t, i) => ({
      entity: `Entity${i + 1}`,
      description: t.title,
      fields: ["id", "created_at", "updated_at"],
    }));

  const archSpec: ArchSpecOutput = {
    goal,
    stack: {
      frontend: "React + TypeScript + TanStack Query",
      backend: "Express.js + Drizzle ORM",
      database: "PostgreSQL (Supabase)",
      auth: "Supabase Auth",
      deployment: "Vercel",
    },
    components,
    dataModel,
    apiEndpoints,
    complexity,
    agentVersion: "v1-deterministic",
  };

  return { archSpec, fileTree: buildDeterministicFileTree(components, apiEndpoints) };
}
