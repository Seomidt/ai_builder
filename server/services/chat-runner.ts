/**
 * chat-runner.ts — Thin adapter that reuses existing expert orchestration for AI Chat.
 *
 * Does NOT rebuild prompt-building, runAiCall, or rule engine.
 * Simply calls the same functions the /api/experts/:id/test endpoint uses,
 * and maps the result into a chat-safe response shape.
 */

import { db } from "../db";
import {
  architectureProfiles,
  specialistRules,
  specialistSources,
  expertVersions,
  chatConversations,
  chatMessages,
} from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import type { AccessibleExpert } from "./chat-routing";
import { AI_MODEL_ROUTES } from "../lib/ai/config";

export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

export interface SimilarCaseInResponse {
  chunkId:          string;
  score:            number;
  snippet:          string;
  sourceLabel:      string;
  assetId:          string;
  assetVersionId:   string;
  assetTitle:       string | null;
  assetType:        string | null;
  kbId:             string;
  kbName:           string | null;
  whyMatched:       string;
  pageNumber:       number | null;
  timestampSec:     number | null;
}

export interface ChatRunResult {
  answer: string;
  conversationId: string;
  expert: {
    id: string;
    name: string;
    category: string | null;
  };
  usedSources: Array<{ id: string; name: string; sourceType?: string }>;
  usedRules: Array<{ id: string; title: string }>;
  warnings: string[];
  latencyMs: number;
  confidenceBand: ConfidenceBand;
  needsManualReview: boolean;
  routingExplanation: string;
  
  // Storage 1.6: optional similar cases from knowledge bases
  similarCases?: SimilarCaseInResponse[];
  totalSimilarCases?: number;
}

interface DocumentContextItem {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error";
  message?:       string;
}

