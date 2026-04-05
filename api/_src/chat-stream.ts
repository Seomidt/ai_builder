/**
 * api/_src/chat-stream.ts — Vercel Serverless SSE Streaming Handler
 *
 * Direct streaming — NO Railway dependency.
 * - Documents: Gemini 2.5 Flash via @google/genai SDK (GEMINI_API_KEY)
 * - Normal chat: GPT-4.1-mini via OpenAI API (OPENAI_API_KEY)
 *
 * Uses the NEW @google/genai SDK with native generateContentStream()
 * and thinkingBudget: 0 to disable thinking for fast TTFT.
 *
 * Route: POST /api/chat-stream
 * Client receives: delta, status, gated, done, error events
 */
import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { readBody } from "./_lib/response.ts";
import { dbList } from "./_lib/db.ts";
import { isGroundedUseCase, type AiUseCase } from "../../server/lib/ai/types.ts";
import { GoogleGenAI } from "@google/genai";

export const config = {
  supportsResponseStreaming: true,
  maxDuration: 120,
};

// ── Environment ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
const SUPABASE_URL   = process.env.SUPABASE_URL   ?? "";
const SUPABASE_SVC   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const GEMINI_MODEL = "gemini-2.5-flash";

// ── Thresholds ───────────────────────────────────────────────────────────────
const LARGE_DOC_CHARS = 5_000;
const DELSVAR1_SLICE  = 5_000;
const MAX_DOC_CHARS   = 80_000;

// ── Gemini client (singleton) ────────────────────────────────────────────────
let _geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  if (!_geminiClient) _geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return _geminiClient;
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Expert {
  id: string; name: string; category: string | null;
  description: string | null; routingHints: unknown;
  enabledForChat: boolean; status: string;
}
interface DocumentContext {
  filename: string; mime_type: string; char_count: number;
  extracted_text: string; status: "ok" | "unsupported" | "error";
  message?: string; source?: string;
}
interface ChatStreamRequest {
  message: string; conversation_id?: string | null;
  document_context?: DocumentContext[];
  context?: {
    preferred_expert_id?: string | null;
    document_ids?: string[]; attachment_count?: number;
    use_case?: AiUseCase;
  };
  idempotency_key?: string;
}

// ── Expert scoring ───────────────────────────────────────────────────────────
function getHints(expert: Expert): string[] {
  const h = expert.routingHints;
  if (!h) return [];
  if (Array.isArray(h)) return h as string[];
  try { const p = JSON.parse(String(h)); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
function scoreExpert(expert: Expert, message: string): number {
  const lower = message.toLowerCase();
  let score = 0;
  for (const hint of getHints(expert)) {
    if (lower.includes(hint.toLowerCase())) score += 10;
  }
  if (expert.category && lower.includes(expert.category.toLowerCase())) score += 6;
  if (lower.includes(expert.name.toLowerCase())) score += 4;
  return score;
}

// ── Confidence ───────────────────────────────────────────────────────────────
function deriveConfidence(answer: string, warnings: string[], extractedText?: string): "high" | "medium" | "low" {
  if (warnings.length > 0) return "low";
  const notFound = ["kan ikke finde", "fremgår ikke", "ikke i det uploadede"];
  if (notFound.some(p => answer.toLowerCase().includes(p))) return "low";
  if (extractedText) {
    const aw = answer.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4);
    const dw = new Set(extractedText.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4));
    const m = aw.filter(w => dw.has(w));
    const r = aw.length > 0 ? m.length / aw.length : 0;
    if (r >= 0.4) return "high";
    if (r >= 0.2) return "medium";
    return "low";
  }
  const hedges = ["ikke sikker", "ved ikke", "begrænset", "muligvis", "kan ikke garantere"];
  return hedges.some(h => answer.toLowerCase().includes(h)) ? "medium" : "high";
}

