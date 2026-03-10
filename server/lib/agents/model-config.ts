/**
 * Model Configuration Registry
 *
 * Single source of truth for which model each agent uses.
 * Agents read their model from here — never hardcode inside runtime logic.
 *
 * To upgrade a specific agent to a heavier model (e.g. gpt-4.1 for architect),
 * change the value here. Runtime pipeline code is not touched.
 *
 * Tier reference:
 *   gpt-4.1-mini  — fast, cheap, great for structured JSON (default for all agents)
 *   gpt-4.1       — heavier analysis; use for architect/review when quality matters more than cost
 *   gpt-4.1-nano  — cheapest option for trivial/reformatting steps
 */

export const DEFAULT_MODEL = "gpt-4.1-mini";

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
