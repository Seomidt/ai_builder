/**
 * chat-runner.ts — Thin adapter that reuses existing expert orchestration for AI Chat.
 *
 * Does NOT rebuild prompt-building, runAiCall, or rule engine.
 * Simply calls the same functions the /api/experts/:id/test endpoint uses,
 * and maps the result into a chat-safe response shape.
 */

import { db } from "../db.ts";
import {
  architectureProfiles,
  specialistRules,
  specialistSources,
  expertVersions,
  chatConversations,
  chatMessages,
} from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import type { AccessibleExpert } from "./chat-routing.ts";
import { AI_MODEL_ROUTES } from "../lib/ai/config.ts";
import { applyPartialSafeguard, isDefinitiveNegative } from "../lib/chat/partial-safeguard.ts";
import {
  shouldRunSimilarity,
  shouldAllowSimilarityByBudget,
  similarityCache,
  similarityRateLimiter,
  logSimilarityEvent,
  type SimilarCasesStatusCode,
  type WhyMatchedCode,
  type SimilarConfidenceCode,
} from "../lib/knowledge/similarity-control";

export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

type ChatComplexity = "nano" | "default" | "heavy";

function classifyChatComplexity(
  message: string,
  docChars: number,
  isPartialOcr: boolean,
): { tier: ChatComplexity; reason: string } {
  const msg = message.trim();
  const msgLen = msg.length;

  const GREETING_PATTERNS = [
    /^(hej|hey|hi|hello|godmorgen|goddag|tak|thanks)\s*[!.?]?\s*$/i,
    /^hvad kan du\b/i,
    /^hvem er du\b/i,
    /^test\s*$/i,
  ];
  if (msgLen < 60 && docChars === 0 && GREETING_PATTERNS.some(p => p.test(msg))) {
    return { tier: "nano", reason: "greeting_or_trivial" };
  }

  if (docChars === 0 && msgLen < 120) {
    const SIMPLE_SIGNALS = [
      /^(forklar|hvad (er|betyder)|definer)\b/i,
      /^(oversæt|skriv)\b/i,
    ];
    if (SIMPLE_SIGNALS.some(p => p.test(msg))) {
      return { tier: "nano", reason: "short_simple_no_doc" };
    }
  }

  if (docChars > 20_000) {
    return { tier: "heavy", reason: `large_doc_${docChars}_chars` };
  }

  const COMPLEX_SIGNALS = [
    /\bsammenl?ign\b/i,
    /\brisikovurdering\b/i,
    /\banalyse[rn]?\b/i,
    /\bopsummer\b.*\bog\b.*\bvurder\b/i,
    /\bstyrker\b.*\bsvagheder\b/i,
    /\bfordele\b.*\bulemper\b/i,
    /\bgennemgå\b.*\bhelt?\b/i,
    /\bkontraktgennemgang\b/i,
    /\bdue diligence\b/i,
    /\bjuridisk\b/i,
  ];
  if (docChars > 5_000 && COMPLEX_SIGNALS.some(p => p.test(msg))) {
    return { tier: "heavy", reason: "complex_analysis_with_doc" };
  }

  const questionMarks = (msg.match(/\?/g) || []).length;
  if (docChars > 5_000 && questionMarks >= 3) {
    return { tier: "heavy", reason: "multi_question_with_doc" };
  }

  return { tier: "default", reason: "standard" };
}

function resolveModelForTier(tier: ChatComplexity): { model: string; provider: string; key: string } {
  const route = tier === "heavy" ? AI_MODEL_ROUTES.heavy
    : tier === "nano" ? AI_MODEL_ROUTES.nano
    : AI_MODEL_ROUTES.default;
  return { model: route.model, provider: route.provider, key: tier };
}

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
  whyMatchedCode:   WhyMatchedCode;
  confidenceCode:   SimilarConfidenceCode;
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
  
  // Storage 1.6–1.7: similar cases from knowledge bases
  similarCasesAttempted:  boolean;
  similarCasesStatusCode: SimilarCasesStatusCode;
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
  source?:        string;
  vision_images?: string[];
}

// Virtual expert used when routing is attachment_first with no available experts.
const VIRTUAL_ATTACHMENT_EXPERT: AccessibleExpert = {
  id:            "__virtual_attachment__",
  name:          "Dokumentanalytiker",
  description:   "Automatisk dokumentanalyse",
  category:      "document",
  routingHints:  null,
  departmentId:  null,
  enabledForChat: true,
};

