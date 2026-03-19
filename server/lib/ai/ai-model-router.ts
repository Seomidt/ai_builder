/**
 * Phase 12 — AI Model Router
 * Selects optimal model based on prompt config, token limit, and availability.
 * Security: input validation, availability check, fallback guard.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export interface AiModelRecord {
  id: string;
  provider: string;
  modelName: string;
  maxTokens: number;
  contextWindow: number;
  costPrompt: number;
  costCompletion: number;
  isActive: boolean;
}

// ─── Default seed models ─────────────────────────────────────────────────────
export const DEFAULT_MODELS: Omit<AiModelRecord, "id">[] = [
  { provider: "openai",    modelName: "gpt-4o",            maxTokens: 4096,  contextWindow: 128000, costPrompt: 0.005,  costCompletion: 0.015,  isActive: true },
  { provider: "openai",    modelName: "gpt-4o-mini",       maxTokens: 4096,  contextWindow: 128000, costPrompt: 0.00015,costCompletion: 0.0006, isActive: true },
  { provider: "openai",    modelName: "gpt-3.5-turbo",     maxTokens: 4096,  contextWindow: 16385,  costPrompt: 0.0005, costCompletion: 0.0015, isActive: true },
  { provider: "anthropic", modelName: "claude-3-5-haiku",  maxTokens: 4096,  contextWindow: 200000, costPrompt: 0.0008, costCompletion: 0.004,  isActive: true },
  { provider: "anthropic", modelName: "claude-3-5-sonnet", maxTokens: 8192,  contextWindow: 200000, costPrompt: 0.003,  costCompletion: 0.015,  isActive: true },
  { provider: "simulation",modelName: "sim-gpt-1",         maxTokens: 4096,  contextWindow: 32768,  costPrompt: 0.0,    costCompletion: 0.0,    isActive: true },
];

function rowToModel(r: Record<string, unknown>): AiModelRecord {
  return {
    id: r["id"] as string,
    provider: r["provider"] as string,
    modelName: r["model_name"] as string,
    maxTokens: r["max_tokens"] as number,
    contextWindow: r["context_window"] as number,
    costPrompt: parseFloat((r["cost_prompt"] as string) ?? "0"),
    costCompletion: parseFloat((r["cost_completion"] as string) ?? "0"),
    isActive: r["is_active"] as boolean,
  };
}

// ─── seedDefaultModels ───────────────────────────────────────────────────────
export async function seedDefaultModels(client: pg.Client): Promise<{ seeded: number; existing: number }> {
  let seeded = 0;
  let existing = 0;
  for (const m of DEFAULT_MODELS) {
    const ex = await client.query(`SELECT id FROM public.ai_models WHERE provider=$1 AND model_name=$2`, [m.provider, m.modelName]);
    if (ex.rows.length > 0) { existing++; continue; }
    await client.query(
      `INSERT INTO public.ai_models (id,provider,model_name,max_tokens,context_window,cost_prompt,cost_completion,is_active)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7)`,
      [m.provider, m.modelName, m.maxTokens, m.contextWindow, m.costPrompt, m.costCompletion, m.isActive],
    );
    seeded++;
  }
  return { seeded, existing };
}

// ─── listModels ──────────────────────────────────────────────────────────────
export async function listModels(activeOnly = true): Promise<AiModelRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const cond = activeOnly ? "WHERE is_active = true" : "";
    const r = await client.query(`SELECT * FROM public.ai_models ${cond} ORDER BY provider, model_name`);
    return r.rows.map(rowToModel);
  } finally {
    await client.end();
  }
}

// ─── getModelById ────────────────────────────────────────────────────────────
export async function getModelById(id: string, client?: pg.Client): Promise<AiModelRecord | null> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(`SELECT * FROM public.ai_models WHERE id=$1`, [id]);
    return r.rows.length ? rowToModel(r.rows[0]) : null;
  } finally {
    if (useExt) await c.end();
  }
}

// ─── selectModel ─────────────────────────────────────────────────────────────
// Selects model based on: preferred model, required context, availability.
export async function selectModel(params: {
  preferredProvider?: string;
  requiredContextTokens?: number;
  preferredModelName?: string;
  client?: pg.Client;
}): Promise<AiModelRecord> {
  const { preferredProvider, requiredContextTokens = 0, preferredModelName } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();

  try {
    // Try exact match first
    if (preferredModelName) {
      const r = await client.query(
        `SELECT * FROM public.ai_models WHERE model_name=$1 AND is_active=true AND context_window>=$2 LIMIT 1`,
        [preferredModelName, requiredContextTokens],
      );
      if (r.rows.length) return rowToModel(r.rows[0]);
    }
    // Provider preference
    if (preferredProvider) {
      const r = await client.query(
        `SELECT * FROM public.ai_models WHERE provider=$1 AND is_active=true AND context_window>=$2 ORDER BY cost_prompt ASC LIMIT 1`,
        [preferredProvider, requiredContextTokens],
      );
      if (r.rows.length) return rowToModel(r.rows[0]);
    }
    // Cheapest available model with sufficient context
    const r = await client.query(
      `SELECT * FROM public.ai_models WHERE is_active=true AND context_window>=$1 ORDER BY cost_prompt ASC LIMIT 1`,
      [requiredContextTokens],
    );
    if (r.rows.length) return rowToModel(r.rows[0]);

    // Absolute fallback — simulation model
    const fallback = await client.query(`SELECT * FROM public.ai_models WHERE provider='simulation' AND is_active=true LIMIT 1`);
    if (fallback.rows.length) return rowToModel(fallback.rows[0]);

    throw new Error("No active AI models available — run seedDefaultModels first");
  } finally {
    if (useExt) await client.end();
  }
}

// ─── deactivateModel ─────────────────────────────────────────────────────────
export async function deactivateModel(modelId: string): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    await client.query(`UPDATE public.ai_models SET is_active=false WHERE id=$1`, [modelId]);
  } finally {
    await client.end();
  }
}
