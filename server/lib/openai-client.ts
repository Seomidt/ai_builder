import OpenAI from "openai";
import { DEFAULT_MODEL } from "./agents/model-config";
import { env } from "./env";

/**
 * OpenAI client factory.
 * Returns a configured client if OPENAI_API_KEY is set, throws otherwise.
 * Do NOT cache the client at module level — call getOpenAIClient() per request.
 */
export function getOpenAIClient(): OpenAI {
  if (!env.OPENAI_API_KEY) throw new Error("Missing env: OPENAI_API_KEY");
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

export function isOpenAIAvailable(): boolean {
  return !!env.OPENAI_API_KEY;
}

/**
 * Structured log entry emitted after every agent LLM call.
 * Use this to track cost, latency, and reliability per agent.
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
  /** Agent key for logging and tracing — always provide this */
  agentKey: string;
  /** Temperature (default: 0.4) */
  temperature?: number;
}

/**
 * Call the chat completions API and parse the response as JSON.
 * Uses json_object response format — the system prompt MUST instruct the model to output JSON.
 *
 * Emits a structured log line per call (model, agentKey, latency, token usage, success/failure).
 *
 * @param systemPrompt  Describes the agent's role and required JSON schema
 * @param userPrompt    The actual request / context for this call
 * @param model         Model to use — resolve via getModelForAgent() before passing
 * @param opts          Options (agentKey required for logging)
 */
export async function chatJSON<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  model: string = DEFAULT_MODEL,
  opts: ChatJSONOptions = { agentKey: "unknown" },
): Promise<T> {
  const client = getOpenAIClient();
  const startMs = Date.now();
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;

  try {
    const response = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.4,
    });

    const latencyMs = Date.now() - startMs;

    if (response.usage) {
      promptTokens = response.usage.prompt_tokens ?? null;
      completionTokens = response.usage.completion_tokens ?? null;
      totalTokens = response.usage.total_tokens ?? null;
    }

    emitAgentCallLog({
      agentKey: opts.agentKey,
      model,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      success: true,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty content");
    return JSON.parse(content) as T;
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const message = err instanceof Error ? err.message : String(err);

    emitAgentCallLog({
      agentKey: opts.agentKey,
      model,
      latencyMs,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      success: false,
      error: message.slice(0, 120),
    });

    throw err;
  }
}
