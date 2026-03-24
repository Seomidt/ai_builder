/**
 * Summarize Feature Service
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * First real AI feature — wraps runAiCall() with the summarize prompt.
 * All usage logging, requestId tracing, and error handling flow through
 * the existing AI stack (runner → provider → ai_usage table).
 */

import { runAiCall } from "../../lib/ai/runner";
import { getSummarizePrompt } from "../../lib/ai/prompts/summarize";

export interface SummarizeInput {
  text: string;
  tenantId?: string | null;
  userId?: string | null;
  requestId?: string | null;
}

export interface SummarizeResult {
  summary: string;
  model: string;
  latencyMs: number;
}

/**
 * Summarize arbitrary text using the configured default AI model.
 *
 * Uses runAiCall() — which handles provider selection, usage logging,
 * requestId tracing, latency measurement, and typed error propagation.
 *
 * @throws AiError subclass on provider failure — callers decide how to handle
 */
export async function summarize(input: SummarizeInput): Promise<SummarizeResult> {
  const { text, tenantId, userId, requestId } = input;

  const result = await runAiCall(
    {
      feature: "summarize",
      useCase: "analysis",
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: requestId ?? null,
      model: "default",
    },
    {
      systemPrompt: getSummarizePrompt(),
      userInput: text,
    },
  );

  return {
    summary: result.text,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
