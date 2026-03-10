/**
 * Agent Model Configuration Registry
 *
 * Maps each agentKey to its preferred model tier.
 * Model identifiers come from server/lib/ai/config.ts — never hardcoded here.
 *
 * To upgrade a specific agent (e.g. architect to gpt-4.1):
 *   Change the value to AI_MODELS.heavy — no runtime code changes needed.
 */

import { AI_MODELS } from "../ai/config";

export const DEFAULT_MODEL = AI_MODELS.default;

/**
 * Per-agent model assignments.
 * Key = agentKey (matches AgentContract.agentKey and architecture_agent_configs.agent_key).
 * Value = OpenAI model identifier.
 */
export const AGENT_MODEL_REGISTRY: Record<string, string> = {
  planner_agent:   "gpt-4.1-mini",
  ux_agent:        "gpt-4.1-mini",
  architect_agent: "gpt-4.1-mini",
  review_agent:    "gpt-4.1-mini",
};

/**
 * Resolve the model for a given agent.
 *
 * Priority order:
 *   1. Run-level override (from RunContext.agentModelOverrides[agentKey])
 *   2. Agent registry entry (AGENT_MODEL_REGISTRY[agentKey])
 *   3. DEFAULT_MODEL fallback
 *
 * @param agentKey   Agent identifier
 * @param override   Optional run-level override (pass undefined/null to skip)
 */
export function getModelForAgent(agentKey: string, override?: string | null): string {
  return override?.trim() || AGENT_MODEL_REGISTRY[agentKey] || DEFAULT_MODEL;
}