export async function runChatMessage(params: {
  message: string;
  /** null allowed for attachment_first routing when no experts are configured. */
  expert: AccessibleExpert | null;
  organizationId: string;
  userId: string;
  conversationId?: string | null;
  routingExplanation: string;
  documentContext?: DocumentContextItem[];
  routeType?: string;
  useCase?: import("../lib/ai/types").AiUseCase;
  /** SSE streaming callback — when provided, AI call uses stream=true and calls this per token */
  onToken?: (delta: string) => void;
  /** Called when partial-safeguard triggers AFTER streaming — client must replace streamed content */
  onSafeguardReplace?: (replacementText: string) => void;
}): Promise<ChatRunResult> {
  const expert = params.expert ?? VIRTUAL_ATTACHMENT_EXPERT;
  const { message, organizationId, userId, routingExplanation } = params;
  const startMs = Date.now();

  // ── Document context validation + injection ────────────────────────────────
  const rawDocCtx  = params.documentContext ?? [];

  // ── VISION PREVIEW: scanned PDF pages as base64 images → Gemini multimodal ──
  // Must be checked BEFORE docCtx filter (vision docs have empty extracted_text).
  const MAX_VISION_IMAGES   = 5;
  const MAX_VISION_IMG_BYTES = 2_000_000;
  const visionDocs = rawDocCtx.filter((d: any) => {
    if (d.status !== "ok" || !d.vision_images || d.vision_images.length === 0) return false;
    d.vision_images = (d.vision_images as string[])
      .slice(0, MAX_VISION_IMAGES)
      .filter((img: string) => typeof img === "string" && img.length <= MAX_VISION_IMG_BYTES);
    return d.vision_images.length > 0;
  });

  if (visionDocs.length > 0 && params.onToken) {
    const allImages   = visionDocs.flatMap((d: any) => d.vision_images as string[]);
    const filename    = visionDocs[0]?.filename ?? "dokument";
    const onToken     = params.onToken;
    const startVision = Date.now();

    console.log(`[chat-runner] SCANNED_PREVIEW_START preview_pages_used=${allImages.length} preview_prompt_type=vision_pdf_preview preview_answer_mode=document_only file="${filename}"`);

    const visionSystemPrompt = [
      `Du er en dokumentanalytiker. Du modtager billeder af sider fra en PDF-fil.`,
      ``,
      `=== ABSOLUTTE REGLER FOR VISUEL DOKUMENTANALYSE ===`,
      `REGEL 1: Du MÅ KUN besvare spørgsmål baseret på det du kan SE i de vedhæftede sidebilleder.`,
      `REGEL 2: Kig grundigt på ALLE vedhæftede sidebilleder før du svarer.`,
      `REGEL 3: Hvis svaret er synligt i billederne, citér det direkte og præcist.`,
      `REGEL 4: Hvis kun DELE af spørgsmålet kan besvares fra de synlige sider, besvar den del du kan se, og sig eksplicit: "Resten fremgår ikke af de viste sider — det fulde svar kommer når hele dokumentet er behandlet."`,
      `REGEL 5: Hvis INTET i billederne besvarer spørgsmålet, sig: "Jeg kan ikke se svaret i de viste sider. Det fulde svar kommer når hele dokumentet er behandlet."`,
      `REGEL 6: Du MÅ ALDRIG nævne "interne data", "vidensbase", "knowledge base", "virksomhedens data" eller lignende. Du kigger KUN på sidebilleder.`,
      `REGEL 7: Du MÅ ALDRIG hallucere tal, navne, datoer, priser eller klausuler der ikke er synlige i billederne.`,
      `REGEL 8: Start dit svar med den direkte konklusion fra billederne. Ingen indledende forklaringer.`,
      `REGEL 9: Dette er et PREVIEW-svar baseret på de første sider. Nævn kort at det fulde dokument stadig behandles, hvis du ikke kan besvare alt.`,
      `=== SLUT REGLER ===`,
      ``,
      `Svar altid på dansk.`,
    ].join("\n");

    const visionUserMessage = [
      `Herunder ser du ${allImages.length} side${allImages.length > 1 ? "r" : ""} fra PDF-filen "${filename}".`,
      `Kig grundigt på alle sidebilleder og besvar følgende spørgsmål:`,
      ``,
      message,
    ].join("\n");

    let fullVisionAnswer = "";
    try {
      const { streamGeminiVisionChat } = await import("../lib/ai/gemini-media");
      console.log(`[chat-runner] VISION_CALL_START model=gemini-2.0-flash images=${allImages.length}`);
      for await (const delta of streamGeminiVisionChat(visionSystemPrompt, visionUserMessage, allImages)) {
        fullVisionAnswer += delta;
        onToken(delta);
      }
      const latencyMs = Date.now() - startVision;
      const LEAK_PHRASES = ["interne data", "vidensbase", "knowledge base", "virksomhedens data"];
      const lower = fullVisionAnswer.toLowerCase();
      const leaked = LEAK_PHRASES.find(p => lower.includes(p));
      const isPartial = lower.includes("viste sider") || lower.includes("hele dokumentet");
      if (leaked) {
        console.error(`[chat-runner] PREVIEW_PROMPT_LEAK detected="${leaked}" answer_len=${fullVisionAnswer.length}`);
      }
      console.log(`[chat-runner] SCANNED_PREVIEW_DONE preview_partial_answer=${isPartial} answer_len=${fullVisionAnswer.length} latencyMs=${latencyMs} model=gemini-2.0-flash`);
      return {
        answer:        fullVisionAnswer,
        answerSource:  "vision_preview_pdf",
        latencyMs,
        model:         "gemini-2.0-flash",
        provider:      "google",
        routeType:     params.routeType ?? "document_chat",
        refinementGeneration: 1,
        answerCompleteness:   "partial",
        coveragePercent:      0,
        conversationId:       params.conversationId ?? null,
      } as any;
    } catch (visionErr: any) {
      console.error(`[chat-runner] VISION_CALL_FAILED: ${visionErr?.message} — falling through to normal path`);
      // Fall through to normal text-based path on vision failure
    }
  }

  const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
  const failedDocs = rawDocCtx.filter(d => d.status !== "ok");

  // Partial OCR mode: document_context contains source:"ocr_partial" → only first page available.
  // Must NOT generate definitive negative conclusions ("kan ikke finde").
  const isPartialOcr = rawDocCtx.some(d => (d as any).source === "ocr_partial");

  console.log(`[chat-runner] routeType=${params.routeType ?? "legacy"} message_len=${message.length} doc_ctx_ok=${docCtx.length}`);
  if (docCtx.length > 0) {
    const totalChars = docCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0);
    console.log(`[chat-runner] total_doc_chars=${totalChars} first200="${docCtx[0].extracted_text.slice(0, 200).replace(/\n/g, " ")}"`);
  }
  if (failedDocs.length > 0) {
    console.warn(`[chat-runner] failed_docs:`, failedDocs.map(d => `${d.filename}:${d.status}:${d.message}`).join(", "));
  }

  // Only throw if caller explicitly passed attachments that all failed (request-level docs)
  // Do NOT throw for stored attachments from DB (they come pre-filtered as valid).
  if (rawDocCtx.length > 0 && docCtx.length === 0 && failedDocs.length > 0) {
    const reason = failedDocs.map(d => d.message).filter(Boolean).join("; ")
      || "Ingen tekst kunne udtrækkes";
    throw Object.assign(new Error(reason), { errorCode: "DOCUMENT_UNREADABLE" });
  }

  // ── 1. Load full expert record ─────────────────────────────────────────────
  // Virtual expert (attachment_first with no configured experts) skips DB lookup.
  const isVirtualExpert = expert.id === "__virtual_attachment__";

  const { buildExpertPromptFromSnapshot, buildExpertPrompt } = await import(
    "../lib/ai/expert-prompt-builder"
  );

  let builtPrompt: Awaited<ReturnType<typeof buildExpertPromptFromSnapshot>>;

  if (isVirtualExpert) {
    // Minimal prompt — doc mode will fully override the system prompt anyway.
    builtPrompt = buildExpertPromptFromSnapshot({
      identity: { name: "Dokumentanalytiker", language: "da" },
      ai: {
        goal: "Analyser uploadede dokumenter og besvar spørgsmål baseret på indholdet.",
        instructions: "Svar udelukkende baseret på det uploadede dokument. Svar på dansk.",
        output_style: "Klar, præcis og struktureret.",
      },
      routing:  { managed_by_platform: true },
      rules:    [],
      sources:  [],
      metadata: { rule_count: 0, source_count: 0 },
    });
  } else {
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

      builtPrompt = version
        ? buildExpertPromptFromSnapshot(version.configJson as any)
        : await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
    } else {
      builtPrompt = await buildFromLive(fullExpert, organizationId, buildExpertPrompt);
    }
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

    // ── Fast-context trimming ────────────────────────────────────────────────
    // Fast-path sources (client_fast_pdf, client_fast_text) can produce 50-200k chars.
    // Sending the full text triggers the "heavy" tier (gpt-4.1, TTFT ~40s).
    // We trim to <15k chars using keyword-relevance chunking so the call stays on
    // the default tier (gpt-4.1-mini, TTFT ~2s) with no quality loss for targeted questions.
    // Durable-path sources (r2_direct, ocr_partial, r2_ocr_async) are not trimmed —
    // they are already chunked by the server OCR pipeline.
    const FAST_SOURCES = new Set(["client_fast_pdf", "client_fast_text", "client_fast"]);
    const allFastSource = docCtx.every(d => {
      const src = (d as any).source as string | undefined;
      return !src || FAST_SOURCES.has(src);
    });

    let effectiveDocCtx = docCtx;
    if (allFastSource && totalChars > 14_000) {
      const { selectFastContext } = await import("../lib/chat/fast-context-selector");
      effectiveDocCtx = docCtx.map(d => {
        const result = selectFastContext(d.extracted_text, message, { maxChars: 14_000 });
        console.log(
          `[chat-runner] FAST_TRIM: file="${d.filename}" ` +
          `total=${d.extracted_text.length} → selected=${result.selectedChars} ` +
          `method=${result.method} chunks=${result.chunkCount}/${result.totalChunks} ` +
          `topScore=${result.topScore.toFixed(3)}`,
        );
        return { ...d, extracted_text: result.selectedText };
      });
      const trimmedTotal = effectiveDocCtx.reduce((s, d) => s + d.extracted_text.length, 0);
      console.log(`[chat-runner] FAST_TRIM_TOTAL: ${totalChars} → ${trimmedTotal} chars`);
    } else if (!allFastSource) {
      console.log(`[chat-runner] SKIP_TRIM: durable-path source — keeping full text`);
    } else {
      console.log(`[chat-runner] SKIP_TRIM: total_chars=${totalChars} ≤ 14k — no trim needed`);
    }

    // TASK 4 — STRICT document-only system prompt (ERSTATTER expert-prompt)
    // Two versions: partial OCR (first page only) vs. complete document.
    const docSystemPrompt = isPartialOcr
      ? [
          `Du er en AI-ekspert ved navn ${expert.name}.`,
          `Du har modtaget et uploadet dokument, som brugeren ønsker analyseret.`,
          ``,
          `=== VIGTIG KONTEKST: DELVIS DOKUMENTANALYSE ===`,
          `Kun den FØRSTE DEL af dokumentet er udtrukket endnu. Resten analyseres parallelt og vil følge automatisk.`,
          ``,
          `=== ABSOLUT BINDENDE REGLER FOR DELVIS DOKUMENTANALYSE ===`,
          `REGEL 1: Du MÅ KUN besvare spørgsmål ud fra det uploadede dokumentindhold.`,
          `REGEL 2: Du MÅ ALDRIG bruge generel viden, uddannelsesdata eller externa kilder.`,
          `REGEL 3: Du MÅ ALDRIG sige at du ikke kan tilgå, åbne eller læse filer.`,
          `REGEL 4: Da dokumentet kun er DELVIST tilgængeligt, MÅ DU ALDRIG konkludere endeligt at en information IKKE findes — den kan stå i den del der endnu ikke er behandlet.`,
          `REGEL 5: Giv ALTID et konkret, foreløbigt svar baseret på den tilgængelige tekst. Begynd dit svar med hvad du KAN se i dokumentet.`,
          `REGEL 6: Du MÅ ALDRIG sige at du ikke kan finde noget — skriv i stedet hvad du ser, og at resten af dokumentet analyseres.`,
          `REGEL 7: Du MÅ ALDRIG hallucere tal, navne, datoer eller klausuler der ikke er i dokumentet.`,
          `REGEL 8: Afslut ALTID dit svar med denne linje: "⏳ Baseret på den første del — svaret opdateres automatisk når hele dokumentet er analyseret."`,
          `=== SLUT REGLER ===`,
          ``,
          `Svar altid på dansk.`,
        ].join("\n")
      : [
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
    // effectiveDocCtx er trimmet til <14k chars for fast-path kilder (undgår heavy tier)
    const docBlock = effectiveDocCtx.map(d =>
      `FILNAVN: ${d.filename}\nTEGN: ${d.extracted_text.length}\n\n${d.extracted_text}`
    ).join("\n\n---\n\n");

    const messagesPayload = [
      { role: "system" as const, content: docSystemPrompt },
      {
        role: "user" as const,
        content: isPartialOcr
          ? `=== DELVIST DOKUMENTINDHOLD START ===\n\n${docBlock}\n\n=== DELVIST DOKUMENTINDHOLD SLUT ===\n\nOvenstående er den FØRSTE DEL af det uploadede dokument. Resten af dokumentet analyseres parallelt. Giv foreløbige observationer baseret på den tilgængelige del — undgå endelige konklusioner om hvad dokumentet IKKE indeholder.`
          : `=== DOKUMENTINDHOLD START ===\n\n${docBlock}\n\n=== DOKUMENTINDHOLD SLUT ===\n\nOvenstående er det komplette ekstraherede indhold fra det uploadede dokument. Brug dette som eneste kilde.`,
      },
      {
        role: "assistant" as const,
        content: isPartialOcr
          ? "Jeg har læst den første del af dokumentet. Jeg giver foreløbige observationer baseret på det tilgængelige indhold og undgår endelige konklusioner om information der muligvis er i den resterende del."
          : "Jeg har læst dokumentet fuldt ud og forstår indholdet. Jeg er klar til at besvare spørgsmål udelukkende baseret på det faktiske dokumentindhold.",
      },
      { role: "user" as const, content: message },
    ];

    const totalPromptChars = messagesPayload.reduce((s, m) => s + m.content.length, 0);
    console.log(`[chat-runner] PAYLOAD_READY: messages=${messagesPayload.length} total_chars=${totalPromptChars} doc_in_payload=true`);

    // Hard assertion: bekræft dokument er i payload
    const docInPayload = isPartialOcr
      ? messagesPayload[1].content.includes("=== DELVIST DOKUMENTINDHOLD START ===")
      : messagesPayload[1].content.includes("=== DOKUMENTINDHOLD START ===");
    if (!docInPayload) {
      throw Object.assign(
        new Error("DOCUMENT_CONTEXT_NOT_INJECTED"),
        { errorCode: "DOCUMENT_CONTEXT_NOT_INJECTED" },
      );
    }

    // Brug effectiveDocCtx (trimmet) til tier-klassificering — det er hvad AI faktisk modtager
    const docChars = effectiveDocCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0);
    const complexity = classifyChatComplexity(message, docChars, isPartialOcr);
    const resolved = resolveModelForTier(complexity.tier);
    const docModel = resolved.model;
    const docMaxTokens = complexity.tier === "heavy" ? 4000 : 2000;
    console.log(`[ai:router] model=${docModel} tier=${complexity.tier} reason=${complexity.reason} provider=${resolved.provider} use_case=doc_mode streaming=${!!params.onToken}`);
    const t0 = Date.now();

    if (params.onToken && isPartialOcr) {
      const stream = await oai.chat.completions.create({
        model:       docModel,
        temperature: 0.1,
        max_tokens:  docMaxTokens,
        messages:    messagesPayload,
        stream:      true,
      });
      aiText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) { params.onToken(delta); aiText += delta; }
      }
      if (isDefinitiveNegative(aiText)) {
        console.warn(`[chat-runner] PARTIAL_SAFEGUARD detected after streaming — keeping streamed text (prompt-level prevention active)`);
      }
    } else if (params.onToken) {
      const stream = await oai.chat.completions.create({
        model:       docModel,
        temperature: 0.1,
        max_tokens:  docMaxTokens,
        messages:    messagesPayload,
        stream:      true,
      });
      aiText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) { params.onToken(delta); aiText += delta; }
      }
    } else {
      const completion = await oai.chat.completions.create({
        model:       docModel,
        temperature: 0.1,
        max_tokens:  docMaxTokens,
        messages:    messagesPayload,
      });
      aiText = completion.choices[0]?.message?.content ?? "";
      if (isPartialOcr) {
        const safeguarded = applyPartialSafeguard(aiText);
        if (safeguarded !== aiText) {
          console.warn(`[chat-runner] PARTIAL_SAFEGUARD triggered (non-stream) — rewriting definitive negative`);
          aiText = safeguarded;
        }
      }
    }
    aiLatencyMs = Date.now() - t0;

    console.log(`[chat-runner] DOC_ANSWER_LEN=${aiText.length} latency=${aiLatencyMs}ms isPartialOcr=${isPartialOcr}`);

    // TASK 5 — grounding-validering (bruger effectiveDocCtx — hvad AI faktisk fik)
    if (aiText) {
      aiText = validateDocumentGrounding(aiText, effectiveDocCtx[0].extracted_text);
    }

    if (!aiText) {
      throw Object.assign(
        new Error("AI returnerede tomt svar i dokument-mode"),
        { errorCode: "AI_EMPTY_RESPONSE" },
      );
    }
  } else {
    const resolvedUseCase = params.useCase ?? "grounded_chat";
    const normalComplexity = classifyChatComplexity(message, 0, false);
    const normalResolved = resolveModelForTier(normalComplexity.tier);
    const normalMaxTokens = normalComplexity.tier === "heavy" ? 4000 : normalComplexity.tier === "nano" ? 1000 : 2000;
    console.log(`[chat-runner] NORMAL_MODE useCase=${resolvedUseCase} model=${normalResolved.model} tier=${normalComplexity.tier} reason=${normalComplexity.reason} streaming=${!!params.onToken}`);
    const t0 = Date.now();

    if (params.onToken) {
      const { getOpenAIClient } = await import("../lib/openai-client");
      const oai = getOpenAIClient();
      const stream = await oai.chat.completions.create({
        model:       normalResolved.model,
        temperature: 0.3,
        max_tokens:  normalMaxTokens,
        messages: [
          { role: "system", content: builtPrompt.systemPrompt },
          { role: "user",   content: message },
        ],
        stream: true,
      });
      aiText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) { params.onToken(delta); aiText += delta; }
      }
    } else {
      const { runAiCall } = await import("../lib/ai/runner");
      const aiResult = await runAiCall(
        { feature: "ai-chat", useCase: resolvedUseCase, tenantId: organizationId, userId, model: normalComplexity.tier as any },
        { systemPrompt: builtPrompt.systemPrompt, userInput: message },
      );
      aiText = aiResult.text;
    }
    aiLatencyMs = Date.now() - t0;
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

  // ── Persist document context for follow-up questions ──────────────────────
  // Only save when this request carried fresh document context (not from DB store).
  if (docCtx.length > 0 && !params.conversationId) {
    // New conversation: save all valid attachments for future turns.
    const { saveConversationAttachment } = await import("../lib/chat/attachment-state");
    await Promise.allSettled(
      docCtx.map((d) =>
        saveConversationAttachment({
          conversationId,
          tenantId:      organizationId,
          filename:      d.filename,
          mimeType:      d.mime_type,
          extractedText: d.extracted_text,
          charCount:     d.char_count,
        }),
      ),
    );
    console.log(`[chat-runner] Saved ${docCtx.length} attachment(s) to conversation ${conversationId}`);
  }

  // ── Storage 1.7: Similar Cases — intent-based, cached, rate-limited ─────────

  // Resolve expert routing hints for the decision layer
  const _expertAny = expert as unknown as Record<string, unknown>;
  const expertRoutingHints = _expertAny["routingHints"] as Record<string, unknown> | null | undefined;
  const _kbField = _expertAny["knowledgeBases"];
  const hasKnowledgeBases  = _kbField != null
    ? (_kbField as unknown[]).length > 0
    : undefined; // unknown — don't block

  const decision = shouldRunSimilarity({
    message,
    expertRoutingHints: expertRoutingHints ?? null,
    hasKnowledgeBases,
  });

  let similarCases: SimilarCaseInResponse[]   = [];
  let totalSimilarCases: number | undefined;
  let simStatusCode: SimilarCasesStatusCode   = "not_triggered";
  let simCacheHit                             = false;
  let simBudgetSkipped                        = false;
  let simDebug: { pgvectorUsed: boolean; retrievalPath: string; candidateCount: number } = {
    pgvectorUsed: false, retrievalPath: "empty", candidateCount: 0,
  };
  const simStart = Date.now();

  let shouldDoRetrieval = false;

  if (!decision.shouldRun) {
    simStatusCode = "not_triggered";
  } else if (!similarityRateLimiter.allow(organizationId)) {
    simStatusCode = "rate_limited";
  } else {
    // Budget guard — skip when tenant AI budget is fully exhausted
    const budgetCheck = await shouldAllowSimilarityByBudget(organizationId);
    if (!budgetCheck.allowed) {
      simStatusCode    = "skipped_budget_guard";
      simBudgetSkipped = true;
    } else {
      shouldDoRetrieval = true;
    }
  }

  if (shouldDoRetrieval) {
    const SIMILAR_TOP_K = 5;
    const cacheKey = similarityCache.buildKey({
      tenantId: organizationId,
      expertId: expert.id,
      query:    message,
      topK:     SIMILAR_TOP_K,
    });

    const cached = similarityCache.get(cacheKey) as SimilarCaseInResponse[] | null;

    if (cached) {
      simCacheHit   = true;
      simStatusCode = cached.length > 0 ? "cache_hit" : "no_matches";
      similarCases  = cached;
      totalSimilarCases = cached.length;
    } else {
      try {
        const { findSimilarCases } = await import("../lib/knowledge/kb-similar");
        const similarResult = await findSimilarCases({
          tenantId:  organizationId,
          mode:      "text",
          queryText: message,
          expertId:  expert.id,
          topK:      SIMILAR_TOP_K,
        });

        simDebug = {
          pgvectorUsed:   similarResult.debug.pgvectorUsed,
          retrievalPath:  similarResult.debug.retrievalPath,
          candidateCount: similarResult.debug.candidateCount,
        };

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
          whyMatchedCode: c.whyMatchedCode,
          confidenceCode: c.confidenceCode,
          pageNumber:     c.pageNumber,
          timestampSec:   c.timestampSec,
        }));

        totalSimilarCases = similarResult.total;
        simStatusCode = similarCases.length > 0 ? "success" : "no_matches";

        // Store result in cache (including empty results — so we don't hammer DB)
        similarityCache.set(cacheKey, similarCases);

      } catch (err) {
        simStatusCode = "error_suppressed";
        console.warn(`[chat-runner] similar_cases_error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Structured observability — no PII (query text not logged)
  logSimilarityEvent({
    tenantId:            organizationId,
    expertId:            expert.id,
    mode:                "text",
    decisionReason:      decision.decisionReason,
    statusCode:          simStatusCode,
    cacheHit:            simCacheHit,
    budgetGuardSkipped:  simBudgetSkipped,
    pgvectorUsed:        simDebug.pgvectorUsed,
    retrievalPath:       simDebug.retrievalPath,
    candidateCount:      simDebug.candidateCount,
    returnedCount:       similarCases.length,
    latencyMs:           Date.now() - simStart,
    topK:                5,
    rateLimitRemaining:  similarityRateLimiter.remaining(organizationId),
  });

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
    similarCasesAttempted:  decision.shouldRun,
    similarCasesStatusCode: simStatusCode,
  };

  if (similarCases.length > 0) {
    result.similarCases      = similarCases;
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

      const streamDocChars = docCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0);
      const streamComplexity = classifyChatComplexity(message, streamDocChars, false);
      const streamResolved = resolveModelForTier(streamComplexity.tier);
      const streamMaxTokens = streamComplexity.tier === "heavy" ? 4000 : 2000;
      console.log(`[chat-runner:stream] model=${streamResolved.model} tier=${streamComplexity.tier} reason=${streamComplexity.reason}`);
      const t0 = Date.now();

      const stream = await oai.chat.completions.create({
        model: streamResolved.model,
        temperature: 0.1,
        max_tokens: streamMaxTokens,
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

      const isPartialOcr = rawDocCtx.some(d => (d as any).source === "ocr_partial");
      if (isPartialOcr) {
        const safeguarded = applyPartialSafeguard(aiText);
        if (safeguarded !== aiText) {
          console.warn(`[chat-runner:stream] PARTIAL_SAFEGUARD triggered — rewriting definitive negative before emit`);
          aiText = safeguarded;
        }
      }

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
