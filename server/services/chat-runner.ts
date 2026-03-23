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

export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

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

  // ── 3. Byg det endelige user-input (dokument-kontekst INJICERET) ───────────
  let finalUserInput = message;
  let finalSystemPrompt = builtPrompt.systemPrompt;

  if (docCtx.length > 0) {
    // TASK 6 — hard system-prompt-tilføjelse: forbyd "kan ikke tilgå filer"
    const docSystemAddition = [
      "",
      "=== KRITISK INSTRUKTION — DOKUMENTANALYSE ===",
      "Du har ALTID adgang til det fulde dokumentindhold nedenfor i bruger-inputtet.",
      "Du MÅ ALDRIG sige at du ikke kan åbne, tilgå eller læse vedhæftede filer.",
      "Du SKAL analysere dokumentets faktiske indhold direkte.",
      "Du SKAL referere til konkrete sætninger, klausuler, tal og navne fra dokumentet.",
      "Hvis det efterspurgte ikke er i dokumentet, skal du sige: 'Det fremgår ikke af det uploadede dokument.'",
      "Du MÅ ALDRIG give generiske råd eller tjeklister i stedet for faktisk dokumentanalyse.",
      "=== SLUT KRITISK INSTRUKTION ===",
    ].join("\n");

    finalSystemPrompt = builtPrompt.systemPrompt + docSystemAddition;

    // TASK 2 — force document content direkte ind i user-input
    const docBlock = docCtx.map(d =>
      `=== DOKUMENTINDHOLD START: ${d.filename} (${d.extracted_text.length} tegn) ===\n\n${d.extracted_text}\n\n=== DOKUMENTINDHOLD SLUT: ${d.filename} ===`
    ).join("\n\n");

    finalUserInput = `${message}\n\n${docBlock}`;

    const totalChars = docCtx.reduce((s, d) => s + d.extracted_text.length, 0);
    console.log(`[chat-runner] PAYLOAD_READY: userInput_len=${finalUserInput.length} doc_chars=${totalChars} systemPrompt_len=${finalSystemPrompt.length}`);
  }

  // TASK 5 — hard assertion FØR model-kald
  if (docCtx.length > 0) {
    if (!finalUserInput.includes("=== DOKUMENTINDHOLD START:")) {
      throw Object.assign(
        new Error("DOCUMENT_CONTEXT_NOT_INJECTED: Document text not found in final payload"),
        { errorCode: "DOCUMENT_CONTEXT_NOT_INJECTED" },
      );
    }
  }

  // ── 3. Run AI + retrieval i parallel ─────────────────────────────────────
  const { runAiCall } = await import("../lib/ai/runner");
  const { runRetrieval } = await import("../lib/retrieval/retrieval-orchestrator");

  const [aiResult, retrievalResult] = await Promise.all([
    runAiCall(
      { feature: "ai-chat", tenantId: organizationId, userId },
      { systemPrompt: finalSystemPrompt, userInput: finalUserInput },
    ),
    runRetrieval({ tenantId: organizationId, queryText: message, strategy: "hybrid", topK: 5 }).catch(
      () => null,
    ),
  ]);

  const latencyMs = Date.now() - startMs;

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

  // ── 7. Confidence band (truthful only — never fabricated) ─────────────────
  const confidenceBand = deriveConfidenceBand(usedSources.length, usedRules.length, warnings);
  const needsManualReview = warnings.length > 0 || confidenceBand === "low";

  // ── 8. Persist conversation + messages ────────────────────────────────────
  const conversationId = await persistChatTurn({
    organizationId,
    userId,
    expertId: expert.id,
    message,
    answer: aiResult.text,
    usedSources,
    usedRules,
    warnings,
    latencyMs,
    confidenceBand,
    existingConversationId: params.conversationId ?? null,
  });

  return {
    answer: aiResult.text,
    conversationId,
    expert: {
      id: expert.id,
      name: expert.name,
      category: expert.category,
    },
    usedSources,
    usedRules,
    warnings,
    latencyMs,
    confidenceBand,
    needsManualReview,
    routingExplanation,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
