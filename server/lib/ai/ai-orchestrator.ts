/**
 * Phase 12 — AI Orchestrator
 * Full RAG pipeline: query → retrieval → context → prompt → model → response → store
 * INV-AI1: Every query produces a response (or structured error).
 * INV-AI2: System prompt never overrideable by user input.
 * INV-AI3: Context ordered by retrieval rank.
 * INV-AI4: Context fits within model context window.
 * INV-AI5: Prompts are tenant-scoped.
 * INV-AI6: Usage recorded for every request.
 * INV-AI7: Guardrails applied before model execution.
 * INV-AI8: Estimated cost is non-negative.
 * Security: rate limiting, request IDs, input validation, timeout.
 */

import pg from "pg";
import { checkGuardrails, assertSafeQuery, sanitizeQuery } from "./ai-guardrails.ts";
import { buildContext } from "./ai-context-builder.ts";
import { buildPrompt, getPromptVersion, getLatestPromptVersion } from "./ai-prompt-builder.ts";
import { selectModel } from "./ai-model-router.ts";
import { executeModel } from "./ai-stream.ts";
import { recordUsage, storeResponse } from "./ai-usage.ts";
import { runRetrieval } from "../retrieval/retrieval-orchestrator.ts";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

// ─── Resource exhaustion limits (CodeQL remediation) ─────────────────────────
export const MAX_CONTEXT_CHUNKS = 8;
export const MAX_CONTEXT_CHARS = 20_000;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_PROMPT_TOKENS_ESTIMATE = 12_000;
export const MAX_PIPELINE_TIME_MS = 10_000;

// ─── Rate limiting (per-tenant in-memory token bucket) ─────────────────────
const rateLimitMap = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT = 20;
const WINDOW_MS = 60_000;

// ─── Structured limit-violation logger ───────────────────────────────────────
function logLimitViolation(params: { tenantId: string; requestId: string; limitType: string; inputSize: number }): void {
  console.warn(JSON.stringify({ level: "SECURITY", event: "limit_exceeded", ...params, timestamp: new Date().toISOString() }));
}

// ─── Rough token estimator (4 chars ≈ 1 token) ───────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function checkRateLimit(tenantId: string): void {
  const now = Date.now();
  let b = rateLimitMap.get(tenantId);
  if (!b) { b = { tokens: RATE_LIMIT, lastRefill: now }; rateLimitMap.set(tenantId, b); }
  if (now - b.lastRefill >= WINDOW_MS) { b.tokens = RATE_LIMIT; b.lastRefill = now; }
  if (b.tokens <= 0) throw new Error(`INV-AI-RATE: Rate limit exceeded — max ${RATE_LIMIT} AI queries/minute for tenant`);
  b.tokens--;
}

export interface AiOrchestrationResult {
  success: boolean;
  requestId: string;
  tenantId: string;
  queryText: string;
  responseText: string;
  modelId: string;
  modelName: string;
  provider: string;
  retrievalQueryId: string | null;
  promptVersionId: string | null;
  contextChunks: number;
  tokenPrompt: number;
  tokenCompletion: number;
  estimatedCostUsd: number;
  latencyMs: number;
  simulated: boolean;
  guardrailPassed: boolean;
  error?: string;
}

// ─── storeAiRequest ──────────────────────────────────────────────────────────
async function storeAiRequest(params: {
  tenantId: string;
  queryText: string;
  promptVersionId: string | null;
  retrievalQueryId: string | null;
  modelId: string | null;
  client: pg.Client;
}): Promise<string> {
  const r = await params.client.query(
    `INSERT INTO public.ai_requests (id,tenant_id,query_text,prompt_version_id,retrieval_query_id,model_id)
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5) RETURNING id`,
    [params.tenantId, params.queryText, params.promptVersionId, params.retrievalQueryId, params.modelId],
  );
  return r.rows[0].id as string;
}

