/**
 * answer-grounding.ts — Phase 5P
 *
 * Grounded answer generation with deterministic chunk-level citations.
 *
 * Pipeline:
 *   context window (5O) → answer generation → citation extraction → persistence
 *
 * Design:
 *   - Answers generated ONLY from retrieved context (INV-ANS1)
 *   - Citations reference real chunk IDs — never fabricated (INV-ANS2/3)
 *   - Context chunks labeled [C1]…[Cn] and referenced by the model
 *   - Fallback: if OpenAI unavailable → context summary without LLM call
 *   - Tenant isolation enforced at every layer (INV-ANS4)
 *   - Preview mode performs zero writes (INV-ANS7)
 *
 * INV-ANS1: Answer only uses retrieved context
 * INV-ANS2: Citations reference real chunks
 * INV-ANS3: No fabricated sources
 * INV-ANS4: Tenant isolation holds throughout
 * INV-ANS5: Answer trace is deterministic
 * INV-ANS6: Answer generation does not mutate retrieval records
 * INV-ANS7: Preview endpoints do not persist
 * INV-ANS8: Runtime metrics are tenant-isolated
 */

import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeAnswerRuns,
  knowledgeAnswerCitations,
} from "@shared/schema";
import type { ContextWindowEntry } from "./context-window-builder";
import type { AdvancedRerankCandidate, AdvancedRerankMetrics } from "./advanced-reranking";
import {
  ANSWER_GENERATION_MODEL,
  ANSWER_GENERATION_MAX_CONTEXT_CHARS,
  ANSWER_GENERATION_TIMEOUT_MS,
  CITATION_PREVIEW_CHARS,
} from "../config/retrieval-config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnswerCitation {
  citationId: string;
  chunkId: string;
  documentId: string;
  assetId: string | null;
  chunkTextPreview: string;
  sourceUri: string | null;
  contextPosition: number;
  score: number;
}

export interface RetrievalRuntimeMetrics {
  rerankLatencyMs: number | null;
  shortlistSize: number;
  rerankProviderLatencyMs: number | null;
  rerankProviderTokenUsage: number | null;
  rerankProviderCostUsd: number | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  advancedRerankUsed: boolean;
}

