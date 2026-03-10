import OpenAI from "openai";

/**
 * OpenAI client factory.
 * Returns a configured client if OPENAI_API_KEY is set, throws otherwise.
 * Do NOT cache the client at module level — call getOpenAIClient() per request.
 */
export function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

export function isOpenAIAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Call the chat completions API and parse the response as JSON.
 * Uses json_object response format — the system prompt must instruct the model to output JSON.
 *
 * @param systemPrompt  Describes the agent's role and required JSON schema
 * @param userPrompt    The actual request / context for this call
 * @param model         Model to use (default: gpt-4.1-mini — fast, cheap, good at JSON)
 */
export async function chatJSON<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  model = "gpt-4.1-mini",
): Promise<T> {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  return JSON.parse(content) as T;
}
