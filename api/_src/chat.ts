import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, readBody } from "./_lib/response";
import { dbList, dbInsert } from "./_lib/db";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const SUPABASE_URL   = process.env.SUPABASE_URL   ?? "";
const SUPABASE_SVC   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Expert {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  systemPrompt: string | null;
  routingHints: string[] | null;
  enabledForChat: boolean;
  archived: boolean;
}

interface ChatRequest {
  message: string;
  conversation_id?: string | null;
  context?: {
    preferred_expert_id?: string | null;
    document_ids?: string[];
    attachment_count?: number;
    attachment_types?: string[];
  };
}

// ── Expert scoring ────────────────────────────────────────────────────────────

function scoreExpert(expert: Expert, message: string): number {
  const lower = message.toLowerCase();
  let score   = 0;

  const hints = expert.routingHints ?? [];
  for (const hint of hints) {
    if (lower.includes(hint.toLowerCase())) score += 10;
  }
  if (expert.category && lower.includes(expert.category.toLowerCase())) score += 6;
  if (lower.includes(expert.name.toLowerCase())) score += 4;
  if (expert.description && lower.includes(expert.description.toLowerCase().slice(0, 20))) score += 1;

  return score;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt: string, userMessage: string): Promise<{
  text: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const start = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model:       "gpt-4o-mini",
      max_tokens:  1500,
      temperature: 0.2,
      messages: [
        { role: "system",  content: systemPrompt },
        { role: "user",    content: userMessage  },
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

// ── Confidence scoring ────────────────────────────────────────────────────────

function deriveConfidence(answer: string, warnings: string[]): "high" | "medium" | "low" {
  if (warnings.length > 0) return "low";
  const hedges = ["ikke sikker", "ved ikke", "begrænset", "usikkert", "muligvis", "kan ikke garantere"];
  if (hedges.some(h => answer.toLowerCase().includes(h))) return "medium";
  return "high";
}

// ── Persist conversation + message ────────────────────────────────────────────

async function persistTurn(params: {
  organizationId: string;
  userId:         string;
  expertId:       string;
  userMessage:    string;
  answer:         string;
  existingConvId: string | null;
  latencyMs:      number;
  confidence:     string;
  promptTokens:   number;
  completionTokens: number;
}): Promise<string> {
  const svc = { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}`, "Content-Type": "application/json", Prefer: "return=representation" };

  let convId = params.existingConvId;

  if (!convId) {
    const convRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_conversations`, {
      method: "POST",
      headers: svc,
      body: JSON.stringify({
        organization_id:        params.organizationId,
        user_id:                params.userId,
        expert_id:              params.expertId,
        title:                  params.userMessage.slice(0, 80),
        last_message_at:        new Date().toISOString(),
      }),
    });
    if (!convRes.ok) throw new Error(`conv insert: ${await convRes.text()}`);
    const convData = (await convRes.json()) as Array<{ id: string }>;
    convId = convData[0]?.id;
    if (!convId) throw new Error("No conversation id returned");
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_conversations?id=eq.${convId}`, {
      method: "PATCH",
      headers: svc,
      body: JSON.stringify({ last_message_at: new Date().toISOString() }),
    });
  }

  // User message
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({
      conversation_id: convId,
      organization_id: params.organizationId,
      role:            "user",
      content:         params.userMessage,
    }),
  });

  // Assistant message
  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({
      conversation_id:   convId,
      organization_id:   params.organizationId,
      role:              "assistant",
      content:           params.answer,
      expert_id:         params.expertId,
      latency_ms:        params.latencyMs,
      confidence_band:   params.confidence,
      prompt_tokens:     params.promptTokens,
      completion_tokens: params.completionTokens,
    }),
  });

  return convId;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform er i lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Login krævet");

  const { user } = auth;
  const orgId    = user.organizationId;
  const userId   = user.id;

  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Kun POST");

  const body = await readBody<ChatRequest>(req);
  const message = (body.message ?? "").trim();
  if (!message) return err(res, 400, "MISSING_MESSAGE", "Besked mangler");

  const token = (req.headers.authorization ?? "").slice(7);

  try {
    // 1. Hent aktive eksperter for org
    const experts = (await dbList("architecture_profiles", token, {
      organization_id: `eq.${orgId}`,
      archived:        "eq.false",
      enabled_for_chat: "eq.true",
      select:          "id,name,category,description,system_prompt,routing_hints,enabled_for_chat,archived",
    })) as unknown as Expert[];

    if (!experts.length) {
      return err(res, 422, "NO_EXPERTS_AVAILABLE", "Ingen AI-eksperter er opsat for din organisation");
    }

    // 2. Vælg ekspert
    let expert: Expert;
    const prefId = body.context?.preferred_expert_id;

    if (prefId) {
      const pref = experts.find(e => e.id === prefId);
      expert = pref ?? experts[0];
    } else {
      const scored = experts.map(e => ({ expert: e, score: scoreExpert(e, message) }));
      scored.sort((a, b) => b.score - a.score);
      expert = scored[0].expert;
    }

    const routingExplanation = `Valgt baseret på match med ekspertens kompetenceområde (${expert.category ?? expert.name}).`;

    // 3. Byg system-prompt
    const systemPrompt = [
      expert.systemPrompt ?? `Du er en AI-ekspert ved navn ${expert.name}.`,
      `Du arbejder for organisation ${orgId}.`,
      "Svar altid på dansk med klare, præcise svar baseret på de tilgængelige oplysninger.",
      "Hvis du er i tvivl, angiv det tydeligt.",
    ].filter(Boolean).join("\n");

    // 4. Kald OpenAI
    const aiResult = await callOpenAI(systemPrompt, message);

    // 5. Vurder svar
    const warnings: string[] = [];
    if (aiResult.text.length < 30) warnings.push("Svaret er meget kort — der kan mangle information.");
    const confidence = deriveConfidence(aiResult.text, warnings);
    const needsManual = confidence === "low" || warnings.length > 0;

    // 6. Gem i DB
    const conversationId = await persistTurn({
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

    // 7. Svar
    return json(res, {
      answer:            aiResult.text,
      conversation_id:   conversationId,
      expert:            { id: expert.id, name: expert.name, category: expert.category ?? null },
      used_sources:      [],
      used_rules:        [],
      warnings,
      latency_ms:        aiResult.latencyMs,
      confidence_band:   confidence,
      needs_manual_review: needsManual,
      routing_explanation: routingExplanation,
    });

  } catch (e) {
    const msg = (e as Error).message ?? "Ukendt fejl";
    if (msg.includes("NO_EXPERTS_AVAILABLE")) return err(res, 422, "NO_EXPERTS_AVAILABLE", msg);
    return err(res, 500, "CHAT_ERROR", msg);
  }
}
