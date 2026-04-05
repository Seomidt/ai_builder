/**
 * api/_src/chat-stream.ts — Vercel Serverless SSE Streaming Handler
 *
 * Direct OpenAI streaming — NO Railway dependency.
 * Mirrors the logic from api/_src/chat.ts but uses stream:true for
 * real-time token delivery via SSE (Server-Sent Events).
 *
 * Route: POST /api/chat-stream
 * Client receives: delta, status, gated, done, error events
 */
import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { readBody } from "./_lib/response.ts";
import { dbList } from "./_lib/db.ts";
import { AI_MODEL_ROUTES } from "../../server/lib/ai/config.ts";
import { isGroundedUseCase, type AiUseCase } from "../../server/lib/ai/types.ts";

export const config = {
  supportsResponseStreaming: true,
  maxDuration: 120,
};

// ── Model resolution ──────────────────────────────────────────────────────────
function resolveVercelModel(key: keyof typeof AI_MODEL_ROUTES = "default") {
  const route = AI_MODEL_ROUTES[key] ?? AI_MODEL_ROUTES.default;
  return { model: route.model, provider: route.provider, key };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const SUPABASE_URL   = process.env.SUPABASE_URL   ?? "";
const SUPABASE_SVC   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Expert {
  id:             string;
  name:           string;
  category:       string | null;
  description:    string | null;
  routingHints:   unknown;
  enabledForChat: boolean;
  status:         string;
}
interface DocumentContext {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error";
  message?:       string;
  source?:        string;
}
interface ChatStreamRequest {
  message:           string;
  conversation_id?:  string | null;
  document_context?: DocumentContext[];
  context?: {
    preferred_expert_id?: string | null;
    document_ids?:        string[];
    attachment_count?:    number;
    use_case?:            AiUseCase;
  };
  idempotency_key?: string;
}

// ── Expert scoring (same as chat.ts) ──────────────────────────────────────────
function getHints(expert: Expert): string[] {
  const h = expert.routingHints;
  if (!h) return [];
  if (Array.isArray(h)) return h as string[];
  try { const parsed = JSON.parse(String(h)); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function scoreExpert(expert: Expert, message: string): number {
  const lower = message.toLowerCase();
  let score   = 0;
  for (const hint of getHints(expert)) {
    if (lower.includes(hint.toLowerCase())) score += 10;
  }
  if (expert.category && lower.includes(expert.category.toLowerCase())) score += 6;
  if (lower.includes(expert.name.toLowerCase()))                         score += 4;
  return score;
}

// ── Confidence ────────────────────────────────────────────────────────────────
function deriveConfidence(answer: string, warnings: string[], extractedText?: string): "high" | "medium" | "low" {
  if (warnings.length > 0) return "low";
  const notFoundPhrases = ["kan ikke finde", "fremgår ikke", "ikke i det uploadede"];
  if (notFoundPhrases.some(p => answer.toLowerCase().includes(p))) return "low";
  if (extractedText) {
    const answerWords = answer.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4);
    const docWords    = new Set(extractedText.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4));
    const matchingWords = answerWords.filter(w => docWords.has(w));
    const overlapRatio  = answerWords.length > 0 ? matchingWords.length / answerWords.length : 0;
    if (overlapRatio >= 0.4) return "high";
    if (overlapRatio >= 0.2) return "medium";
    return "low";
  }
  const hedges = ["ikke sikker", "ved ikke", "begrænset", "muligvis", "kan ikke garantere"];
  return hedges.some(h => answer.toLowerCase().includes(h)) ? "medium" : "high";
}

// ── Persist turn (non-fatal) ──────────────────────────────────────────────────
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

// ── SSE Streaming Handler ─────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // SSE headers — must be set BEFORE any data is sent
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

    // ── Step 1: Fetch experts via RLS ─────────────────────────────────────────
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

    // ── Step 2: Select expert ─────────────────────────────────────────────────
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

    // ── Step 3: Document context ──────────────────────────────────────────────
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

    // Grounded use case without document → block
    if (isGroundedUseCase(useCase) && docCtx.length === 0) {
      sendEvent({ type: "gated", routeType: "no_context", message: "Jeg kan ikke finde det i jeres interne data." });
      return res.end();
    }

    // ── Route type ────────────────────────────────────────────────────────────
    const hasRelevantExpert = expertScore >= EXPERT_MATCH_THRESHOLD;
    const routeType: string =
      docCtx.length > 0 && hasRelevantExpert ? "hybrid"
      : docCtx.length > 0                   ? "attachment_first"
      :                                        "expert_auto";

    // ── Step 4: System prompt ─────────────────────────────────────────────────
    let systemPrompt: string;
    if (docCtx.length > 0) {
      systemPrompt = [
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
    } else {
      systemPrompt = [
        `Du er en AI-ekspert ved navn ${expert.name}.`,
        expert.category    ? `Dit kompetenceområde er: ${expert.category}.`   : "",
        expert.description ? `Om dig: ${expert.description}`                   : "",
        "Svar altid på dansk med klare, præcise og hjælpsomme svar.",
        "Basér dine svar på virksomhedens data, politikker og regler.",
        "Angiv tydeligt hvis du er i tvivl om noget.",
      ].filter(Boolean).join("\n");
    }

    sendEvent({ type: "status", text: "Genererer svar...", routeType });

    // ── Step 5: Build user content ────────────────────────────────────────────
    let userContent: string;
    if (docCtx.length > 0) {
      const docTextFull = docCtx.map(d => d.extracted_text).join("\n\n---\n\n");
      const docText = docTextFull.length > 40_000
        ? docTextFull.slice(0, 40_000) + "\n\n[... dokument afkortet ...]"
        : docTextFull;
      userContent = `DOKUMENT:\n\n${docText}\n\n---\n\n${message}`;
    } else {
      userContent = message;
    }

    // ── Step 6: Stream OpenAI response ────────────────────────────────────────
    const route = resolveVercelModel("expert.chat" as keyof typeof AI_MODEL_ROUTES);
    console.log(`[chat-stream] model=${route.model} provider=${route.provider} routeType=${routeType}`);

    const t0 = Date.now();
    const streamRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model:       route.model,
        temperature: 0.2,
        max_tokens:  2000,
        stream:      true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent },
        ],
      }),
    });

    if (!streamRes.ok) {
      const txt = await streamRes.text().catch(() => streamRes.statusText);
      console.error(`[chat-stream] OpenAI error ${streamRes.status}: ${txt}`);
      sendEvent({ type: "error", errorCode: "AI_EXECUTION_FAILED", message: "AI-eksperten kunne ikke svare." });
      return res.end();
    }

    // ── Parse SSE stream from OpenAI ──────────────────────────────────────────
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
        const text = decoder.decode(value, { stream: true });
        sseBuffer += text;
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
            // Capture usage from final chunk
            if (parsed.usage) {
              promptTokens     = parsed.usage.prompt_tokens     ?? 0;
              completionTokens = parsed.usage.completion_tokens ?? 0;
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const aiLatencyMs = Date.now() - t0;
    console.log(`[chat-stream] completed len=${fullText.length} latency=${aiLatencyMs}ms tokens=${promptTokens}+${completionTokens}`);

    // ── Step 7: Assess answer ─────────────────────────────────────────────────
    const warnings: string[] = [];
    if (fullText.length < 5) warnings.push("Svaret er meget kort.");
    const combinedDocText = docCtx.map(d => d.extracted_text).join(" ");
    const confidence = deriveConfidence(fullText, warnings, docCtx.length > 0 ? combinedDocText : undefined);
    const needsManual = confidence === "low";

    // ── Step 8: Persist conversation (non-fatal) ──────────────────────────────
    let conversationId: string = body.conversation_id ?? crypto.randomUUID();
    try {
      conversationId = await persistTurn({
        organizationId: orgId, userId, expertId: expert.id,
        userMessage: message, answer: fullText,
        existingConvId: body.conversation_id ?? null,
        latencyMs: aiLatencyMs, confidence,
        promptTokens, completionTokens,
      });
    } catch (e) {
      console.error("[chat-stream] persist failed (non-fatal):", (e as Error).message);
    }

    // ── Step 9: Usage logging (fire-and-forget) ───────────────────────────────
    void (async () => {
      try {
        const { logAiUsage } = await import("../../server/lib/ai/usage");
        const { loadPricing } = await import("../../server/lib/ai/pricing");
        const { estimateAiCost } = await import("../../server/lib/ai/costs");
        const { pricing, source: pricingSource, version: pricingVersion } = await loadPricing(route.provider, route.model);
        const actualCostUsd = estimateAiCost({
          usage: { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          pricing,
        }) ?? 0;
        await logAiUsage({
          tenantId: orgId, userId,
          requestId: body.idempotency_key ?? crypto.randomUUID(),
          feature: "expert.chat.stream", routeKey: route.key,
          provider: route.provider, model: route.model,
          promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
          status: "success", latencyMs: aiLatencyMs,
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

    // ── Step 10: Send done event ──────────────────────────────────────────────
    const _isUpgradeCall = (body.document_context ?? []).some((d: any) => d.source === "r2_ocr_async");
    const _sComplt = _isUpgradeCall ? "complete" : (docCtx.length > 0 ? "partial" : "complete");

    sendEvent({
      type:                    "done",
      answer:                  fullText,
      conversation_id:         conversationId,
      route_type:              routeType,
      expert:                  { id: expert.id, name: expert.name, category: expert.category ?? null },
      used_sources:            [],
      used_rules:              [],
      warnings,
      latency_ms:              aiLatencyMs,
      confidence_band:         confidence,
      needs_manual_review:     needsManual,
      routing_explanation:     routingExplanation,
      answer_completeness:     _sComplt,
      refinement_generation:   _isUpgradeCall ? 3 : 1,
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
