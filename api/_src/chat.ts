import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, readBody } from "./_lib/response";
import { dbList, dbInsert } from "./_lib/db";
import { AI_MODEL_ROUTES } from "../../server/lib/ai/config";
import { isGroundedUseCase, type AiUseCase } from "../../server/lib/ai/types";

// ── Phase 6I: central model resolution (Vercel path, no DB overrides) ─────────
// Uses AI_MODEL_ROUTES from the single source-of-truth config.
// DB overrides are applied by the Express path via server/lib/ai/router.ts.
function resolveVercelModel(key: keyof typeof AI_MODEL_ROUTES = "default"): { model: string; provider: string; key: string } {
  const route = AI_MODEL_ROUTES[key] ?? AI_MODEL_ROUTES.default;
  return { model: route.model, provider: route.provider, key };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const SUPABASE_URL   = process.env.SUPABASE_URL   ?? "";
const SUPABASE_SVC   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Expert {
  id:            string;
  name:          string;
  category:      string | null;
  description:   string | null;
  routingHints:  unknown; // jsonb — may be string[] or null
  enabledForChat: boolean;
  status:        string;
}

interface DocumentContext {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error";
  message?:       string;
}

interface ChatRequest {
  message:           string;
  conversation_id?:  string | null;
  document_context?: DocumentContext[];
  context?: {
    preferred_expert_id?: string | null;
    document_ids?:        string[];
    attachment_count?:    number;
    attachment_types?:    string[];
    use_case?:            AiUseCase;
  };
}

// ── Expert scoring ────────────────────────────────────────────────────────────

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

// ── OpenAI call ───────────────────────────────────────────────────────────────

type OAIMessage = { role: "system" | "user" | "assistant"; content: string };

async function callOpenAI(messages: OAIMessage[], routeKey: keyof typeof AI_MODEL_ROUTES = "default"): Promise<{
  text:             string;
  latencyMs:        number;
  promptTokens:     number;
  completionTokens: number;
}> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ikke konfigureret");

  const route = resolveVercelModel(routeKey);
  console.log(`[ai:router] model=${route.model} provider=${route.provider} key=${route.key}`);

  const start = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model:       route.model,
      max_tokens:  2000,
      temperature: 0.2,
      messages,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage:   { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text:             data.choices[0]?.message?.content ?? "",
    latencyMs:        Date.now() - start,
    promptTokens:     data.usage?.prompt_tokens     ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function deriveConfidence(answer: string, warnings: string[], extractedText?: string): "high" | "medium" | "low" {
  if (warnings.length > 0) return "low";

  const notFoundPhrases = ["kan ikke finde", "fremgår ikke", "ikke i det uploadede"];
  if (notFoundPhrases.some(p => answer.toLowerCase().includes(p))) return "low";

  if (extractedText) {
    // Dokument-mode: confidence baseret på overlap med dokument
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

// ── Grounding validation ───────────────────────────────────────────────────────

function validateGrounding(answer: string, extractedText: string): string {
  if (!answer) return answer;

  const notFoundPhrases = ["kan ikke finde", "fremgår ikke", "ikke i det uploadede", "ikke nævnt", "ikke specificeret"];
  if (notFoundPhrases.some(p => answer.toLowerCase().includes(p))) return answer;

  const answerWords   = answer.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4);
  const docWords      = new Set(extractedText.toLowerCase().replace(/[^a-zæøå0-9\s]/gi, " ").split(/\s+/).filter(w => w.length >= 4));
  const matchingWords = answerWords.filter(w => docWords.has(w));
  const overlapRatio  = answerWords.length > 0 ? matchingWords.length / answerWords.length : 0;

  console.log(`[chat] GROUNDING: overlap=${(overlapRatio * 100).toFixed(0)}% matching=${matchingWords.length}/${answerWords.length}`);

  if (overlapRatio < 0.15 && answerWords.length > 10) {
    console.warn(`[chat] GROUNDING_FAILED: generisk svar erstattes med safe response`);
    return "Jeg kan ikke finde det sikkert i det uploadede dokument.";
  }
  return answer;
}

// ── Persist (non-fatal) ───────────────────────────────────────────────────────
// Uses service-role fetch directly — correct column names per actual DB schema:
// chat_conversations: created_by, selected_expert_id, updated_at
// chat_messages:      message_text, expert_id, metadata (jsonb)

async function persistTurn(params: {
  organizationId:   string;
  userId:           string;
  expertId:         string;
  userMessage:      string;
  answer:           string;
  existingConvId:   string | null;
  latencyMs:        number;
  confidence:       string;
  promptTokens:     number;
  completionTokens: number;
}): Promise<string> {
  const svc = {
    apikey:         SUPABASE_SVC,
    Authorization:  `Bearer ${SUPABASE_SVC}`,
    "Content-Type": "application/json",
    Prefer:         "return=representation",
  };

  let convId = params.existingConvId;

  if (!convId) {
    const convRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_conversations`, {
      method:  "POST",
      headers: svc,
      body: JSON.stringify({
        organization_id:      params.organizationId,
        created_by:           params.userId,
        selected_expert_id:   params.expertId,
        title:                params.userMessage.slice(0, 80),
        updated_at:           new Date().toISOString(),
      }),
    });
    if (!convRes.ok) throw new Error(`conv insert ${convRes.status}: ${await convRes.text()}`);
    const convData = (await convRes.json()) as Array<{ id: string }>;
    convId = convData[0]?.id ?? null;
    if (!convId) throw new Error("No conversation id returned");
  } else {
    // Update timestamp only — don't crash if this fails
    fetch(`${SUPABASE_URL}/rest/v1/chat_conversations?id=eq.${encodeURIComponent(convId)}`, {
      method:  "PATCH",
      headers: svc,
      body:    JSON.stringify({ updated_at: new Date().toISOString() }),
    }).catch(() => {/* non-fatal */});
  }

  // User message — message_text (NOT content)
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method:  "POST",
    headers: svc,
    body: JSON.stringify({
      conversation_id: convId,
      organization_id: params.organizationId,
      role:            "user",
      message_text:    params.userMessage,
    }),
  });

  // Assistant message — extra fields go in metadata jsonb
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method:  "POST",
    headers: svc,
    body: JSON.stringify({
      conversation_id: convId,
      organization_id: params.organizationId,
      role:            "assistant",
      message_text:    params.answer,
      expert_id:       params.expertId,
      metadata: {
        latency_ms:        params.latencyMs,
        confidence_band:   params.confidence,
        prompt_tokens:     params.promptTokens,
        completion_tokens: params.completionTokens,
      },
    }),
  });

  return convId as string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN",        "Platform er i lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Login krævet");

  const { user } = auth;
  const orgId    = user.organizationId;
  const userId   = user.id;

  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Kun POST tilladt");

  const body    = await readBody<ChatRequest>(req);
  const message = (body.message ?? "").trim();
  if (!message) return err(res, 400, "MISSING_MESSAGE", "Besked mangler");

  const useCase: AiUseCase = body.context?.use_case ?? "grounded_chat";

  const token = (req.headers.authorization ?? "").slice(7);

  // ── Step 1: Hent tilgængelige eksperter via bruger-JWT + RLS ──────────────
  // RLS-politik "members_can_read_experts" på architecture_profiles bruger
  // SECURITY DEFINER-funktionen chat_user_org_id() til at slå membership op
  // og returnerer kun eksperter i brugerens organisation.
  // org_id valideres fra authenticate() — aldrig fra request payload.
  let experts: Expert[];
  try {
    const rows = await dbList("architecture_profiles", token, {
      status:           "neq.archived",
      enabled_for_chat: "eq.true",
      select:           "id,name,category,description,routing_hints,enabled_for_chat,status",
    });
    experts = rows as unknown as Expert[];
  } catch (e) {
    console.error("[chat] expert fetch failed:", (e as Error).message);
    return err(res, 500, "EXPERT_FETCH_FAILED", "Kunne ikke hente eksperter");
  }

  if (!experts.length) {
    console.error(`[chat] NO_EXPERTS_AVAILABLE for org=${orgId}`);
    return err(res, 422, "NO_EXPERTS_AVAILABLE",
      "Ingen AI-eksperter er tilgængelige for din organisation.");
  }

  // ── Step 2: Vælg ekspert ──────────────────────────────────────────────────
  let expert: Expert;
  const prefId = body.context?.preferred_expert_id;

  if (prefId) {
    expert = experts.find(e => e.id === prefId) ?? experts[0];
  } else {
    const scored = experts
      .map(e => ({ expert: e, score: scoreExpert(e, message) }))
      .sort((a, b) => b.score - a.score);
    expert = scored[0].expert;
  }

  const routingExplanation =
    `Valgt baseret på match med ekspertens kompetenceområde (${expert.category ?? expert.name}).`;

  // ── Step 3: Validér + byg dokument-kontekst ──────────────────────────────
  const rawDocCtx  = body.document_context ?? [];
  const docCtx     = rawDocCtx.filter(d => d.status === "ok" && d.extracted_text?.trim());
  const failedDocs = rawDocCtx.filter(d => d.status !== "ok");
  const hasDocIntent = rawDocCtx.length > 0; // brugeren sendte dokument-intent

  // ── DIAGNOSTIC TRACE ─────────────────────────────────────────────────────
  console.log("RUNTIME_FILE: api/_src/chat.ts → api/chat.js (Vercel)");
  console.log("DOC_CTX_RAW:", rawDocCtx.length, "statuses:", rawDocCtx.map(d => d.status).join(",") || "none");
  console.log("DOC_CTX_LENGTH:", docCtx.length);
  if (docCtx.length > 0) {
    const totalChars = docCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0);
    console.log("EXTRACTED_TEXT_LENGTH:", totalChars);
    console.log("EXTRACTED_TEXT_FIRST200:", docCtx[0].extracted_text.slice(0, 200).replace(/\n/g, " "));
  }
  if (failedDocs.length > 0) {
    console.log("FAILED_DOCS:", failedDocs.map(d => `${d.filename}:${d.status}:${d.message}`).join(", "));
  }

  // HARD STOP A — attachment sendt men document_context mangler helt
  const attachmentCount = body.context?.attachment_count ?? 0;
  if (attachmentCount > 0 && rawDocCtx.length === 0) {
    console.error("[HARD-STOP] DOCUMENT_CONTEXT_MISSING: attachment_count>0 but document_context is empty");
    console.error("[HARD-STOP] MODEL_CALL_BLOCKED");
    return err(res, 422, "DOCUMENT_CONTEXT_MISSING", "Dokument er vedhæftet men dokumentindhold mangler.");
  }

  // HARD STOP B — document_context sendt men intet gyldigt indhold
  if (hasDocIntent && docCtx.length === 0) {
    const reason = failedDocs.map(d => d.message).filter(Boolean).join("; ")
      || "Ingen tekst kunne udtrækkes fra dokumentet";
    console.error(`[chat] DOCUMENT_UNREADABLE: ${reason}`);
    return err(res, 422, "DOCUMENT_UNREADABLE",
      failedDocs[0]?.status === "unsupported"
        ? `Filtype ikke understøttet. Upload PDF eller en tekstfil (.txt, .csv).`
        : `Dokumentet kunne ikke læses: ${reason}`);
  }

  // ── Step 4: System-prompt ─────────────────────────────────────────────────
  // Dokument-mode: ERSTAT expert-prompt med STRICT document-only prompt.
  // Normal mode: brug expert-prompt som sædvanlig.
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
      expert.category   ? `Dit kompetenceområde er: ${expert.category}.`   : "",
      expert.description ? `Om dig: ${expert.description}`                  : "",
      "Svar altid på dansk med klare, præcise og hjælpsomme svar.",
      "Basér dine svar på virksomhedens data, politikker og regler.",
      "Angiv tydeligt hvis du er i tvivl om noget.",
    ].filter(Boolean).join("\n");
  }

  // ── Step 5+6: Kald OpenAI ─────────────────────────────────────────────────
  let finalAnswer: string;
  let aiLatencyMs: number;
  let aiPromptTokens   = 0;
  let aiComplTokens    = 0;
  const warnings: string[] = [];

  if (docCtx.length > 0 && !isGroundedUseCase(useCase)) {
    // ── DOKUMENT-ANALYSE MODE: non-grounded + document present ────────────
    // validation / analysis / classification med dokument:
    // Kald model med expert-prompt + dokument appendet — ingen JSON-tvang,
    // ingen grounding-check, ingen NOT_FOUND fallback.
    console.log(`[chat] DOC_ANALYSIS_MODE useCase=${useCase} docCtx=${docCtx.length}`);
    const docText  = docCtx.map(d => d.extracted_text).join("\n\n---\n\n");
    const model    = resolveVercelModel();
    const t0       = Date.now();
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body:    JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `DOKUMENT:\n\n${docText}\n\n---\n\n${message}` },
        ],
      }),
    });
    aiLatencyMs = Date.now() - t0;
    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    finalAnswer    = data.choices?.[0]?.message?.content?.trim() ?? "";
    aiPromptTokens = data.usage?.prompt_tokens  ?? 0;
    aiComplTokens  = data.usage?.completion_tokens ?? 0;
    console.log(`[chat] DOC_ANALYSIS_ANSWER len=${finalAnswer.length}`);
  } else if (docCtx.length > 0) {
    // ── DOKUMENT-MODE: Structured JSON output (100% grounded) ─────────────
    // Modellen TVINGES via response_format:json_object til at returnere enten:
    //   {"found":true,  "quote":"<exact excerpt>",      "answer":"<direct answer>"}
    //   {"found":false, "answer":"Jeg kan ikke finde det i det uploadede dokument."}
    // Ingen prompt-engineering kan slå dette — det er strukturelt håndhævet.

    const docText = docCtx.map(d => d.extracted_text).join("\n\n---\n\n");
    console.log(`[chat] DOC_MODE chars=${docText.length} first200="${docText.slice(0,200).replace(/\n/g," ")}"`);

    const docSystemPrompt = [
      "Du er et præcisionssystem der KUN besvarer spørgsmål ud fra det vedlagte dokument.",
      "Du SKAL altid svare med valid JSON i ét af disse to formater:",
      "",
      'Format 1 — svar FUNDET i dokumentet:',
      '{"found": true, "quote": "<ordret citat fra dokumentet der støtter svaret>", "answer": "<kort direkte svar>"}',
      "",
      'Format 2 — svar IKKE fundet i dokumentet:',
      '{"found": false, "answer": "Jeg kan ikke finde det i det uploadede dokument."}',
      "",
      "REGLER:",
      "- quote skal være ordret tekst fra dokumentet",
      "- answer må IKKE bruge generel viden — kun dokumentet",
      "- Svar ALTID på dansk",
      "- INGEN andre formater end ovenstående JSON er tilladt",
    ].join("\n");

    const docMessages = [
      { role: "system", content: docSystemPrompt },
      { role: "user",   content: `DOKUMENT:\n\n${docText}\n\nSPØRGSMÅL: ${message}` },
    ];
    const docRoute = resolveVercelModel("default");
    console.log(`[ai:router] model=${docRoute.model} provider=${docRoute.provider} key=${docRoute.key} use_case=doc_mode`);
    console.log("FINAL_PAYLOAD:", JSON.stringify({
      model: docRoute.model, temperature: 0.0, response_format: "json_object",
      messages: [
        { role: "system", content: docSystemPrompt.slice(0, 100) + "..." },
        { role: "user",   content: `DOKUMENT (${docText.length} chars)... SPØRGSMÅL: ${message}` },
      ],
    }));

    const t0 = Date.now();
    const docRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: docRoute.model,
        temperature: 0.0,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: docMessages,
      }),
    });
    aiLatencyMs = Date.now() - t0;

    if (!docRes.ok) {
      const txt = await docRes.text().catch(() => docRes.statusText);
      console.error(`[chat] DOC_MODE OpenAI error ${docRes.status}: ${txt}`);
      return err(res, 502, "AI_EXECUTION_FAILED", "AI-eksperten kunne ikke svare i øjeblikket.");
    }

    const docData = await docRes.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    aiPromptTokens = docData.usage?.prompt_tokens ?? 0;
    aiComplTokens  = docData.usage?.completion_tokens ?? 0;

    const rawJson = docData.choices[0]?.message?.content ?? "{}";
    console.log("RAW_MODEL_OUTPUT:", rawJson);

    let parsed: { found: boolean; quote?: string; answer?: string };
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      console.error("[chat] DOC_MODE JSON parse failed — using safe response");
      parsed = { found: false, answer: "Jeg kan ikke finde det i jeres interne data." };
    }

    if (parsed.found && parsed.quote && parsed.answer) {
      finalAnswer = `${parsed.answer}\n\n*Fra dokumentet: "${parsed.quote}"*`;
      console.log(`[chat] DOC_MODE FOUND answer="${finalAnswer.slice(0,100)}"`);
    } else {
      finalAnswer = "Jeg kan ikke finde det i jeres interne data.";
      console.log("[chat] DOC_MODE NOT_FOUND");
    }

    // ── Grounding enforcement ──────────────────────────────────────────────
    const groundingDocText = docCtx.map(d => d.extracted_text).join(" ").toLowerCase();
    const groundingAnswer  = finalAnswer.toLowerCase().replace(/[*"\\]/g, " ").replace(/\s+/g, " ");
    const overlap = groundingAnswer.split(" ").filter(w => groundingDocText.includes(w)).length;
    console.log(`[chat] GROUNDING overlap=${overlap}`);
    if (overlap < 5) {
      finalAnswer = "Jeg kan ikke finde det i jeres interne data.";
      console.log("[chat] GROUNDING_OVERRIDE applied");
    }
  } else if (isGroundedUseCase(useCase)) {
    // ── INTERNAL-ONLY GATE: grounded use case + ingen intern data → blokér ─
    // document_qa / retrieval_answer / grounded_chat kræver altid docCtx.
    // Model MÅ IKKE kaldes — returner fast svar uden OpenAI-kald.
    console.log(`[chat] NO_INTERNAL_DATA_GATE: useCase=${useCase} no document context → blocked`);
    finalAnswer = "Jeg kan ikke finde det i jeres interne data.";
  } else {
    // ── NON-GROUNDED MODE: validation / analysis / classification ─────────
    // Ingen docCtx krævet — kald model direkte med expert-prompt.
    console.log(`[chat] NON_GROUNDED_MODE: useCase=${useCase} → model call allowed without docCtx`);
    const model = resolveVercelModel();
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body:    JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: message },
        ],
      }),
    });
    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    finalAnswer     = data.choices?.[0]?.message?.content?.trim() ?? "";
    aiPromptTokens  = data.usage?.prompt_tokens  ?? 0;
    aiComplTokens   = data.usage?.completion_tokens ?? 0;
    console.log(`[chat] NON_GROUNDED_ANSWER len=${finalAnswer.length}`);
  }

  // ── Vurder svar ───────────────────────────────────────────────────────────
  if (finalAnswer.length < 5) warnings.push("Svaret er meget kort.");
  const combinedDocText = docCtx.map(d => d.extracted_text).join(" ");
  const confidence  = deriveConfidence(finalAnswer, warnings, docCtx.length > 0 ? combinedDocText : undefined);
  const needsManual = confidence === "low";

  // ── Step 6: Gem i DB (non-fatal) ──────────────────────────────────────────
  let conversationId: string = body.conversation_id ?? crypto.randomUUID();
  try {
    conversationId = await persistTurn({
      organizationId:   orgId,
      userId,
      expertId:         expert.id,
      userMessage:      message,
      answer:           finalAnswer,
      existingConvId:   body.conversation_id ?? null,
      latencyMs:        aiLatencyMs,
      confidence,
      promptTokens:     aiPromptTokens,
      completionTokens: aiComplTokens,
    });
  } catch (e) {
    // Persistence failure must NOT break the chat response
    console.error("[chat] persist failed (non-fatal):", (e as Error).message);
  }

  // ── Step 7: Returner svar ─────────────────────────────────────────────────
  const traceId = (body as any)._trace_id ?? "no-id";
  return json(res, {
    answer:              finalAnswer,
    conversation_id:     conversationId,
    expert:              { id: expert.id, name: expert.name, category: expert.category ?? null },
    used_sources:        [],
    _trace: {
      trace_id:          traceId,
      runtime_file:      "api/chat.js (Vercel)",
      raw_doc_ctx:       rawDocCtx.length,
      doc_ctx_ok:        docCtx.length,
      document_mode:     docCtx.length > 0,
      extracted_chars:   docCtx.reduce((s, d) => s + (d.extracted_text?.length ?? 0), 0),
      extracted_first50: docCtx[0]?.extracted_text?.slice(0, 50).replace(/\n/g, " ") ?? null,
      mode:              docCtx.length > 0 ? "document" : "normal",
      failed_docs:       failedDocs.map(d => ({ filename: d.filename, status: d.status, message: d.message })),
    },
    used_rules:          [],
    warnings,
    latency_ms:          aiLatencyMs,
    confidence_band:     confidence,
    needs_manual_review: needsManual,
    routing_explanation: routingExplanation,
  });
}