export async function runChatMessage(params: {
  message: string;
  expert: AccessibleExpert;
  organizationId: string;
  userId: string;
  conversationId?: string | null;
  routingExplanation: string;
  documentContext?: DocumentContextItem[];
  useCase?: import("../lib/ai/types").AiUseCase;
}): Promise<ChatRunResult> {
  const { message, expert, organizationId, userId, routingExplanation } = params;
  const startMs = Date.now();

  // ── Document context validation + injection ────────────────────────────────
  const rawDocCtx  = params.documentContext ?? [];
  const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
  const failedDocs = rawDocCtx.filter(d => d.status !== "ok");

  // TASK 4 — debug log ALTID
  console.log(`[chat-runner] message_len=${message.length} doc_ctx_raw=${rawDocCtx.length} doc_ctx_ok=${docCtx.length}`);
  if (docCtx.length > 0) {
    const totalChars = docCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0);
    console.log(`[chat-runner] total_doc_chars=${totalChars} first200="${docCtx[0].extracted_text.slice(0, 200).replace(/\n/g, " ")}"`);
  }
  if (failedDocs.length > 0) {
    console.warn(`[chat-runner] failed_docs:`, failedDocs.map(d => `${d.filename}:${d.status}:${d.message}`).join(", "));
  }

  // TASK 5 — hard assertion
  if (rawDocCtx.length > 0 && docCtx.length === 0) {
    const reason = failedDocs.map(d => d.message).filter(Boolean).join("; ")
      || "Ingen tekst kunne udtrækkes";
    throw Object.assign(new Error(reason), { errorCode: "DOCUMENT_UNREADABLE" });
  }

  // ── 1. Load full expert record ─────────────────────────────────────────────
  const [fullExpert] = await db
    .select()
    .from(architectureProfiles)
    .where(
      and(
        eq(architectureProfiles.id, expert.id),
        eq(architectureProfiles.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!fullExpert) throw new Error("Expert not found during chat execution.");

  // ── 2. Build prompt (reuse existing prompt builder) ────────────────────────
  const { buildExpertPromptFromSnapshot, buildExpertPrompt } = await import(
    "../lib/ai/expert-prompt-builder"
  );

  let builtPrompt: Awaited<ReturnType<typeof buildExpertPromptFromSnapshot>>;

  // Prefer live version snapshot — same behavior as /api/experts/:id/test
  const targetVersionId = fullExpert.currentVersionId;

  if (targetVersionId) {
    const [version] = await db
      .select()
      .from(expertVersions)
      .where(
        and(
          eq(expertVersions.id, targetVersionId),
          eq(expertVersions.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (version) {
      builtPrompt = buildExpertPromptFromSnapshot(version.configJson as any);
    } else {
      builtPrompt = await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
    }
  } else {
    builtPrompt = await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
  }

  // ── 3. Kør AI-kald ────────────────────────────────────────────────────────
  const { runRetrieval } = await import("../lib/retrieval/retrieval-orchestrator");

  let aiText: string;
  let aiLatencyMs: number;

  if (docCtx.length > 0) {
    // ── DOKUMENT-MODE: Chat Completions API med messages-array ────────────────
    // Bypasser runAiCall (som bruger Responses API — understøtter ikke messages-array).
    // Følger præcist samme flow som api/_src/chat.ts (Vercel-stien).
    const { getOpenAIClient } = await import("../lib/openai-client");
    const oai = getOpenAIClient();

    const totalChars = docCtx.reduce((s, d) => s + d.extracted_text.length, 0);
    console.log(`[chat-runner] DOC_MODE: doc_ctx_ok=${docCtx.length} total_doc_chars=${totalChars}`);
    console.log(`[chat-runner] first200="${docCtx[0].extracted_text.slice(0, 200).replace(/\n/g, " ")}"`);

    // TASK 4 — STRICT document-only system prompt (ERSTATTER expert-prompt)
    const docSystemPrompt = [
      `Du er en AI-ekspert ved navn ${expert.name}.`,
      `Du har modtaget et uploadet dokument, som brugeren ønsker analyseret.`,
      ``,
      `=== ABSOLUT BINDENDE REGLER FOR DOKUMENTANALYSE ===`,
      `REGEL 1: Du MÅ KUN besvare spørgsmål ud fra det uploadede dokumentindhold.`,
      `REGEL 2: Du MÅ ALDRIG bruge generel viden, uddannelsesdata eller externa kilder.`,
      `REGEL 3: Du MÅ ALDRIG sige at du ikke kan tilgå, åbne eller læse filer.`,
      `REGEL 4: Hvis svaret IKKE fremgår af dokumentet, siger du præcist: "Jeg kan ikke finde det i det uploadede dokument."`,
      `REGEL 5: Hvis svaret fremgår af dokumentet, citerer du den relevante sætning direkte.`,
      `REGEL 6: Du MÅ ALDRIG give generiske forklaringer eller bred kontekst, medmindre det fremgår af dokumentet.`,
      `REGEL 7: Dit svar skal starte med den direkte konklusion, ikke med en forklaring.`,
      `REGEL 8: Du MÅ ALDRIG hallucere tal, navne, datoer eller klausuler der ikke er i dokumentet.`,
      `=== SLUT REGLER ===`,
      ``,
      `Svar altid på dansk.`,
    ].join("\n");

    // TASK 3 — dokument som separat user-besked (højest prioritet)
    const docBlock = docCtx.map(d =>
      `FILNAVN: ${d.filename}\nTEGN: ${d.extracted_text.length}\n\n${d.extracted_text}`
    ).join("\n\n---\n\n");

    const messagesPayload = [
      { role: "system" as const, content: docSystemPrompt },
      {
        role: "user" as const,
        content: `=== DOKUMENTINDHOLD START ===\n\n${docBlock}\n\n=== DOKUMENTINDHOLD SLUT ===\n\nOvenstående er det komplette ekstraherede indhold fra det uploadede dokument. Brug dette som eneste kilde.`,
      },
      {
        role: "assistant" as const,
        content: "Jeg har læst dokumentet fuldt ud og forstår indholdet. Jeg er klar til at besvare spørgsmål udelukkende baseret på det faktiske dokumentindhold.",
      },
      { role: "user" as const, content: message },
    ];

    const totalPromptChars = messagesPayload.reduce((s, m) => s + m.content.length, 0);
    console.log(`[chat-runner] PAYLOAD_READY: messages=${messagesPayload.length} total_chars=${totalPromptChars} doc_in_payload=true`);

    // Hard assertion: bekræft dokument er i payload
    const docInPayload = messagesPayload[1].content.includes("=== DOKUMENTINDHOLD START ===");
    if (!docInPayload) {
      throw Object.assign(
        new Error("DOCUMENT_CONTEXT_NOT_INJECTED"),
        { errorCode: "DOCUMENT_CONTEXT_NOT_INJECTED" },
      );
    }

    const docModel = AI_MODEL_ROUTES.default.model;
    console.log(`[ai:router] model=${docModel} provider=${AI_MODEL_ROUTES.default.provider} key=default use_case=doc_mode`);
    const t0 = Date.now();
    const completion = await oai.chat.completions.create({
      model: docModel,
      temperature: 0.1,
      max_tokens: 2000,
      messages: messagesPayload,
    });
    aiLatencyMs = Date.now() - t0;
    aiText = completion.choices[0]?.message?.content ?? "";

    console.log(`[chat-runner] DOC_ANSWER_LEN=${aiText.length} latency=${aiLatencyMs}ms`);
    console.log(`[chat-runner] DOC_ANSWER_PREVIEW="${aiText.slice(0, 200).replace(/\n/g, " ")}"`);

    // TASK 5 — grounding-validering
    if (aiText) {
      aiText = validateDocumentGrounding(aiText, docCtx[0].extracted_text);
    }

    if (!aiText) {
      throw Object.assign(
        new Error("AI returnerede tomt svar i dokument-mode"),
        { errorCode: "AI_EMPTY_RESPONSE" },
      );
    }
  } else {
    // ── NORMAL MODE: runAiCall via Responses API ──────────────────────────────
    const { runAiCall } = await import("../lib/ai/runner");
    // Use the caller-supplied useCase; default to "grounded_chat" for backward compat.
    // Non-grounded use cases (validation/analysis/classification) bypass the docCtx gate.
    const resolvedUseCase = params.useCase ?? "grounded_chat";
    console.log(`[chat-runner] NORMAL_MODE useCase=${resolvedUseCase}`);
    const t0 = Date.now();
    const aiResult = await runAiCall(
      { feature: "ai-chat", useCase: resolvedUseCase, tenantId: organizationId, userId },
      { systemPrompt: builtPrompt.systemPrompt, userInput: message },
    );
    aiLatencyMs = Date.now() - t0;
    aiText = aiResult.text;
  }

  const [, retrievalResult] = await Promise.all([
    Promise.resolve(),
    runRetrieval({ tenantId: organizationId, queryText: message, strategy: "hybrid", topK: 5 }).catch(
      () => null,
    ),
  ]);

  // ── 4. Map sources ─────────────────────────────────────────────────────────
  const metadataSources = builtPrompt.usedSources.map((s) => ({
    id: s.id,
    name: s.sourceName,
    sourceType: s.sourceType,
  }));

  const retrievedSources = (retrievalResult?.results ?? []).map((r) => ({
    id: r.chunkId,
    name: `Hentet kilde (relevans: ${(r.scoreCombined * 100).toFixed(0)}%)`,
    sourceType: "retrieved",
  }));

  const usedSources = metadataSources.length > 0 ? metadataSources : retrievedSources;

  // ── 5. Map rules (user-safe — only name, no enforcement internals) ─────────
  const usedRules = builtPrompt.usedRules.map((r) => ({
    id: r.id,
    title: r.name,
  }));

  // ── 6. Warnings ────────────────────────────────────────────────────────────
  const warnings: string[] = [];
  if (retrievalResult && !retrievalResult.success) {
    warnings.push("Kildegenfinding utilgængelig — svar baseret på ekspertens regler og instruktioner.");
  }

  // ── 7. Confidence band ─────────────────────────────────────────────────────
  // Dokument-mode: "high" kun hvis svaret refererer til faktisk dokumentindhold
  const confidenceBand = docCtx.length > 0
    ? deriveDocumentConfidence(aiText, docCtx.map(d => d.extracted_text).join(" "))
    : deriveConfidenceBand(usedSources.length, usedRules.length, warnings);
  const needsManualReview = warnings.length > 0 || confidenceBand === "low";

  // ── 8. Persist conversation + messages ────────────────────────────────────
  const conversationId = await persistChatTurn({
    organizationId,
    userId,
    expertId: expert.id,
    message,
    answer: aiText,
    usedSources,
    usedRules,
    warnings,
    latencyMs: aiLatencyMs,
    confidenceBand,
    existingConversationId: params.conversationId ?? null,
  });

  // ── Storage 1.6: Check if we should fetch similar cases ────────────────────
  // Keywords that trigger similar case lookup (dansk + engelsk):
  // "lignende", "sager", "cases", "eksempler", "examples", "relateret", "related"
  const similarKeywords = /(\blignende\b|\bsager\b|\bcases\b|\beksempler\b|\bexamples\b|\brelateret\b|\brelated\b)/i;
  const shouldFetchSimilar = similarKeywords.test(message);

  let similarCases: SimilarCaseInResponse[] = [];
  let totalSimilarCases: number | undefined;

  if (shouldFetchSimilar) {
    try {
      const { findSimilarCases } = await import("../lib/knowledge/kb-similar");
      const similarResult = await findSimilarCases({
        tenantId: organizationId,
        mode: "text",
        queryText: message,
        expertId: expert.id,
        topK: 5,
      });
      similarCases = similarResult.cases.map(c => ({
        chunkId:        c.chunkId,
        score:          c.score,
        snippet:        c.snippet,
        sourceLabel:    c.sourceLabel,
        assetId:        c.assetId,
        assetVersionId: c.assetVersionId,
        assetTitle:     c.assetTitle,
        assetType:      c.assetType,
        kbId:           c.kbId,
        kbName:         c.kbName,
        whyMatched:     c.whyMatched,
        pageNumber:     c.pageNumber,
        timestampSec:   c.timestampSec,
      }));
      totalSimilarCases = similarResult.total;
      if (similarCases.length > 0) {
        console.log(`[chat-runner] found_similar_cases=${similarCases.length} for query="${message.slice(0, 100)}"`);
      }
    } catch (err) {
      console.warn(`[chat-runner] similar_cases_fetch_error:`, err instanceof Error ? err.message : String(err));
      // Silent fail — don't disrupt chat if similarity lookup fails
    }
  }

  const result: ChatRunResult = {
    answer: aiText,
    conversationId,
    expert: {
      id: expert.id,
      name: expert.name,
      category: expert.category,
    },
    usedSources,
    usedRules,
    warnings,
    latencyMs: aiLatencyMs,
    confidenceBand,
    needsManualReview,
    routingExplanation,
  };

  // Include similar cases only if found
  if (similarCases.length > 0) {
    result.similarCases = similarCases;
    result.totalSimilarCases = totalSimilarCases ?? 0;
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * TASK 5 — Grounding-validering.
 * Tjekker om modellens svar er forankret i det faktiske dokumentindhold.
 * Afviser generiske svar der ikke refererer til dokumentet.
 */
function validateDocumentGrounding(answer: string, extractedText: string): string {
  if (!answer) return answer;

  const lowerAnswer = answer.toLowerCase();
  const lowerDoc    = extractedText.toLowerCase();

  // 1. Ingen grounding nødvendig hvis svaret eksplicit siger "ikke i dokumentet"
  const notFoundPhrases = [
    "kan ikke finde",
    "fremgår ikke",
    "ikke i det uploadede",
    "ikke nævnt",
    "ikke specificeret",
    "ikke angivet",
    "fremkommer ikke",
  ];
  if (notFoundPhrases.some(p => lowerAnswer.includes(p))) {
    console.log("[chat-runner] GROUNDING: svaret angiver 'ikke fundet' — accepteret");
    return answer;
  }

  // 2. Tjek om svaret indeholder ord/tal der faktisk er i dokumentet (n-gram overlap)
  const answerWords = lowerAnswer
    .replace(/[^a-zæøå0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4);

  const docWords = new Set(
    lowerDoc.replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4)
  );

  const matchingWords = answerWords.filter(w => docWords.has(w));
  const overlapRatio  = answerWords.length > 0 ? matchingWords.length / answerWords.length : 0;

  console.log(`[chat-runner] GROUNDING: overlap=${(overlapRatio * 100).toFixed(0)}% matching=${matchingWords.length}/${answerWords.length}`);

  // 3. Afvis svar med < 15% overlap (er sandsynligvis generisk viden)
  if (overlapRatio < 0.15 && answerWords.length > 10) {
    console.warn(`[chat-runner] GROUNDING_FAILED: overlap=${(overlapRatio * 100).toFixed(0)}% — erstat med safe response`);
    return "Jeg kan ikke finde det sikkert i det uploadede dokument.";
  }

  return answer;
}

/**
 * Bestem confidence for dokument-mode svar.
 */
function deriveDocumentConfidence(answer: string, extractedText: string): ConfidenceBand {
  if (!answer) return "unknown";

  const notFoundPhrases = ["kan ikke finde", "fremgår ikke", "ikke i det uploadede"];
  if (notFoundPhrases.some(p => answer.toLowerCase().includes(p))) return "low";

  const lowerAnswer = answer.toLowerCase();
  const lowerDoc    = extractedText.toLowerCase();
  const answerWords = lowerAnswer.replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4);
  const docWords    = new Set(lowerDoc.replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4));
  const matchingWords = answerWords.filter(w => docWords.has(w));
  const overlapRatio  = answerWords.length > 0 ? matchingWords.length / answerWords.length : 0;

  if (overlapRatio >= 0.4) return "high";
  if (overlapRatio >= 0.2) return "medium";
  return "low";
}

async function buildFromLive(
  expert: typeof architectureProfiles.$inferSelect,
  organizationId: string,
  buildExpertPrompt: Function,
) {
  const [allRules, allSources] = await Promise.all([
    db
      .select()
      .from(specialistRules)
      .where(and(eq(specialistRules.expertId, expert.id), eq(specialistRules.organizationId, organizationId))),
    db
      .select()
      .from(specialistSources)
      .where(
        and(eq(specialistSources.expertId, expert.id), eq(specialistSources.organizationId, organizationId)),
      ),
  ]);

  return buildExpertPrompt(
    {
      name: expert.name,
      goal: expert.goal ?? null,
      instructions: expert.instructions ?? null,
      outputStyle: expert.outputStyle ?? null,
      language: expert.language ?? "da",
      modelProvider: expert.modelProvider ?? "openai",
      modelName: expert.modelName ?? "gpt-4o",
      temperature: expert.temperature ?? 0.3,
      maxOutputTokens: expert.maxOutputTokens ?? 2048,
    },
    allRules.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description ?? null,
      priority: r.priority,
      enforcementLevel: r.enforcementLevel,
    })),
    allSources.map((s) => ({
      id: s.id,
      sourceName: s.sourceName,
      sourceType: s.sourceType,
      status: s.status,
    })),
  );
}

function deriveConfidenceBand(
  sourceCount: number,
  ruleCount: number,
  warnings: string[],
): ConfidenceBand {
  if (warnings.length > 0) return "low";
  if (sourceCount === 0 && ruleCount === 0) return "unknown";
  if (sourceCount >= 2 || ruleCount >= 2) return "high";
  return "medium";
}

async function persistChatTurn(params: {
  organizationId: string;
  userId: string;
  expertId: string;
  message: string;
  answer: string;
  usedSources: Array<{ id: string; name: string }>;
  usedRules: Array<{ id: string; title: string }>;
  warnings: string[];
  latencyMs: number;
  confidenceBand: ConfidenceBand;
  existingConversationId: string | null;
}): Promise<string> {
  const {
    organizationId,
    userId,
    expertId,
    message,
    answer,
    usedSources,
    usedRules,
    warnings,
    latencyMs,
    confidenceBand,
    existingConversationId,
  } = params;

  let convId = existingConversationId;

  if (!convId) {
    const [conv] = await db
      .insert(chatConversations)
      .values({
        organizationId,
        createdBy: userId,
        selectedExpertId: expertId,
        title: message.slice(0, 80),
      })
      .returning({ id: chatConversations.id });
    convId = conv.id;
  }

  await db.insert(chatMessages).values([
    {
      conversationId: convId,
      organizationId,
      role: "user",
      messageText: message,
    },
    {
      conversationId: convId,
      organizationId,
      role: "assistant",
      messageText: answer,
      expertId: expertId as string,
      metadata: { usedSources, usedRules, warnings, latencyMs, confidenceBand } as any,
    },
  ]);

  return convId;
}
