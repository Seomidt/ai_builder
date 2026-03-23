import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, readBody } from "./_lib/response";
import { dbList, dbInsert } from "./_lib/db";

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

interface ChatRequest {
  message:          string;
  conversation_id?: string | null;
  context?: {
    preferred_expert_id?: string | null;
    document_ids?:        string[];
    attachment_count?:    number;
    attachment_types?:    string[];
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

async function callOpenAI(systemPrompt: string, userMessage: string): Promise<{
  text:             string;
  latencyMs:        number;
  promptTokens:     number;
  completionTokens: number;
}> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ikke konfigureret");

  const start = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model:       "gpt-4o-mini",
      max_tokens:  1500,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  },
      ],
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

function deriveConfidence(answer: string, warnings: string[]): "high" | "medium" | "low" {
  if (warnings.length > 0) return "low";
  const hedges = ["ikke sikker", "ved ikke", "begrænset", "muligvis", "kan ikke garantere"];
  return hedges.some(h => answer.toLowerCase().includes(h)) ? "medium" : "high";
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

  const token = (req.headers.authorization ?? "").slice(7);

  // ── Step 1: Hent aktive eksperter med service role (bypasser RLS) ──────────
  // org_id er altid fra authenticate — aldrig fra request payload.
  let experts: Expert[];
  try {
    const svcHeaders = {
      apikey:         SUPABASE_SVC,
      Authorization:  `Bearer ${SUPABASE_SVC}`,
      "Content-Type": "application/json",
    };
    const qs = new URLSearchParams({
      organization_id:  `eq.${orgId}`,
      status:           "neq.archived",
      enabled_for_chat: "eq.true",
      select:           "id,name,category,description,routing_hints,enabled_for_chat,status",
    }).toString();
    const expertRes = await fetch(`${SUPABASE_URL}/rest/v1/architecture_profiles?${qs}`, {
      headers: svcHeaders,
    });
    if (!expertRes.ok) {
      const txt = await expertRes.text();
      throw new Error(`${expertRes.status}: ${txt}`);
    }
    experts = (await expertRes.json()) as Expert[];
  } catch (e) {
    console.error("[chat] expert fetch failed:", (e as Error).message);
    return err(res, 500, "EXPERT_FETCH_FAILED", "Kunne ikke hente eksperter: " + (e as Error).message);
  }

  if (!experts.length) {
    return err(res, 422, "NO_EXPERTS_AVAILABLE",
      "Ingen AI-eksperter er tilgængelige. Aktivér mindst én ekspert til chat i indstillingerne.");
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

  // ── Step 3: System-prompt ─────────────────────────────────────────────────
  const systemPrompt = [
    `Du er en AI-ekspert ved navn ${expert.name}.`,
    expert.category ? `Dit kompetenceområde er: ${expert.category}.` : "",
    expert.description ? `Om dig: ${expert.description}` : "",
    "Svar altid på dansk med klare, præcise og hjælpsomme svar.",
    "Basér dine svar på virksomhedens data, politikker og regler.",
    "Angiv tydeligt hvis du er i tvivl om noget.",
  ].filter(Boolean).join("\n");

  // ── Step 4: Kald OpenAI ───────────────────────────────────────────────────
  let aiResult: Awaited<ReturnType<typeof callOpenAI>>;
  try {
    aiResult = await callOpenAI(systemPrompt, message);
  } catch (e) {
    console.error("[chat] OpenAI call failed:", (e as Error).message);
    return err(res, 502, "AI_EXECUTION_FAILED",
      "AI-eksperten kunne ikke svare i øjeblikket. Prøv igen om lidt.");
  }

  if (!aiResult.text) {
    return err(res, 502, "AI_EMPTY_RESPONSE", "AI-eksperten returnerede et tomt svar.");
  }

  // ── Step 5: Vurder svar ───────────────────────────────────────────────────
  const warnings: string[] = [];
  if (aiResult.text.length < 20) warnings.push("Svaret er meget kort — der kan mangle information.");
  const confidence  = deriveConfidence(aiResult.text, warnings);
  const needsManual = confidence === "low";

  // ── Step 6: Gem i DB (non-fatal) ──────────────────────────────────────────
  let conversationId: string = body.conversation_id ?? crypto.randomUUID();
  try {
    conversationId = await persistTurn({
      organizationId:   orgId,
      userId,
      expertId:         expert.id,
      userMessage:      message,
      answer:           aiResult.text,
      existingConvId:   body.conversation_id ?? null,
      latencyMs:        aiResult.latencyMs,
      confidence,
      promptTokens:     aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    });
  } catch (e) {
    // Persistence failure must NOT break the chat response
    console.error("[chat] persist failed (non-fatal):", (e as Error).message);
  }

  // ── Step 7: Returner svar ─────────────────────────────────────────────────
  return json(res, {
    answer:              aiResult.text,
    conversation_id:     conversationId,
    expert:              { id: expert.id, name: expert.name, category: expert.category ?? null },
    used_sources:        [],
    used_rules:          [],
    warnings,
    latency_ms:          aiResult.latencyMs,
    confidence_band:     confidence,
    needs_manual_review: needsManual,
    routing_explanation: routingExplanation,
  });
}