// ─── getResponseByRequestId ──────────────────────────────────────────────────
export async function getResponseByRequestId(requestId: string, tenantId: string): Promise<{
  responseText: string; tokenPrompt: number; tokenCompletion: number; latencyMs: number;
} | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT resp.response_text, resp.token_prompt, resp.token_completion, resp.latency_ms
       FROM public.ai_responses resp
       JOIN public.ai_requests req ON req.id = resp.request_id
       WHERE resp.request_id=$1 AND req.tenant_id=$2`,
      [requestId, tenantId],
    );
    if (!r.rows.length) return null;
    return { responseText: r.rows[0].response_text, tokenPrompt: r.rows[0].token_prompt, tokenCompletion: r.rows[0].token_completion, latencyMs: r.rows[0].latency_ms };
  } finally {
    await client.end();
  }
}

// ─── listRequests ────────────────────────────────────────────────────────────
export async function listRequests(tenantId: string, limit = 50): Promise<Array<{ id: string; queryText: string; createdAt: Date; modelId: string | null }>> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT id, query_text, created_at, model_id FROM public.ai_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(limit, 200)]);
    return r.rows.map((row) => ({ id: row.id, queryText: row.query_text, createdAt: new Date(row.created_at), modelId: row.model_id }));
  } finally {
    await client.end();
  }
}

// ─── runAiQuery ──────────────────────────────────────────────────────────────
// Full RAG orchestration pipeline.
export async function runAiQuery(params: {
  tenantId: string;
  queryText: string;
  promptId?: string;
  promptVersionId?: string;
  preferredModelId?: string;
  retrievalStrategy?: "vector" | "lexical" | "hybrid";
  topK?: number;
  requestId?: string;
  timeoutMs?: number;
}): Promise<AiOrchestrationResult> {
  const startTime = Date.now();
  const {
    tenantId, preferredModelId, timeoutMs = 30_000,
    retrievalStrategy = "hybrid", topK = 8,
    requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  } = params;

  const queryText = sanitizeQuery(params.queryText);

  // Resource guard: MAX_QUERY_LENGTH (CodeQL: resource exhaustion protection)
  if (queryText.length > MAX_QUERY_LENGTH) {
    logLimitViolation({ tenantId, requestId, limitType: "query_length", inputSize: queryText.length });
    return errorResult(requestId, tenantId, queryText, `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters (got ${queryText.length}).`, startTime);
  }

  // Security: Rate limiting
  try { checkRateLimit(tenantId); } catch (e) {
    return errorResult(requestId, tenantId, queryText, String((e as Error).message), startTime);
  }

  // INV-AI7: Guardrails BEFORE anything else
  const guard = checkGuardrails(queryText);
  if (!guard.passed) {
    return { ...errorResult(requestId, tenantId, queryText, `Guardrail [${guard.reason}]: ${guard.detail}`, startTime), guardrailPassed: false };
  }

  // Timeout: MAX_PIPELINE_TIME_MS (CodeQL: resource exhaustion protection)
  const effectiveTimeout = Math.min(timeoutMs, MAX_PIPELINE_TIME_MS);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      logLimitViolation({ tenantId, requestId, limitType: "pipeline_timeout", inputSize: effectiveTimeout });
      reject(new Error(`AI orchestration timeout after ${effectiveTimeout}ms (MAX_PIPELINE_TIME_MS)`));
    }, effectiveTimeout),
  );

  return Promise.race([executeOrchestration({ ...params, queryText, requestId, startTime }), timeoutPromise]).catch((e) =>
    errorResult(requestId, tenantId, queryText, (e as Error).message, startTime),
  );
}

async function executeOrchestration(params: {
  tenantId: string;
  queryText: string;
  promptId?: string;
  promptVersionId?: string;
  preferredModelId?: string;
  retrievalStrategy?: "vector" | "lexical" | "hybrid";
  topK?: number;
  requestId: string;
  startTime: number;
}): Promise<AiOrchestrationResult> {
  const { tenantId, queryText, promptId, promptVersionId, preferredModelId, retrievalStrategy = "hybrid", topK = 8, requestId, startTime } = params;

  const client = getClient();
  await client.connect();

  try {
    // Step 1: Run retrieval engine (Phase 11)
    const retrieval = await runRetrieval({ tenantId, queryText, strategy: retrievalStrategy, topK, requestId });
    const retrievalQueryId = retrieval.queryId || null;

    // Step 2: Build context from retrieved chunks (INV-AI3: ordered by rank)
    const model = await selectModel({
      preferredModelName: preferredModelId,
      requiredContextTokens: 1000,
      client,
    });

    const context = buildContext({ results: retrieval.results, contextWindow: model.contextWindow, reserveTokensForPromptAndResponse: model.maxTokens });

    // Resource guard: MAX_CONTEXT_CHUNKS (CodeQL: bounded array, prevent large chunk concat)
    if (context.totalChunks > MAX_CONTEXT_CHUNKS) {
      logLimitViolation({ tenantId, requestId, limitType: "context_chunks", inputSize: context.totalChunks });
      throw new Error(`Context exceeds MAX_CONTEXT_CHUNKS (${context.totalChunks} > ${MAX_CONTEXT_CHUNKS})`);
    }

    // Resource guard: MAX_CONTEXT_CHARS (CodeQL: memory safety)
    if (context.contextText.length > MAX_CONTEXT_CHARS) {
      logLimitViolation({ tenantId, requestId, limitType: "context_chars", inputSize: context.contextText.length });
      throw new Error(`Context exceeds MAX_CONTEXT_CHARS (${context.contextText.length} > ${MAX_CONTEXT_CHARS})`);
    }

    // Step 3: Get or create prompt version (INV-AI5: tenant-scoped)
    let pv = null;
    if (promptVersionId) {
      pv = await getPromptVersion(promptVersionId, client);
    } else if (promptId) {
      pv = await getLatestPromptVersion(promptId, tenantId);
    }

    // Fallback: default system prompt
    const defaultSystemPrompt = "You are a helpful AI assistant. Answer the user's question using ONLY the provided context. If the context does not contain relevant information, say so clearly. Do not hallucinate.";
    const fakePv = pv ?? { id: "default", promptId: "", version: 1, systemPrompt: defaultSystemPrompt, temperature: 0.7, topP: 1.0, maxTokens: model.maxTokens, createdAt: new Date() };

    // Step 4: Build prompt (INV-AI2: system prompt sealed)
    const built = buildPrompt({ promptVersion: fakePv, contextText: context.contextText, queryText });

    // Resource guard: MAX_PROMPT_TOKENS_ESTIMATE (CodeQL: prevent token budget exhaustion)
    const promptTokenEstimate = estimateTokens(built.systemPrompt + built.userMessage);
    if (promptTokenEstimate > MAX_PROMPT_TOKENS_ESTIMATE) {
      logLimitViolation({ tenantId, requestId, limitType: "prompt_tokens_estimate", inputSize: promptTokenEstimate });
      throw new Error(`Prompt token estimate exceeds MAX_PROMPT_TOKENS_ESTIMATE (${promptTokenEstimate} > ${MAX_PROMPT_TOKENS_ESTIMATE})`);
    }

    // Step 5: Store request record
    const dbRequestId = await storeAiRequest({ tenantId, queryText, promptVersionId: pv?.id ?? null, retrievalQueryId, modelId: model.id, client });

    // Step 6: Execute model (INV-AI1)
    const modelResp = await executeModel({ model, systemPrompt: built.systemPrompt, userMessage: built.userMessage, temperature: fakePv.temperature, maxTokens: fakePv.maxTokens });

    const latencyMs = Date.now() - startTime;

    // Step 7: Store response
    await storeResponse({ requestId: dbRequestId, responseText: modelResp.responseText, tokenPrompt: modelResp.tokenPrompt, tokenCompletion: modelResp.tokenCompletion, latencyMs, client });

    // Step 8: Record usage (INV-AI6)
    await recordUsage({ tenantId, requestId: dbRequestId, modelId: model.id, tokenPrompt: modelResp.tokenPrompt, tokenCompletion: modelResp.tokenCompletion, costPromptPer1k: model.costPrompt, costCompletionPer1k: model.costCompletion, client });

    const estimatedCostUsd = (modelResp.tokenPrompt / 1000) * model.costPrompt + (modelResp.tokenCompletion / 1000) * model.costCompletion;

    return {
      success: true,
      requestId: dbRequestId,
      tenantId,
      queryText,
      responseText: modelResp.responseText,
      modelId: model.id,
      modelName: model.modelName,
      provider: model.provider,
      retrievalQueryId,
      promptVersionId: pv?.id ?? null,
      contextChunks: context.totalChunks,
      tokenPrompt: modelResp.tokenPrompt,
      tokenCompletion: modelResp.tokenCompletion,
      estimatedCostUsd: Math.max(0, estimatedCostUsd),
      latencyMs,
      simulated: modelResp.simulated,
      guardrailPassed: true,
    };
  } finally {
    await client.end();
  }
}

function errorResult(requestId: string, tenantId: string, queryText: string, error: string, startTime: number): AiOrchestrationResult {
  return {
    success: false, requestId, tenantId, queryText, responseText: "", modelId: "", modelName: "", provider: "",
    retrievalQueryId: null, promptVersionId: null, contextChunks: 0, tokenPrompt: 0, tokenCompletion: 0,
    estimatedCostUsd: 0, latencyMs: Date.now() - startTime, simulated: false, guardrailPassed: true, error,
  };
}
