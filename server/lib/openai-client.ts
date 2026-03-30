import { DEFAULT_MODEL } from "./agents/model-config.ts";
import { env } from "./env.ts";

/**
 * OpenAI client factory (DISABLED for Manus-Only architecture).
 * Returns a dummy object to satisfy TypeScript but throws if actually called.
 */
export function getOpenAIClient(): any {
  throw new Error("OpenAI is disabled in Manus-Only architecture. Please use Manus-Gateway instead.");
}

export function isOpenAIAvailable(): boolean {
  return false;
}

/**
 * Structured log entry emitted after every agent LLM call.
 */
export interface AgentCallLog {
  agentKey: string;
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  success: boolean;
  error?: string;
}

function emitAgentCallLog(entry: AgentCallLog): void {
  const status = entry.success ? "✓" : "✗";
  const tokens = entry.totalTokens != null
    ? `tokens=${entry.totalTokens} (prompt=${entry.promptTokens ?? "?"} compl=${entry.completionTokens ?? "?"})`
    : "tokens=n/a";
  const errSuffix = entry.error ? ` | error="${entry.error}"` : "";

  console.log(
    `[llm] ${status} agent=${entry.agentKey} model=${entry.model} latency=${entry.latencyMs}ms ${tokens}${errSuffix}`,
  );
}

/**
 * Options for chatJSON calls.
 */
export interface ChatJSONOptions {
  agentKey: string;
  temperature?: number;
}

/**
 * Call the chat completions API (DISABLED for Manus-Only architecture).
 */
export async function chatJSON<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  model: string = DEFAULT_MODEL,
  opts: ChatJSONOptions = { agentKey: "unknown" },
): Promise<T> {
  throw new Error("chatJSON is disabled in Manus-Only architecture. Please use Manus-Gateway instead.");
}
