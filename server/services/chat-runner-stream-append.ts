
// ─── Streaming variant ────────────────────────────────────────────────────────
/**
 * runChatMessageStream — same as runChatMessage but streams tokens via onToken callback.
 * Only the doc-mode AI call is streamed. Normal mode sends full text as single burst.
 * After all tokens are sent, calls onDone with the full ChatRunResult.
 */
export async function runChatMessageStream(
  params: {
    message: string;
    expert: AccessibleExpert;
    organizationId: string;
    userId: string;
    conversationId?: string | null;
    routingExplanation: string;
    documentContext?: DocumentContextItem[];
    useCase?: import("../lib/ai/types").AiUseCase;
  },
  callbacks: {
    onToken: (token: string) => void;
    onDone: (result: ChatRunResult) => void;
    onError: (err: Error) => void;
  },
): Promise<void> {
  const { message, expert, organizationId, userId, routingExplanation } = params;

  const rawDocCtx  = params.documentContext ?? [];
  const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
  const failedDocs = rawDocCtx.filter(d => d.status !== "ok");

  console.log(`[chat-runner:stream] message_len=${message.length} doc_ctx_raw=${rawDocCtx.length} doc_ctx_ok=${docCtx.length}`);

  if (rawDocCtx.length > 0 && docCtx.length === 0) {
    const reason = failedDocs.map(d => d.message).filter(Boolean).join("; ") || "Ingen tekst kunne udtrækkes";
    callbacks.onError(Object.assign(new Error(reason), { errorCode: "DOCUMENT_UNREADABLE" }));
    return;
  }

  // ── 1. Load full expert record ─────────────────────────────────────────────
  const [fullExpert] = await db
    .select()
    .from(architectureProfiles)
    .where(and(eq(architectureProfiles.id, expert.id), eq(architectureProfiles.organizationId, organizationId)))
    .limit(1);
  if (!fullExpert) { callbacks.onError(new Error("Expert not found.")); return; }

  // ── 2. Build prompt ────────────────────────────────────────────────────────
  const { buildExpertPromptFromSnapshot, buildExpertPrompt } = await import("../lib/ai/expert-prompt-builder");
  let builtPrompt: Awaited<ReturnType<typeof buildExpertPromptFromSnapshot>>;
  const targetVersionId = fullExpert.currentVersionId;
  if (targetVersionId) {
    const [version] = await db
      .select()
      .from(expertVersions)
      .where(and(eq(expertVersions.id, targetVersionId), eq(expertVersions.organizationId, organizationId)))
      .limit(1);
    builtPrompt = version
      ? buildExpertPromptFromSnapshot(version.configJson as any)
      : await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
  } else {
    builtPrompt = await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
  }

  // ── 3. AI call (streaming for doc mode) ───────────────────────────────────
  let aiText = "";
  let aiLatencyMs = 0;

  try {
    if (docCtx.length > 0) {
      const { getOpenAIClient } = await import("../lib/openai-client");
      const oai = getOpenAIClient();

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

      const docModel = AI_MODEL_ROUTES.default.model;
      const t0 = Date.now();

      const stream = await oai.chat.completions.create({
        model: docModel,
        temperature: 0.1,
        max_tokens: 2000,
        stream: true,
        messages: messagesPayload,
      });

      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? "";
        if (token) {
          aiText += token;
          callbacks.onToken(token);
        }
      }
      aiLatencyMs = Date.now() - t0;
      console.log(`[chat-runner:stream] DOC_ANSWER_LEN=${aiText.length} latency=${aiLatencyMs}ms`);

      if (aiText) aiText = validateDocumentGrounding(aiText, docCtx[0].extracted_text);
      if (!aiText) {
        callbacks.onError(Object.assign(new Error("AI returnerede tomt svar"), { errorCode: "AI_EMPTY_RESPONSE" }));
        return;
      }
    } else {
      // Normal mode — no streaming support in runAiCall, send as single burst
      const { runAiCall } = await import("../lib/ai/runner");
      const resolvedUseCase = params.useCase ?? "grounded_chat";
      const t0 = Date.now();
      const aiResult = await runAiCall(
        { feature: "ai-chat", useCase: resolvedUseCase, tenantId: organizationId, userId },
        { systemPrompt: builtPrompt.systemPrompt, userInput: message },
      );
      aiLatencyMs = Date.now() - t0;
      aiText = aiResult.text;
      if (aiText) callbacks.onToken(aiText);
    }
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  // ── 4–8. Retrieval, sources, rules, confidence, persist ───────────────────
  const { runRetrieval } = await import("../lib/retrieval/retrieval-orchestrator");
  const [, retrievalResult] = await Promise.all([
    Promise.resolve(),
    runRetrieval({ tenantId: organizationId, queryText: message, strategy: "hybrid", topK: 5 }).catch(() => null),
  ]);

  const metadataSources = builtPrompt.usedSources.map(s => ({ id: s.id, name: s.sourceName, sourceType: s.sourceType }));
  const retrievedSources = (retrievalResult?.results ?? []).map(r => ({
    id: r.chunkId,
    name: `Hentet kilde (relevans: ${(r.scoreCombined * 100).toFixed(0)}%)`,
    sourceType: "retrieved",
  }));
  const usedSources = metadataSources.length > 0 ? metadataSources : retrievedSources;
  const usedRules = builtPrompt.usedRules.map(r => ({ id: r.id, title: r.name }));
  const warnings: string[] = [];
  if (retrievalResult && !retrievalResult.success) {
    warnings.push("Kildegenfinding utilgængelig — svar baseret på ekspertens regler og instruktioner.");
  }
  const confidenceBand = docCtx.length > 0
    ? deriveDocumentConfidence(aiText, docCtx.map(d => d.extracted_text).join(" "))
    : deriveConfidenceBand(usedSources.length, usedRules.length, warnings);
  const needsManualReview = warnings.length > 0 || confidenceBand === "low";

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

  const result: ChatRunResult = {
    answer: aiText,
    conversationId,
    expert: { id: expert.id, name: expert.name, category: expert.category },
    usedSources,
    usedRules,
    warnings,
    latencyMs: aiLatencyMs,
    confidenceBand,
    needsManualReview,
    routingExplanation,
    similarCasesAttempted: false,
    similarCasesStatusCode: "not_triggered",
  };

  callbacks.onDone(result);
}
