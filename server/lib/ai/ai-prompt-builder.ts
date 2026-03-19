/**
 * Phase 12 — AI Prompt Builder
 * Manages prompts and versions in DB. Builds final prompt from context + query.
 * INV-AI2: System prompt must not be overrideable by user input.
 * INV-AI5: Prompt version must be tenant-scoped.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export interface PromptRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface PromptVersionRecord {
  id: string;
  promptId: string;
  version: number;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  createdAt: Date;
}

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
  fullPromptText: string;
  estimatedTokens: number;
  promptVersionId: string;
}

function rowToPrompt(r: Record<string, unknown>): PromptRecord {
  return { id: r["id"] as string, tenantId: r["tenant_id"] as string, name: r["name"] as string, description: r["description"] as string ?? null, createdAt: new Date(r["created_at"] as string) };
}
function rowToVersion(r: Record<string, unknown>): PromptVersionRecord {
  return { id: r["id"] as string, promptId: r["prompt_id"] as string, version: r["version"] as number, systemPrompt: r["system_prompt"] as string, temperature: parseFloat(r["temperature"] as string), topP: parseFloat(r["top_p"] as string), maxTokens: r["max_tokens"] as number, createdAt: new Date(r["created_at"] as string) };
}

// ─── createPrompt ────────────────────────────────────────────────────────────
export async function createPrompt(params: { tenantId: string; name: string; description?: string; systemPrompt: string; temperature?: number; topP?: number; maxTokens?: number }): Promise<{ prompt: PromptRecord; version: PromptVersionRecord }> {
  const { tenantId, name, description, systemPrompt, temperature = 0.7, topP = 1.0, maxTokens = 1024 } = params;
  if (!tenantId || !name || !systemPrompt) throw new Error("tenantId, name, systemPrompt required");

  const client = getClient();
  await client.connect();
  try {
    const p = await client.query(
      `INSERT INTO public.ai_prompts (id, tenant_id, name, description) VALUES (gen_random_uuid()::text,$1,$2,$3) RETURNING *`,
      [tenantId, name, description ?? null],
    );
    const prompt = rowToPrompt(p.rows[0]);
    const v = await client.query(
      `INSERT INTO public.ai_prompt_versions (id, prompt_id, version, system_prompt, temperature, top_p, max_tokens)
       VALUES (gen_random_uuid()::text,$1,1,$2,$3,$4,$5) RETURNING *`,
      [prompt.id, systemPrompt, temperature, topP, maxTokens],
    );
    return { prompt, version: rowToVersion(v.rows[0]) };
  } finally {
    await client.end();
  }
}

// ─── addPromptVersion ────────────────────────────────────────────────────────
export async function addPromptVersion(params: { promptId: string; tenantId: string; systemPrompt: string; temperature?: number; topP?: number; maxTokens?: number }): Promise<PromptVersionRecord> {
  const { promptId, tenantId, systemPrompt, temperature = 0.7, topP = 1.0, maxTokens = 1024 } = params;
  const client = getClient();
  await client.connect();
  try {
    // INV-AI5: Verify prompt belongs to tenant
    const check = await client.query(`SELECT id FROM public.ai_prompts WHERE id=$1 AND tenant_id=$2`, [promptId, tenantId]);
    if (!check.rows.length) throw new Error(`INV-AI5: Prompt ${promptId} not found for tenant ${tenantId}`);

    const maxVer = await client.query(`SELECT COALESCE(MAX(version),0) as maxv FROM public.ai_prompt_versions WHERE prompt_id=$1`, [promptId]);
    const nextVersion = parseInt(maxVer.rows[0].maxv, 10) + 1;

    const v = await client.query(
      `INSERT INTO public.ai_prompt_versions (id,prompt_id,version,system_prompt,temperature,top_p,max_tokens)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6) RETURNING *`,
      [promptId, nextVersion, systemPrompt, temperature, topP, maxTokens],
    );
    return rowToVersion(v.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listPrompts ─────────────────────────────────────────────────────────────
export async function listPrompts(tenantId: string): Promise<PromptRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.ai_prompts WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    return r.rows.map(rowToPrompt);
  } finally {
    await client.end();
  }
}

// ─── listPromptVersions ──────────────────────────────────────────────────────
export async function listPromptVersions(promptId: string, tenantId: string): Promise<PromptVersionRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const check = await client.query(`SELECT id FROM public.ai_prompts WHERE id=$1 AND tenant_id=$2`, [promptId, tenantId]);
    if (!check.rows.length) throw new Error(`INV-AI5: Prompt not found for tenant`);
    const r = await client.query(`SELECT * FROM public.ai_prompt_versions WHERE prompt_id=$1 ORDER BY version ASC`, [promptId]);
    return r.rows.map(rowToVersion);
  } finally {
    await client.end();
  }
}

// ─── getPromptVersion ────────────────────────────────────────────────────────
export async function getPromptVersion(versionId: string, client?: pg.Client): Promise<PromptVersionRecord | null> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(`SELECT * FROM public.ai_prompt_versions WHERE id=$1`, [versionId]);
    return r.rows.length ? rowToVersion(r.rows[0]) : null;
  } finally {
    if (useExt) await c.end();
  }
}

// ─── buildPrompt ─────────────────────────────────────────────────────────────
// INV-AI2: System prompt is injected BEFORE user query — user cannot override.
export function buildPrompt(params: {
  promptVersion: PromptVersionRecord;
  contextText: string;
  queryText: string;
}): BuiltPrompt {
  const { promptVersion, contextText, queryText } = params;

  // INV-AI2: System prompt is SEALED — user content injected only in <QUERY> block
  const systemPrompt = promptVersion.systemPrompt;

  const userMessage = [
    "CONTEXT FROM KNOWLEDGE BASE:",
    "---",
    contextText || "(No retrieval context available)",
    "---",
    "",
    "USER QUERY:",
    queryText,
  ].join("\n");

  const fullPromptText = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;
  const estimatedTokens = Math.ceil(fullPromptText.length / 4);

  return { systemPrompt, userMessage, fullPromptText, estimatedTokens, promptVersionId: promptVersion.id };
}

// ─── getLatestPromptVersion ──────────────────────────────────────────────────
export async function getLatestPromptVersion(promptId: string, tenantId: string): Promise<PromptVersionRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const check = await client.query(`SELECT id FROM public.ai_prompts WHERE id=$1 AND tenant_id=$2`, [promptId, tenantId]);
    if (!check.rows.length) return null;
    const r = await client.query(`SELECT * FROM public.ai_prompt_versions WHERE prompt_id=$1 ORDER BY version DESC LIMIT 1`, [promptId]);
    return r.rows.length ? rowToVersion(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}