// ── Persist turn ─────────────────────────────────────────────────────────────
async function persistTurn(params: {
  organizationId: string; userId: string; expertId: string;
  userMessage: string; answer: string; existingConvId: string | null;
  latencyMs: number; confidence: string; promptTokens: number; completionTokens: number;
}): Promise<string> {
  const svc = {
    apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}`,
    "Content-Type": "application/json", Prefer: "return=representation",
  };
  let convId = params.existingConvId;
  if (!convId) {
    const convRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_conversations`, {
      method: "POST", headers: svc,
      body: JSON.stringify({
        organization_id: params.organizationId, created_by: params.userId,
        selected_expert_id: params.expertId, title: params.userMessage.slice(0, 80),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!convRes.ok) throw new Error(`conv insert ${convRes.status}: ${await convRes.text()}`);
    const convData = (await convRes.json()) as Array<{ id: string }>;
    convId = convData[0]?.id ?? null;
    if (!convId) throw new Error("No conversation id returned");
  } else {
    fetch(`${SUPABASE_URL}/rest/v1/chat_conversations?id=eq.${encodeURIComponent(convId)}`, {
      method: "PATCH", headers: svc,
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: "POST", headers: svc,
    body: JSON.stringify({
      conversation_id: convId, organization_id: params.organizationId,
      role: "user", message_text: params.userMessage,
    }),
  });
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: "POST", headers: svc,
    body: JSON.stringify({
      conversation_id: convId, organization_id: params.organizationId,
      role: "assistant", message_text: params.answer, expert_id: params.expertId,
      metadata: {
        latency_ms: params.latencyMs, confidence_band: params.confidence,
        prompt_tokens: params.promptTokens, completion_tokens: params.completionTokens,
      },
    }),
  });
  return convId as string;
}

// ── Gemini streaming via @google/genai SDK ───────────────────────────────────
// Uses generateContentStream with for-await chunks — true token-by-token streaming.
// thinkingBudget: 0 disables the thinking phase for fast TTFT.
async function streamGemini(
  systemPrompt: string,
  userContent: string,
  sendEvent: (data: object) => void,
): Promise<{ text: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const t0 = Date.now();
  const ai = getGemini();

  const response = await ai.models.generateContentStream({
    model: GEMINI_MODEL,
    contents: userContent,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.2,
      maxOutputTokens: 2000,
      thinkingConfig: {
        thinkingBudget: 0,  // DISABLE thinking → fast TTFT
      },
    },
  });

  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of response) {
    // Extract text delta from this chunk
    const delta = chunk.text ?? "";
    if (delta) {
      fullText += delta;
      sendEvent({ type: "delta", text: delta });
    }
    // Capture usage metadata (usually in the last chunk)
    if (chunk.usageMetadata) {
      promptTokens     = chunk.usageMetadata.promptTokenCount     ?? promptTokens;
      completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens;
    }
  }

  return { text: fullText, promptTokens, completionTokens, latencyMs: Date.now() - t0 };
}

// ── OpenAI streaming (for normal chat without documents) ─────────────────────
async function streamOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  sendEvent: (data: object) => void,
): Promise<{ text: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const t0 = Date.now();
  const streamRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0.2, max_tokens: 2000,
      stream: true, stream_options: { include_usage: true },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent },
      ],
    }),
  });

  if (!streamRes.ok) {
    const txt = await streamRes.text().catch(() => streamRes.statusText);
    throw new Error(`OpenAI ${streamRes.status}: ${txt}`);
  }

  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try {
          const parsed = JSON.parse(raw);
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            sendEvent({ type: "delta", text: delta });
          }
          if (parsed.usage) {
            promptTokens     = parsed.usage.prompt_tokens     ?? 0;
            completionTokens = parsed.usage.completion_tokens ?? 0;
          }
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { text: fullText, promptTokens, completionTokens, latencyMs: Date.now() - t0 };
}

