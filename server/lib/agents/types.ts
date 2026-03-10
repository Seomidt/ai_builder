/**
 * Agent contract types for the AI Builder Platform.
 *
 * Each agent defines:
 * - agentKey: unique identifier matching architecture_agent_configs.agent_key
 * - title/description: human-readable metadata
 * - inputSchema: Zod schema for input validation
 * - outputArtifactTypes: what artifact types this agent produces
 * - execute(): the execution handler (deterministic in V1, LLM-backed in V2+)
 */

import type { AiArtifact, AiStep } from "@shared/schema";

export interface RunContext {
  runId: string;
  organizationId: string;
  projectId: string;
  architectureProfileId: string;
  architectureVersionId: string;
  goal: string;
  title: string | null;
  tags: string[] | null;
  pipelineVersion: string | null;
  /** Artifacts produced by previous agents in this run */
  previousArtifacts: AiArtifact[];
  /** Steps completed before this one */
  previousSteps: AiStep[];
  /**
   * Optional per-agent model overrides for this specific run.
   * Key = agentKey, Value = OpenAI model identifier.
   * Takes priority over AGENT_MODEL_REGISTRY in model-config.ts.
   *
   * Example: { architect_agent: "gpt-4.1", review_agent: "gpt-4.1" }
   */
  agentModelOverrides?: Record<string, string> | null;
}

export interface AgentOutput {
  /** Artifacts to persist — content is serialized JSON or text */
  artifacts: Array<{
    artifactType: string;
    title: string;
    description?: string;
    content: string;
    path?: string;
    version?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>;
  /** Human-readable summary for step.output */
  summary: Record<string, unknown>;
}

export interface AgentContract {
  agentKey: string;
  title: string;
  description: string;
  outputArtifactTypes: string[];
  execute(context: RunContext): Promise<AgentOutput>;
}
