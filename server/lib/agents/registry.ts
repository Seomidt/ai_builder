import type { AgentContract } from "./types.ts";
import { plannerAgent } from "./planner-agent.ts";
import { uxAgent } from "./ux-agent.ts";
import { architectAgent } from "./architect-agent.ts";
import { reviewAgent } from "./review-agent.ts";

/**
 * Agent registry — maps agentKey → AgentContract.
 * To add a new agent: implement AgentContract and register it here.
 */
const REGISTRY: Record<string, AgentContract> = {
  [plannerAgent.agentKey]: plannerAgent,
  [uxAgent.agentKey]: uxAgent,
  [architectAgent.agentKey]: architectAgent,
  [reviewAgent.agentKey]: reviewAgent,
};

/**
 * Default execution order when an architecture version has no agent configs.
 * Phase 2 baseline pipeline.
 */
export const DEFAULT_PIPELINE: Array<{ agentKey: string; executionOrder: number }> = [
  { agentKey: "planner_agent", executionOrder: 0 },
  { agentKey: "ux_agent", executionOrder: 1 },
  { agentKey: "architect_agent", executionOrder: 2 },
  { agentKey: "review_agent", executionOrder: 3 },
];

export function getAgent(agentKey: string): AgentContract | undefined {
  return REGISTRY[agentKey];
}

export function listAgents(): AgentContract[] {
  return Object.values(REGISTRY);
}

export function getRegisteredKeys(): string[] {
  return Object.keys(REGISTRY);
}