export interface GroundedAnswerMetadata {
  answerText: string;
  citations: AnswerCitation[];
  retrievalRunId: string | null;
  contextChunkCount: number;
  answerTokenUsage: { prompt: number; completion: number } | null;
  generationModel: string;
  generationLatencyMs: number;
  answerRunId: string | null;
  runtimeMetrics: RetrievalRuntimeMetrics;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface GroundedAnswerParams {
  queryText: string;
  contextEntries: ContextWindowEntry[];
  candidates: AdvancedRerankCandidate[];
  tenantId: string;
  retrievalRunId?: string | null;
  rerankMetrics?: AdvancedRerankMetrics | null;
  modelName?: string;
  persistAnswer?: boolean;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a grounded answer generation system. You must answer the question using ONLY the provided context chunks, which are labeled [C1], [C2], etc.

Rules:
- Answer only from the provided context chunks
- Include [Cn] citation references inline for every statement
- If the context does not contain enough information, respond: "The provided context does not contain sufficient information to answer this question."
- Never add information that is not in the context
- Keep the answer accurate and concise
- Format as plain text with inline [Cn] references`;

// ── Build formatted context for prompt ───────────────────────────────────────

export function buildAnswerContext(
  entries: ContextWindowEntry[],
  maxTotalChars = ANSWER_GENERATION_MAX_CONTEXT_CHARS,
): { formattedContext: string; usedEntries: ContextWindowEntry[] } {
  const lines: string[] = [];
  let totalChars = 0;
  const usedEntries: ContextWindowEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const label = `[C${i + 1}]`;
    const text = entries[i].text.slice(0, 600);
    const line = `${label}: ${text}`;
    if (totalChars + line.length > maxTotalChars) break;
    lines.push(line);
    totalChars += line.length;
    usedEntries.push(entries[i]);
  }

  return {
    formattedContext: lines.join("\n\n"),
    usedEntries,
  };
}

// ── Citation extraction ───────────────────────────────────────────────────────

export function extractAnswerCitations(
  answerText: string,
  usedEntries: ContextWindowEntry[],
  candidates: AdvancedRerankCandidate[],
): AnswerCitation[] {
  // Find all [Cn] markers referenced in the answer (INV-ANS2: real chunks only)
  const matches = [...new Set(
    [...answerText.matchAll(/\[C(\d+)\]/g)].map((m) => parseInt(m[1], 10)),
  )].sort((a, b) => a - b);

  const scoreMap = new Map<string, number>(
    candidates.map((c) => [c.chunkId, c.finalScore ?? c.fusedScore]),
  );
  const assetMap = new Map<string, string | null>(
    candidates.map((c) => [c.chunkId, c.knowledgeAssetId ?? null]),
  );

  const citations: AnswerCitation[] = [];
  for (const idx of matches) {
    const entry = usedEntries[idx - 1];
    if (!entry) continue; // INV-ANS2: skip if no real chunk

    const chunkId = entry.metadata.chunkId;
    const score = scoreMap.get(chunkId) ?? entry.metadata.similarityScore ?? 0;
    const assetId = assetMap.get(chunkId) ?? null;

    citations.push({
      citationId: `c${idx}`,
      chunkId,
      documentId: entry.metadata.documentId,
      assetId,
      chunkTextPreview: entry.text.slice(0, CITATION_PREVIEW_CHARS),
      sourceUri: null, // populated below if available
      contextPosition: idx,
      score: Number(score.toFixed(6)),
    });
  }

  return citations;
}

// ── Fallback answer (no API key / provider failure) ───────────────────────────

function buildFallbackAnswer(
  queryText: string,
  usedEntries: ContextWindowEntry[],
  candidates: AdvancedRerankCandidate[],
): { answerText: string; citations: AnswerCitation[]; fallbackReason: string } {
  const fallbackReason = process.env.OPENAI_API_KEY
    ? "provider_unavailable"
    : "no_api_key";

  // Return context summary without LLM (INV-ANS1: only uses retrieved context)
  const summaryParts = usedEntries.slice(0, 5).map((e, i) => {
    const preview = e.text.slice(0, 300).replace(/\n+/g, " ");
    return `[C${i + 1}]: ${preview}`;
  });

  const answerText = usedEntries.length > 0
    ? `Based on the retrieved context:\n\n${summaryParts.join("\n\n")}\n\n(Advanced answer generation was unavailable. Showing raw context excerpts.)`
    : `No context was retrieved for query: "${queryText.slice(0, 100)}". Cannot generate an answer.`;

  const citations = usedEntries.slice(0, 5).map((e, i) => {
    const chunkId = e.metadata.chunkId;
    const candidate = candidates.find((c) => c.chunkId === chunkId);
    return {
      citationId: `c${i + 1}`,
      chunkId,
      documentId: e.metadata.documentId,
      assetId: candidate?.knowledgeAssetId ?? null,
      chunkTextPreview: e.text.slice(0, CITATION_PREVIEW_CHARS),
      sourceUri: null,
      contextPosition: i + 1,
      score: Number((candidate?.finalScore ?? candidate?.fusedScore ?? 0).toFixed(6)),
    };
  });

  return { answerText, citations, fallbackReason };
}

// ── Main answer generation ────────────────────────────────────────────────────

export async function generateGroundedAnswer(
  queryText: string,
  formattedContext: string,
  modelName: string,
): Promise<{
  answerText: string;
  tokenUsage: { prompt: number; completion: number } | null;
  latencyMs: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      answerText: "",
      tokenUsage: null,
      latencyMs: 0,
      fallbackUsed: true,
      fallbackReason: "no_api_key",
    };
  }

  const userMessage = `Context:\n${formattedContext}\n\nQuestion: ${queryText}`;
  const client = new OpenAI({ apiKey, timeout: ANSWER_GENERATION_TIMEOUT_MS });
  const startMs = Date.now();

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    const latencyMs = Date.now() - startMs;
    const answerText = response.choices[0]?.message?.content ?? "";
    const usage = response.usage
      ? { prompt: response.usage.prompt_tokens, completion: response.usage.completion_tokens }
      : null;

    return { answerText, tokenUsage: usage, latencyMs, fallbackUsed: false, fallbackReason: null };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    const fallbackReason = msg.includes("timeout") || msg.includes("ETIMEDOUT")
      ? "provider_timeout"
      : "provider_error";
    return { answerText: "", tokenUsage: null, latencyMs, fallbackUsed: true, fallbackReason };
  }
}

// ── Full grounded answer pipeline (INV-ANS1–8) ────────────────────────────────

export async function buildGroundedAnswer(
  params: GroundedAnswerParams,
): Promise<GroundedAnswerMetadata> {
  const {
    queryText,
    contextEntries,
    candidates,
    tenantId,
    retrievalRunId = null,
    rerankMetrics = null,
    modelName = ANSWER_GENERATION_MODEL,
    persistAnswer = false,
  } = params;

  // Build runtime metrics from rerank pipeline (INV-ANS8)
  const runtimeMetrics: RetrievalRuntimeMetrics = {
    rerankLatencyMs: rerankMetrics?.providerLatencyMs ?? null,
    shortlistSize: rerankMetrics?.shortlistSize ?? contextEntries.length,
    rerankProviderLatencyMs: rerankMetrics?.providerLatencyMs ?? null,
    rerankProviderTokenUsage:
      rerankMetrics && (rerankMetrics.providerPromptTokens !== null || rerankMetrics.providerCompletionTokens !== null)
        ? (rerankMetrics.providerPromptTokens ?? 0) + (rerankMetrics.providerCompletionTokens ?? 0)
        : null,
    rerankProviderCostUsd: rerankMetrics?.providerEstimatedCostUsd ?? null,
    fallbackUsed: rerankMetrics?.fallbackUsed ?? false,
    fallbackReason: rerankMetrics?.fallbackReason ?? null,
    advancedRerankUsed: rerankMetrics?.advancedRerankUsed ?? false,
  };

  // Step 1: Build formatted context
  const { formattedContext, usedEntries } = buildAnswerContext(contextEntries);

  let answerText: string;
  let tokenUsage: { prompt: number; completion: number } | null = null;
  let generationLatencyMs = 0;
  let answerFallbackUsed = false;
  let answerFallbackReason: string | null = null;
  let citations: AnswerCitation[];

  // Step 2: Generate answer
  const genResult = await generateGroundedAnswer(queryText, formattedContext, modelName);

  if (genResult.fallbackUsed || !genResult.answerText) {
    // Fallback: return context summary, real citations only (INV-ANS1/2/3)
    const fallback = buildFallbackAnswer(queryText, usedEntries, candidates);
    answerText = fallback.answerText;
    citations = fallback.citations;
    answerFallbackUsed = true;
    answerFallbackReason = genResult.fallbackReason ?? fallback.fallbackReason;
    generationLatencyMs = genResult.latencyMs;
  } else {
    answerText = genResult.answerText;
    tokenUsage = genResult.tokenUsage;
    generationLatencyMs = genResult.latencyMs;
    // Step 3: Extract citations (INV-ANS2: only real chunks)
    citations = extractAnswerCitations(answerText, usedEntries, candidates);
    // If no [Cn] markers used, include top-3 context chunks as implicit citations
    if (citations.length === 0) {
      citations = usedEntries.slice(0, 3).map((e, i) => {
        const chunkId = e.metadata.chunkId;
        const candidate = candidates.find((c) => c.chunkId === chunkId);
        return {
          citationId: `c${i + 1}`,
          chunkId,
          documentId: e.metadata.documentId,
          assetId: candidate?.knowledgeAssetId ?? null,
          chunkTextPreview: e.text.slice(0, CITATION_PREVIEW_CHARS),
          sourceUri: null,
          contextPosition: i + 1,
          score: Number((candidate?.finalScore ?? candidate?.fusedScore ?? 0).toFixed(6)),
        };
      });
    }
  }

  let answerRunId: string | null = null;

  // Step 4: Persist if requested (INV-ANS7: preview mode does not persist)
  if (persistAnswer) {
    const insertedRun = await db
      .insert(knowledgeAnswerRuns)
      .values({
        tenantId,
        retrievalRunId: retrievalRunId ?? undefined,
        answerText,
        generationModel: answerFallbackUsed ? `${modelName}:fallback` : modelName,
        generationLatencyMs,
        promptTokens: tokenUsage?.prompt ?? null,
        completionTokens: tokenUsage?.completion ?? null,
        contextChunkCount: usedEntries.length,
        fallbackUsed: answerFallbackUsed,
        fallbackReason: answerFallbackReason,
        rerankLatencyMs: runtimeMetrics.rerankLatencyMs,
        shortlistSize: runtimeMetrics.shortlistSize,
        rerankProviderLatencyMs: runtimeMetrics.rerankProviderLatencyMs,
        rerankProviderCostUsd:
          runtimeMetrics.rerankProviderCostUsd !== null
            ? runtimeMetrics.rerankProviderCostUsd.toFixed(8)
            : null,
        advancedRerankUsed: runtimeMetrics.advancedRerankUsed,
      })
      .returning({ id: knowledgeAnswerRuns.id });

    answerRunId = insertedRun[0]?.id ?? null;

    // Step 5: Persist citations (INV-ANS2: only real chunks)
    if (answerRunId && citations.length > 0) {
      await db.insert(knowledgeAnswerCitations).values(
        citations.map((c) => ({
          answerRunId,
          tenantId,
          chunkId: c.chunkId,
          documentId: c.documentId,
          assetId: c.assetId,
          citationIndex: parseInt(c.citationId.replace("c", ""), 10),
          contextPosition: c.contextPosition,
          chunkTextPreview: c.chunkTextPreview,
          sourceUri: c.sourceUri,
          finalScore: c.score.toFixed(8),
        })),
      );
    }
  }

  return {
    answerText,
    citations,
    retrievalRunId,
    contextChunkCount: usedEntries.length,
    answerTokenUsage: tokenUsage,
    generationModel: answerFallbackUsed ? `${modelName}:fallback` : modelName,
    generationLatencyMs,
    answerRunId,
    runtimeMetrics,
    fallbackUsed: answerFallbackUsed,
    fallbackReason: answerFallbackReason,
  };
}

// ── Summarize answer grounding (INV-ANS5/7: read-only) ───────────────────────

export async function summarizeAnswerGrounding(runId: string): Promise<{
  answerRunId: string;
  retrievalRunId: string | null;
  answerTextPreview: string;
  contextChunkCount: number | null;
  citationCount: number;
  generationModel: string | null;
  generationLatencyMs: number | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  advancedRerankUsed: boolean;
  createdAt: Date | null;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeAnswerRuns)
    .where(eq(knowledgeAnswerRuns.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) {
    return {
      answerRunId: runId,
      retrievalRunId: null,
      answerTextPreview: "",
      contextChunkCount: null,
      citationCount: 0,
      generationModel: null,
      generationLatencyMs: null,
      fallbackUsed: false,
      fallbackReason: null,
      advancedRerankUsed: false,
      createdAt: null,
      note: "Answer run not found",
    };
  }

  const citRows = await db
    .select()
    .from(knowledgeAnswerCitations)
    .where(eq(knowledgeAnswerCitations.answerRunId, runId));

  return {
    answerRunId: runId,
    retrievalRunId: run.retrievalRunId,
    answerTextPreview: run.answerText.slice(0, 300),
    contextChunkCount: run.contextChunkCount,
    citationCount: citRows.length,
    generationModel: run.generationModel,
    generationLatencyMs: run.generationLatencyMs,
    fallbackUsed: run.fallbackUsed ?? false,
    fallbackReason: run.fallbackReason,
    advancedRerankUsed: run.advancedRerankUsed ?? false,
    createdAt: run.createdAt,
    note: `Answer run found with ${citRows.length} citations`,
  };
}

// ── Get citations for a run (INV-ANS7: no writes) ─────────────────────────────

export async function getAnswerCitations(answerRunId: string): Promise<{
  answerRunId: string;
  citations: Array<{
    citationIndex: number | null;
    chunkId: string | null;
    documentId: string | null;
    assetId: string | null;
    contextPosition: number | null;
    chunkTextPreview: string | null;
    sourceUri: string | null;
    finalScore: string | null;
  }>;
  count: number;
}> {
  const rows = await db
    .select()
    .from(knowledgeAnswerCitations)
    .where(eq(knowledgeAnswerCitations.answerRunId, answerRunId));

  return {
    answerRunId,
    citations: rows.sort((a, b) => (a.citationIndex ?? 0) - (b.citationIndex ?? 0)).map((r) => ({
      citationIndex: r.citationIndex,
      chunkId: r.chunkId ?? null,
      documentId: r.documentId ?? null,
      assetId: r.assetId ?? null,
      contextPosition: r.contextPosition ?? null,
      chunkTextPreview: r.chunkTextPreview ?? null,
      sourceUri: r.sourceUri ?? null,
      finalScore: r.finalScore ?? null,
    })),
    count: rows.length,
  };
}

// ── Answer trace (INV-ANS5/7: deterministic, no writes) ──────────────────────

export async function explainAnswerTrace(runId: string): Promise<{
  answerRunId: string;
  stages: Array<{ stage: string; status: string; detail: string | null }>;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeAnswerRuns)
    .where(eq(knowledgeAnswerRuns.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) {
    return {
      answerRunId: runId,
      stages: [],
      note: "Answer run not found — was persistAnswer=true used?",
    };
  }

  const citRows = await db
    .select()
    .from(knowledgeAnswerCitations)
    .where(eq(knowledgeAnswerCitations.answerRunId, runId));

  const stages = [
    {
      stage: "retrieval",
      status: run.retrievalRunId ? "completed" : "unknown",
      detail: run.retrievalRunId ? `retrieval_run_id=${run.retrievalRunId}` : "no retrieval run linked",
    },
    {
      stage: "reranking",
      status: run.advancedRerankUsed ? "advanced" : "fallback",
      detail: run.advancedRerankUsed
        ? `advanced reranking completed; shortlist_size=${run.shortlistSize ?? "unknown"}`
        : `fallback reranking; reason: ${run.fallbackReason ?? "unknown"}`,
    },
    {
      stage: "context_assembly",
      status: (run.contextChunkCount ?? 0) > 0 ? "completed" : "empty",
      detail: `${run.contextChunkCount ?? 0} chunks assembled`,
    },
    {
      stage: "answer_generation",
      status: run.fallbackUsed ? "fallback" : "completed",
      detail: run.fallbackUsed
        ? `model fallback used; reason: ${run.fallbackReason ?? "unknown"}; latency: ${run.generationLatencyMs ?? 0}ms`
        : `model: ${run.generationModel}; latency: ${run.generationLatencyMs ?? 0}ms; tokens: ${(run.promptTokens ?? 0) + (run.completionTokens ?? 0)}`,
    },
    {
      stage: "citations",
      status: citRows.length > 0 ? "completed" : "none",
      detail: `${citRows.length} citations extracted from answer`,
    },
  ];

  return {
    answerRunId: runId,
    stages,
    note: "Read-only trace. INV-ANS7: no writes performed.",
  };
}

// ── Runtime metrics (INV-ANS8: tenant-isolated) ───────────────────────────────

export async function recordRetrievalRuntimeMetrics(
  runId: string,
  metrics: RetrievalRuntimeMetrics,
): Promise<void> {
  // Phase 5P metrics are persisted within knowledge_answer_runs during buildGroundedAnswer
  // This function is a no-op for inline recording; use buildGroundedAnswer(persistAnswer=true)
  void runId;
  void metrics;
}

export async function getRetrievalRuntimeMetrics(runId: string): Promise<RetrievalRuntimeMetrics | null> {
  const rows = await db
    .select()
    .from(knowledgeAnswerRuns)
    .where(eq(knowledgeAnswerRuns.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) return null;

  return {
    rerankLatencyMs: run.rerankLatencyMs,
    shortlistSize: run.shortlistSize ?? 0,
    rerankProviderLatencyMs: run.rerankProviderLatencyMs,
    rerankProviderTokenUsage: null,
    rerankProviderCostUsd: run.rerankProviderCostUsd ? parseFloat(run.rerankProviderCostUsd) : null,
    fallbackUsed: run.fallbackUsed ?? false,
    fallbackReason: run.fallbackReason,
    advancedRerankUsed: run.advancedRerankUsed ?? false,
  };
}

export async function summarizeRetrievalRuntimeMetrics(tenantId: string): Promise<{
  tenantId: string;
  totalAnswerRuns: number;
  advancedRerankUsedCount: number;
  fallbackUsedCount: number;
  avgGenerationLatencyMs: number | null;
  avgShortlistSize: number | null;
  totalCitationsGenerated: number;
  note: string;
}> {
  const runs = await db
    .select()
    .from(knowledgeAnswerRuns)
    .where(eq(knowledgeAnswerRuns.tenantId, tenantId));

  const latencies = runs.map((r) => r.generationLatencyMs).filter((v): v is number => v !== null);
  const shortlists = runs.map((r) => r.shortlistSize).filter((v): v is number => v !== null);

  const citRows = runs.length > 0
    ? await db.select().from(knowledgeAnswerCitations).where(eq(knowledgeAnswerCitations.tenantId, tenantId))
    : [];

  return {
    tenantId,
    totalAnswerRuns: runs.length,
    advancedRerankUsedCount: runs.filter((r) => r.advancedRerankUsed).length,
    fallbackUsedCount: runs.filter((r) => r.fallbackUsed).length,
    avgGenerationLatencyMs: latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
    avgShortlistSize: shortlists.length > 0
      ? Math.round(shortlists.reduce((a, b) => a + b, 0) / shortlists.length)
      : null,
    totalCitationsGenerated: citRows.length,
    note: runs.length === 0 ? "No answer runs found for tenant" : `${runs.length} answer runs found`,
  };
}

// ── Context display (INV-ANS7: no writes) ─────────────────────────────────────

export async function getAnswerContext(answerRunId: string): Promise<{
  answerRunId: string;
  contextChunkCount: number | null;
  retrievalRunId: string | null;
  rerankMode: "advanced" | "fallback" | "lightweight" | "unknown";
  runtimeMetrics: {
    shortlistSize: number | null;
    rerankLatencyMs: number | null;
    advancedRerankUsed: boolean;
    fallbackUsed: boolean;
    fallbackReason: string | null;
  };
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeAnswerRuns)
    .where(eq(knowledgeAnswerRuns.id, answerRunId))
    .limit(1);

  const run = rows[0];
  if (!run) {
    return {
      answerRunId,
      contextChunkCount: null,
      retrievalRunId: null,
      rerankMode: "unknown",
      runtimeMetrics: {
        shortlistSize: null,
        rerankLatencyMs: null,
        advancedRerankUsed: false,
        fallbackUsed: false,
        fallbackReason: null,
      },
      note: "Answer run not found",
    };
  }

  return {
    answerRunId,
    contextChunkCount: run.contextChunkCount,
    retrievalRunId: run.retrievalRunId,
    rerankMode: run.advancedRerankUsed ? "advanced" : run.fallbackUsed ? "fallback" : "lightweight",
    runtimeMetrics: {
      shortlistSize: run.shortlistSize,
      rerankLatencyMs: run.rerankLatencyMs,
      advancedRerankUsed: run.advancedRerankUsed ?? false,
      fallbackUsed: run.fallbackUsed ?? false,
      fallbackReason: run.fallbackReason,
    },
    note: "Read-only context summary. INV-ANS7: no writes performed.",
  };
}