// ── SSE Streaming Handler ────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // SSE headers — must be set before any data is written
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache, no-transform",
    Connection:          "keep-alive",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
  });

  const sendEvent = (data: object) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();
    } catch { /* client disconnected */ }
  };

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const auth = await authenticate(req);
    if (auth.status === "lockdown") {
      sendEvent({ type: "error", errorCode: "LOCKDOWN", message: "Platform er i lockdown" });
      return res.end();
    }
    if (auth.status !== "ok" || !auth.user) {
      sendEvent({ type: "error", errorCode: "UNAUTHENTICATED", message: "Login påkrævet" });
      return res.end();
    }
    if (req.method !== "POST") {
      sendEvent({ type: "error", errorCode: "METHOD_NOT_ALLOWED", message: "Kun POST tilladt" });
      return res.end();
    }

    const { user } = auth;
    const orgId  = user.organizationId;
    const userId = user.id;

    const body = await readBody<ChatStreamRequest>(req);
    const message = (body.message ?? "").trim();
    if (!message) {
      sendEvent({ type: "error", errorCode: "MISSING_MESSAGE", message: "Besked mangler" });
      return res.end();
    }

    const useCase: AiUseCase = body.context?.use_case ?? "grounded_chat";

    // ── Budget reservation ────────────────────────────────────────────────────
    let budgetReservedAmount = 0;
    try {
      const { reserveBudget } = await import("../../server/lib/ai/budget-guard");
      const reservation = await reserveBudget(orgId, 0.001);
      if (!reservation.allowed) {
        sendEvent({ type: "error", errorCode: "BUDGET_EXCEEDED", message: "AI-budgettet er opbrugt." });
        return res.end();
      }
      budgetReservedAmount = reservation.reservedAmount;
    } catch { /* fail-safe */ }

    const token = (req.headers.authorization ?? "").slice(7);

    // ── Fetch experts ────────────────────────────────────────────────────────
    sendEvent({ type: "status", text: "Analyserer forespørgsel..." });

    let experts: Expert[];
    try {
      const rows = await dbList("architecture_profiles", token, {
        status:           "neq.archived",
        enabled_for_chat: "eq.true",
        select:           "id,name,category,description,routing_hints,enabled_for_chat,status",
      });
      experts = rows as unknown as Expert[];
    } catch (e) {
      console.error("[chat-stream] expert fetch failed:", (e as Error).message);
      sendEvent({ type: "error", errorCode: "EXPERT_FETCH_FAILED", message: "Kunne ikke hente eksperter" });
      return res.end();
    }

    if (!experts.length) {
      sendEvent({ type: "error", errorCode: "NO_EXPERTS_AVAILABLE", message: "Ingen AI-eksperter er tilgængelige." });
      return res.end();
    }

    // ── Select expert ────────────────────────────────────────────────────────
    const EXPERT_MATCH_THRESHOLD = 6;
    let expert: Expert;
    let expertScore = 0;
    const prefId = body.context?.preferred_expert_id;

    if (prefId) {
      expert = experts.find(e => e.id === prefId) ?? experts[0];
      expertScore = scoreExpert(expert, message);
    } else {
      const scored = experts
        .map(e => ({ expert: e, score: scoreExpert(e, message) }))
        .sort((a, b) => b.score - a.score);
      expert      = scored[0].expert;
      expertScore = scored[0].score;
    }

    const routingExplanation = `Valgt baseret på match med ekspertens kompetenceområde (${expert.category ?? expert.name}).`;

    // ── Document context ─────────────────────────────────────────────────────
    const rawDocCtx  = body.document_context ?? [];
    const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
    const failedDocs = rawDocCtx.filter(d => d.status !== "ok");
    const hasDocIntent = rawDocCtx.length > 0;

    console.log(`[chat-stream] experts=${experts.length} selected=${expert.name} score=${expertScore} docCtx=${docCtx.length}`);

    // Hard stops
    const attachmentCount = body.context?.attachment_count ?? 0;
    if (attachmentCount > 0 && rawDocCtx.length === 0) {
      sendEvent({ type: "error", errorCode: "DOCUMENT_CONTEXT_MISSING", message: "Dokument er vedhæftet men dokumentindhold mangler." });
      return res.end();
    }
    if (hasDocIntent && docCtx.length === 0) {
      const reason = failedDocs.map(d => d.message).filter(Boolean).join("; ") || "Ingen tekst kunne udtrækkes fra dokumentet";
      sendEvent({ type: "error", errorCode: "DOCUMENT_UNREADABLE", message: reason });
      return res.end();
    }
    if (useCase === "validation" && docCtx.length === 0) {
      sendEvent({ type: "gated", routeType: "no_context", message: "Du skal uploade et dokument for at kunne validere." });
      return res.end();
    }
    if (isGroundedUseCase(useCase) && docCtx.length === 0) {
      sendEvent({ type: "gated", routeType: "no_context", message: "Jeg kan ikke finde det i jeres interne data." });
      return res.end();
    }

    // ── Route type ───────────────────────────────────────────────────────────
    const hasRelevantExpert = expertScore >= EXPERT_MATCH_THRESHOLD;
    const routeType: string =
      docCtx.length > 0 && hasRelevantExpert ? "hybrid"
      : docCtx.length > 0                   ? "attachment_first"
      :                                        "expert_auto";

    // ── System prompts ───────────────────────────────────────────────────────
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

    const normalSystemPrompt = [
      `Du er en AI-ekspert ved navn ${expert.name}.`,
      expert.category    ? `Dit kompetenceområde er: ${expert.category}.`   : "",
      expert.description ? `Om dig: ${expert.description}`                   : "",
      "Svar altid på dansk med klare, præcise og hjælpsomme svar.",
      "Basér dine svar på virksomhedens data, politikker og regler.",
      "Angiv tydeligt hvis du er i tvivl om noget.",
    ].filter(Boolean).join("\n");

    // ── Determine strategy ───────────────────────────────────────────────────
    const docTextFull = docCtx.map(d => d.extracted_text).join("\n\n---\n\n");
    const totalDocChars = docTextFull.length;
    const isLargeDoc = docCtx.length > 0 && totalDocChars > LARGE_DOC_CHARS;
    const hasDoc = docCtx.length > 0;

    const modelUsed = hasDoc ? GEMINI_MODEL : "gpt-4.1-mini";
    const providerUsed = hasDoc ? "google" : "openai";

    console.log(`[chat-stream] model=${modelUsed} provider=${providerUsed} isLargeDoc=${isLargeDoc} totalDocChars=${totalDocChars} routeType=${routeType}`);

    // ── Accumulate tokens ────────────────────────────────────────────────────
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalLatencyMs = 0;
    let fullAnswer = "";

    if (isLargeDoc) {
      // ════════════════════════════════════════════════════════════════════════
      // DELSVAR STRATEGY: Progressive answers for large documents
      // ════════════════════════════════════════════════════════════════════════

      // ── Delsvar 1: Quick answer from first chunk ──────────────────────────
      const chunk1 = docTextFull.slice(0, DELSVAR1_SLICE);
      const delsvar1Prompt = docSystemPrompt + `\n\nBEMÆRK: Du har kun modtaget de første ${DELSVAR1_SLICE} tegn af dokumentet. Giv et hurtigt foreløbigt svar baseret på det du kan se. Start dit svar med "**Foreløbigt svar (baseret på første del af dokumentet):**\n\n".`;
      const delsvar1Content = `DOKUMENT (del 1 af ${Math.ceil(totalDocChars / DELSVAR1_SLICE)}):\n\n${chunk1}\n\n---\n\nSPØRGSMÅL: ${message}`;

      sendEvent({ type: "status", text: "Læser første del af dokumentet...", routeType });

      const result1 = await streamGemini(delsvar1Prompt, delsvar1Content, sendEvent);
      totalPromptTokens     += result1.promptTokens;
      totalCompletionTokens += result1.completionTokens;
      totalLatencyMs        += result1.latencyMs;
      fullAnswer            += result1.text;

      console.log(`[chat-stream] delsvar1 done: ${result1.text.length} chars, ${result1.latencyMs}ms`);

      // ── Delsvar 2: Complete answer from full document ─────────────────────
      const fullDocText = totalDocChars > MAX_DOC_CHARS
        ? docTextFull.slice(0, MAX_DOC_CHARS) + "\n\n[... dokument afkortet ...]"
        : docTextFull;

      sendEvent({ type: "delta", text: "\n\n---\n\n" });
      sendEvent({ type: "status", text: "Analyserer hele dokumentet...", routeType });

      const delsvar2Prompt = docSystemPrompt + `\n\nBEMÆRK: Du har nu det FULDE dokument. Giv et komplet og endeligt svar. Start dit svar med "**Komplet svar (baseret på hele dokumentet):**\n\n". Hvis dit svar er det samme som det foreløbige, sig blot "Svaret er uændret — se ovenfor."`;
      const delsvar2Content = `DOKUMENT (komplet):\n\n${fullDocText}\n\n---\n\nSPØRGSMÅL: ${message}`;

      const result2 = await streamGemini(delsvar2Prompt, delsvar2Content, sendEvent);
      totalPromptTokens     += result2.promptTokens;
      totalCompletionTokens += result2.completionTokens;
      totalLatencyMs        += result2.latencyMs;
      fullAnswer            += "\n\n---\n\n" + result2.text;

      console.log(`[chat-stream] delsvar2 done: ${result2.text.length} chars, ${result2.latencyMs}ms`);

    } else if (hasDoc) {
      // ════════════════════════════════════════════════════════════════════════
      // SMALL DOCUMENT: Single Gemini call
      // ════════════════════════════════════════════════════════════════════════
      const docText = totalDocChars > MAX_DOC_CHARS
        ? docTextFull.slice(0, MAX_DOC_CHARS) + "\n\n[... dokument afkortet ...]"
        : docTextFull;
      const userContent = `DOKUMENT:\n\n${docText}\n\n---\n\n${message}`;

      sendEvent({ type: "status", text: "Genererer svar...", routeType });

      const result = await streamGemini(docSystemPrompt, userContent, sendEvent);
      totalPromptTokens     = result.promptTokens;
      totalCompletionTokens = result.completionTokens;
      totalLatencyMs        = result.latencyMs;
      fullAnswer            = result.text;

    } else {
      // ════════════════════════════════════════════════════════════════════════
      // NO DOCUMENT: Normal expert chat (OpenAI)
      // ════════════════════════════════════════════════════════════════════════
      sendEvent({ type: "status", text: "Genererer svar...", routeType });

      const result = await streamOpenAI("gpt-4.1-mini", normalSystemPrompt, message, sendEvent);
      totalPromptTokens     = result.promptTokens;
      totalCompletionTokens = result.completionTokens;
      totalLatencyMs        = result.latencyMs;
      fullAnswer            = result.text;
    }

    console.log(`[chat-stream] completed len=${fullAnswer.length} latency=${totalLatencyMs}ms tokens=${totalPromptTokens}+${totalCompletionTokens} model=${modelUsed}`);

    // ── Assess answer ────────────────────────────────────────────────────────
    const warnings: string[] = [];
    if (fullAnswer.length < 5) warnings.push("Svaret er meget kort.");
    const combinedDocText = docCtx.map(d => d.extracted_text).join(" ");
    const confidence = deriveConfidence(fullAnswer, warnings, hasDoc ? combinedDocText : undefined);
    const needsManual = confidence === "low";

    // ── Persist conversation (non-fatal) ─────────────────────────────────────
    let conversationId: string = body.conversation_id ?? crypto.randomUUID();
    try {
      conversationId = await persistTurn({
        organizationId: orgId, userId, expertId: expert.id,
        userMessage: message, answer: fullAnswer,
        existingConvId: body.conversation_id ?? null,
        latencyMs: totalLatencyMs, confidence,
        promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
      });
    } catch (e) {
      console.error("[chat-stream] persist failed (non-fatal):", (e as Error).message);
    }

    // ── Usage logging (fire-and-forget) ──────────────────────────────────────
    void (async () => {
      try {
        const { logAiUsage } = await import("../../server/lib/ai/usage");
        const { loadPricing } = await import("../../server/lib/ai/pricing");
        const { estimateAiCost } = await import("../../server/lib/ai/costs");
        const { pricing, source: pricingSource, version: pricingVersion } = await loadPricing(providerUsed, modelUsed);
        const actualCostUsd = estimateAiCost({
          usage: { input_tokens: totalPromptTokens, output_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens },
          pricing,
        }) ?? 0;
        await logAiUsage({
          tenantId: orgId, userId,
          requestId: body.idempotency_key ?? crypto.randomUUID(),
          feature: isLargeDoc ? "expert.chat.doc.delsvar" : (hasDoc ? "expert.chat.doc" : "expert.chat.stream"),
          routeKey: hasDoc ? "expert.chat.doc" : "expert.chat",
          provider: providerUsed, model: modelUsed,
          promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          status: "success", latencyMs: totalLatencyMs,
          estimatedCostUsd: actualCostUsd, actualCostUsd,
          pricingSource, pricingVersion,
          inputPreview: message.slice(0, 200),
        });
      } catch (err) {
        console.warn("[chat-stream] usage logging failed:", (err as Error).message);
      } finally {
        if (budgetReservedAmount > 0) {
          try {
            const { releaseBudgetReservation } = await import("../../server/lib/ai/budget-guard");
            await releaseBudgetReservation(orgId, budgetReservedAmount);
          } catch { /* non-fatal */ }
        }
      }
    })();

    // ── Send done event ──────────────────────────────────────────────────────
    const _isUpgradeCall = (body.document_context ?? []).some((d: any) => d.source === "r2_ocr_async");
    const _sComplt = _isUpgradeCall ? "complete" : (hasDoc ? "partial" : "complete");

    sendEvent({
      type:                    "done",
      answer:                  fullAnswer,
      conversation_id:         conversationId,
      route_type:              routeType,
      expert:                  { id: expert.id, name: expert.name, category: expert.category ?? null },
      used_sources:            [],
      used_rules:              [],
      warnings,
      latency_ms:              totalLatencyMs,
      confidence_band:         confidence,
      needs_manual_review:     needsManual,
      routing_explanation:     routingExplanation,
      answer_completeness:     _sComplt,
      refinement_generation:   _isUpgradeCall ? 3 : 1,
      model_used:              modelUsed,
      delsvar_count:           isLargeDoc ? 2 : 1,
    });

    res.end();
  } catch (err) {
    const msg  = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.errorCode ?? "CHAT_STREAM_ERROR";
    console.error(`[chat-stream] error: ${msg}`);
    sendEvent({ type: "error", errorCode: code, message: msg });
    res.end();
  }
}
