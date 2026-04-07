/**
 * api/_src/chat-stream.ts — Vercel Serverless SSE Streaming Handler
 *
 * Direct streaming — NO Railway dependency.
 * - Documents: Gemini 2.0 Flash via direct REST + SSE parsing (GEMINI_API_KEY)
 * - Normal chat: GPT-4.1-mini via OpenAI API (OPENAI_API_KEY)
 *
 * WHY NOT @google/genai SDK:
 *   generateContentStream() buffers the FULL HTTP response before returning.
 *   Direct REST fetch + line-by-line SSE parsing delivers first token in <3s.
 *
 * WHY gemini-2.0-flash instead of 2.5-flash:
 *   2.5-flash is a "thinking" model — even with thinkingBudget: 0 it does
 *   internal processing for 20-35s before generating. 2.0-flash has no
 *   thinking phase → TTFT ~1-3s. Also ~35% cheaper on tokens.
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

export const config = {
  supportsResponseStreaming: true,
  maxDuration: 120,
};

// ── Environment ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
const SUPABASE_URL   = process.env.SUPABASE_URL   ?? "";
const SUPABASE_SVC   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_REST_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

// ── Thresholds ───────────────────────────────────────────────────────────────
const MAX_DOC_CHARS   = 80_000;

// ── Latency helper ───────────────────────────────────────────────────────────
function perf(label: string, t0: number, extra?: Record<string, unknown>): void {
  const elapsed = Date.now() - t0;
  const extraStr = extra ? " " + JSON.stringify(extra) : "";
  console.log(`[PERF] ${label} +${elapsed}ms${extraStr}`);
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

// ── Gemini streaming via direct REST + SSE parsing ───────────────────────────
//
// WHY REST instead of @google/genai SDK:
//   The SDK's generateContentStream() awaits the full HTTP response body before
//   returning the AsyncGenerator — causing a ~38s delay (T7→T8 in PERF logs).
//   Direct fetch() returns as soon as HTTP headers arrive (~200ms), and we
//   parse SSE lines from the response body stream in real-time.
//
// Gemini SSE format:
//   data: {"candidates":[{"content":{"parts":[{"text":"..."}],...},...}],...}
//
//
async function streamGemini(
  systemPrompt: string,
  userContent: string,
  sendEvent: (data: object) => void,
  t0Request: number,
  callLabel: string,
): Promise<{ text: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const t0Call = Date.now();

  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const systemChars  = systemPrompt.length;
  const contentChars = userContent.length;
  const totalChars   = systemChars + contentChars;

  perf(`T7_gemini_rest_call_start [${callLabel}]`, t0Request, {
    model:              GEMINI_MODEL,
    provider:           "google",
    method:             "REST fetch + SSE parsing (no SDK)",
    url:                GEMINI_REST_URL,
    system_chars:       systemChars,
    content_chars:      contentChars,
    total_prompt_chars: totalChars,
    note:               "gemini-2.0-flash — no thinking phase",
  });

  // ── Direct REST call — returns as soon as HTTP headers arrive ────────────
  const res = await fetch(GEMINI_REST_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        { role: "user", parts: [{ text: userContent }] },
      ],
      generationConfig: {
        temperature:      0.2,
        maxOutputTokens:  4096,
      },
    }),
  });

  perf(`T8_gemini_http_headers [${callLabel}]`, t0Request, {
    status: res.status,
    note:   "HTTP headers received — body stream open, no buffering",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini REST ${res.status}: ${errText}`);
  }

  // ── SSE line-by-line parsing ──────────────────────────────────────────────
  const reader  = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let fullText  = "";
  let promptTokens     = 0;
  let completionTokens = 0;
  let firstChunkReceived = false;
  let firstChunkFlushed  = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // ── T9: First raw bytes received from Gemini ────────────────────────
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        perf(`T9_first_sse_chunk_received [${callLabel}]`, t0Request, {
          raw_bytes: value?.length ?? 0,
          note: "First bytes from Gemini — no SDK buffering",
        });
      }

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;  // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const raw = trimmed.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        // Safe JSON parse — never crash on malformed chunks
        let parsed: any;
        try { parsed = JSON.parse(raw); }
        catch { continue; }

        // Extract text delta: candidates[0].content.parts[0].text
        const delta: string = parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (delta) {
          fullText += delta;
          sendEvent({ type: "delta", text: delta });

          // ── T10: First token forwarded to HTTP response ───────────────
          if (!firstChunkFlushed) {
            firstChunkFlushed = true;
            perf(`T10_first_chunk_forwarded [${callLabel}]`, t0Request, {
              delta_len: delta.length,
              note: "First token written + flushed to client",
            });
          }
        }

        // Capture usage metadata (usually in the last chunk)
        const meta = parsed?.usageMetadata;
        if (meta) {
          promptTokens     = meta.promptTokenCount     ?? promptTokens;
          completionTokens = meta.candidatesTokenCount ?? completionTokens;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const callMs = Date.now() - t0Call;
  perf(`T11_stream_complete [${callLabel}]`, t0Request, {
    call_ms:           callMs,
    output_chars:      fullText.length,
    prompt_tokens:     promptTokens,
    completion_tokens: completionTokens,
    first_chunk_received: firstChunkReceived,
    first_chunk_flushed:  firstChunkFlushed,
  });

  return { text: fullText, promptTokens, completionTokens, latencyMs: callMs };
}

// ── OpenAI streaming (for normal chat without documents) ─────────────────────
async function streamOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  sendEvent: (data: object) => void,
  t0Request: number,
): Promise<{ text: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const t0Call = Date.now();

  perf("T7_openai_call_start", t0Request, {
    model,
    provider:           "openai",
    streaming_api:      "stream:true",
    system_chars:       systemPrompt.length,
    content_chars:      userContent.length,
    total_prompt_chars: systemPrompt.length + userContent.length,
  });

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

  perf("T8_openai_http_headers", t0Request, { status: streamRes.status });

  if (!streamRes.ok) {
    const txt = await streamRes.text().catch(() => streamRes.statusText);
    throw new Error(`OpenAI ${streamRes.status}: ${txt}`);
  }

  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let firstChunkReceived = false;
  let firstChunkFlushed  = false;

  const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        perf("T9_first_sse_chunk_received", t0Request, { raw_bytes: value?.length ?? 0 });
      }

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
            if (!firstChunkFlushed) {
              firstChunkFlushed = true;
              perf("T10_first_chunk_forwarded", t0Request, { delta_len: delta.length });
            }
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

  const callMs = Date.now() - t0Call;
  perf("T11_stream_complete", t0Request, {
    call_ms: callMs, output_chars: fullText.length,
    prompt_tokens: promptTokens, completion_tokens: completionTokens,
  });

  return { text: fullText, promptTokens, completionTokens, latencyMs: callMs };
}

// ── SSE Streaming Handler ────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const T0 = Date.now();
  console.log(`[PERF] T0_request_start ${new Date(T0).toISOString()} method=${req.method}`);

  // SSE headers — set before any data is written
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
    // ── T1: Auth ──────────────────────────────────────────────────────────────
    const auth = await authenticate(req);
    perf("T1_auth_resolved", T0, { status: auth.status });

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

    // ── T2: Body parsed ───────────────────────────────────────────────────────
    const body = await readBody<ChatStreamRequest>(req);
    const message = (body.message ?? "").trim();
    perf("T2_body_parsed", T0, {
      message_len:       message.length,
      doc_context_count: body.document_context?.length ?? 0,
      use_case:          body.context?.use_case ?? "grounded_chat",
    });

    if (!message) {
      sendEvent({ type: "error", errorCode: "MISSING_MESSAGE", message: "Besked mangler" });
      return res.end();
    }

    const useCase: AiUseCase = body.context?.use_case ?? "grounded_chat";

    // ── T3: Expert fetch ─────────────────────────────────────────────────────
    // Budget enforcement runs on Railway (Express server), not on Vercel.
    // Drizzle/pg.Pool has 10-20s cold-start SSL overhead → removed from serverless.
    sendEvent({ type: "status", text: "Analyserer forespørgsel..." });

    const token = (req.headers.authorization ?? "").slice(7);

    let experts: Expert[];
    try {
      const rows = await dbList("architecture_profiles", token, {
        status:           "neq.archived",
        enabled_for_chat: "eq.true",
        select:           "id,name,category,description,routing_hints,enabled_for_chat,status",
      });
      experts = rows as unknown as Expert[];
      perf("T3_experts_fetched", T0, { count: experts.length });
    } catch (e) {
      perf("T3_experts_fetched", T0, { error: (e as Error).message });
      sendEvent({ type: "error", errorCode: "EXPERT_FETCH_FAILED", message: "Kunne ikke hente eksperter" });
      return res.end();
    }

    if (!experts.length) {
      sendEvent({ type: "error", errorCode: "NO_EXPERTS_AVAILABLE", message: "Ingen AI-eksperter er tilgængelige." });
      return res.end();
    }

    // ── T5: Expert selected ───────────────────────────────────────────────────
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

    perf("T5_expert_selected", T0, {
      expert_name: expert.name,
      score:       expertScore,
    });

    const routingExplanation = `Valgt baseret på match med ekspertens kompetenceområde (${expert.category ?? expert.name}).`;

    // ── T6: Context built ─────────────────────────────────────────────────────
    const rawDocCtx  = body.document_context ?? [];
    const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
    const failedDocs = rawDocCtx.filter(d => d.status !== "ok");
    const hasDocIntent = rawDocCtx.length > 0;
    const docTextFull = docCtx.map(d => d.extracted_text).join("\n\n---\n\n");
    const totalDocChars = docTextFull.length;
    const hasDoc = docCtx.length > 0;
    const modelUsed    = "gpt-4.1-mini";
    const providerUsed = "openai";

    perf("T6_context_built", T0, {
      ok_doc_count:    docCtx.length,
      total_doc_chars: totalDocChars,
      model:           modelUsed,
      provider:        providerUsed,
    });

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

    // ── Accumulate tokens ────────────────────────────────────────────────────
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalLatencyMs = 0;
    let fullAnswer = "";

    if (hasDoc) {
      // ════════════════════════════════════════════════════════════════════════
      // DOCUMENT CHAT: OpenAI gpt-4.1-mini (128K context, fast TTFT ~2s)
      // ════════════════════════════════════════════════════════════════════════
      const docText = totalDocChars > MAX_DOC_CHARS
        ? docTextFull.slice(0, MAX_DOC_CHARS) + "\n\n[... dokument afkortet ...]"
        : docTextFull;
      const userContent = `DOKUMENT:\n\n${docText}\n\n---\n\n${message}`;

      sendEvent({ type: "status", text: "Analyserer dokument...", routeType });

      const result = await streamOpenAI("gpt-4.1-mini", docSystemPrompt, userContent, sendEvent, T0);
      totalPromptTokens     = result.promptTokens;
      totalCompletionTokens = result.completionTokens;
      totalLatencyMs        = result.latencyMs;
      fullAnswer            = result.text;

    } else {
      // ════════════════════════════════════════════════════════════════════════
      // NO DOCUMENT: Normal expert chat (OpenAI)
      // ════════════════════════════════════════════════════════════════════════
      sendEvent({ type: "status", text: "Genererer svar...", routeType });

      const result = await streamOpenAI("gpt-4.1-mini", normalSystemPrompt, message, sendEvent, T0);
      totalPromptTokens     = result.promptTokens;
      totalCompletionTokens = result.completionTokens;
      totalLatencyMs        = result.latencyMs;
      fullAnswer            = result.text;
    }

    perf("T_all_streams_complete", T0, {
      total_latency_ms:   totalLatencyMs,
      total_output_chars: fullAnswer.length,
      model:              modelUsed,
    });

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
        const { logAiUsage }    = await import("../../server/lib/ai/usage");
        const { loadPricing }   = await import("../../server/lib/ai/pricing");
        const { estimateAiCost } = await import("../../server/lib/ai/costs");
        const { pricing, source: pricingSource, version: pricingVersion } = await loadPricing(providerUsed, modelUsed);
        const actualCostUsd = estimateAiCost({
          usage: { input_tokens: totalPromptTokens, output_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens },
          pricing,
        }) ?? 0;
        await logAiUsage({
          tenantId: orgId, userId,
          requestId: body.idempotency_key ?? crypto.randomUUID(),
          feature: hasDoc ? "expert.chat.doc" : "expert.chat.stream",
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
      delsvar_count:           1,
    });

    perf("T_done_event_sent", T0, { total_request_ms: Date.now() - T0 });
    res.end();

  } catch (err) {
    const msg  = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.errorCode ?? "CHAT_STREAM_ERROR";
    console.error(`[chat-stream] error at +${Date.now() - T0}ms: ${msg}`);
    sendEvent({ type: "error", errorCode: code, message: msg });
    res.end();
  }
}
