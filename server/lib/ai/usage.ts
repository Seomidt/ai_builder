/**
 * AI Usage Logger
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * Persists every LLM call to the ai_usage table for cost tracking and debugging.
 *
 * Design principles:
 * - Logging failures must NEVER crash the application flow (fire-and-forget)
 * - Uses the same Drizzle db instance as the rest of the server
 * - Callers own the decision of when and whether to log
 */

import { db } from "../../db";
import { aiUsage } from "@shared/schema";

export interface LogAiUsagePayload {
  tenantId?: string | null;
  userId?: string | null;
  /** HTTP request ID — ties this AI call back to its origin request for tracing */
  requestId?: string | null;
  /** Feature or agent key that made the call (e.g. "planner_agent", "summarize") */
  feature: string;
  /** OpenAI model identifier (e.g. "gpt-4.1-mini") */
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  /** First N chars of user input for debugging — never store full prompts */
  inputPreview?: string | null;
  status: "success" | "error";
  errorMessage?: string | null;
  latencyMs?: number | null;
}

/**
 * Insert a row into ai_usage.
 *
 * Fire-and-forget: any database error is caught and logged to console only.
 * The calling code never sees a thrown error from this function.
 */
export async function logAiUsage(payload: LogAiUsagePayload): Promise<void> {
  try {
    await db.insert(aiUsage).values({
      tenantId: payload.tenantId ?? null,
      userId: payload.userId ?? null,
      requestId: payload.requestId ?? null,
      feature: payload.feature,
      model: payload.model,
      promptTokens: payload.promptTokens ?? 0,
      completionTokens: payload.completionTokens ?? 0,
      totalTokens: payload.totalTokens ?? 0,
      inputPreview: payload.inputPreview ?? null,
      status: payload.status,
      errorMessage: payload.errorMessage ?? null,
      latencyMs: payload.latencyMs ?? null,
    });
  } catch (err) {
    // Logging must never crash the application
    console.error("[ai/usage] Failed to log AI usage:", err instanceof Error ? err.message : err);
  }
}
