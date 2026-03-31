import OpenAI from "openai";
import { DEFAULT_MODEL } from "./agents/model-config.ts";

let _client: OpenAI | null = null;

/**
 * OpenAI client factory.
 * Connects directly to api.openai.com using OPENAI_API_KEY.
 * No proxy — production setup.
 */
export function getOpenAIClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it to Railway environment variables.");
  }
  _client = new OpenAI({
    apiKey,
    baseURL: "https://api.openai.com/v1",
  });
  return _client;
}

export function isOpenAIAvailable(): boolean {
  return !!(process.env.OPENAI_API_KEY);
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
 * Call the chat completions API with JSON output.
 */
export async function chatJSON<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  model: string = DEFAULT_MODEL,
  opts: ChatJSONOptions = { agentKey: "unknown" },
): Promise<T> {
  const client = getOpenAIClient();
  const t0 = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: opts.temperature ?? 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    });
    const text = completion.choices[0]?.message?.content ?? "{}";
    emitAgentCallLog({
      agentKey:         opts.agentKey,
      model,
      latencyMs:        Date.now() - t0,
      promptTokens:     completion.usage?.prompt_tokens     ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      totalTokens:      completion.usage?.total_tokens      ?? null,
      success:          true,
    });
    return JSON.parse(text) as T;
  } catch (e: any) {
    emitAgentCallLog({
      agentKey:         opts.agentKey,
      model,
      latencyMs:        Date.now() - t0,
      promptTokens:     null,
      completionTokens: null,
      totalTokens:      null,
      success:          false,
      error:            e?.message,
    });
    throw e;
  }
}
