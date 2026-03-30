/**
 * api/_src/experts.ts — Vercel Serverless Handler for /api/experts/*
 *
 * Routes:
 *   GET    /api/experts                                         list
 *   POST   /api/experts                                         create
 *   GET    /api/experts/:id                                     detail (rules/sources/versions)
 *   PATCH  /api/experts/:id                                     update
 *   POST   /api/experts/:id/archive
 *   POST   /api/experts/:id/unarchive
 *   POST   /api/experts/:id/pause
 *   POST   /api/experts/:id/resume
 *   POST   /api/experts/:id/duplicate
 *   POST   /api/experts/:id/promote
 *   GET    /api/experts/:id/versions
 *   GET    /api/experts/:id/rules
 *   POST   /api/experts/:id/rules
 *   PUT    /api/experts/:id/rules/:ruleId
 *   DELETE /api/experts/:id/rules/:ruleId
 *   GET    /api/experts/:id/sources
 *   POST   /api/experts/:id/sources
 *   PATCH  /api/experts/:id/sources/:sourceId
 *   DELETE /api/experts/:id/sources/:sourceId
 *   POST   /api/experts/:id/sources/:sourceId/analyze-authenticity
 *   POST   /api/experts/ai-suggest
 *   POST   /api/experts/ai-refine
 *   POST   /api/experts/:id/test
 */

import "../../server/lib/env.ts";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const CreateArchitectureSchema = z.object({
  name:         z.string().min(1, "name is required"),
  slug:         z.string().regex(/^[a-z0-9-]+$/).optional(),
  description:  z.string().optional(),
  category:     z.string().optional(),
  departmentId: z.string().optional(),
  language:     z.string().optional().default("da"),
  goal:         z.string().optional(),
  instructions: z.string().optional(),
  outputStyle:  z.string().optional(),
});

const UpdateExpertSchema = z.object({
  name:             z.string().min(1).optional(),
  description:      z.string().optional(),
  goal:             z.string().optional(),
  instructions:     z.string().optional(),
  outputStyle:      z.enum(["concise", "formal", "advisory"]).optional(),
  language:         z.string().optional(),
  departmentId:     z.string().optional(),
  escalationPolicy: z.record(z.unknown()).optional(),
});

const CreateSpecialistRuleSchema = z.object({
  type:             z.enum(["decision", "threshold", "required_evidence", "source_restriction", "escalation"]),
  name:             z.string().min(1),
  description:      z.string().optional(),
  priority:         z.number().int().min(1).max(999).default(100),
  enforcementLevel: z.enum(["hard", "soft"]).default("soft"),
  config:           z.record(z.unknown()).optional(),
});

const UpdateRuleSchema = z.object({
  type:             z.string().optional(),
  name:             z.string().min(1).optional(),
  description:      z.string().optional(),
  priority:         z.number().int().min(1).max(999).optional(),
  enforcementLevel: z.enum(["hard", "soft"]).optional(),
  config:           z.record(z.unknown()).optional(),
});

const CreateSpecialistSourceSchema = z.object({
  sourceName:   z.string().min(1),
  sourceType:   z.enum(["document", "policy", "legal", "rulebook", "image", "other"]).default("document"),
  projectId:    z.string().optional(),
  dataSourceId: z.string().optional(),
});

const UpdateSourceSchema = z.object({
  status:          z.enum(["pending", "processed", "failed", "linked"]).optional(),
  processingNotes: z.string().optional(),
  chunksCount:     z.number().int().optional(),
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jsonOut(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(payload);
}

function ok(res: ServerResponse, body: unknown, status = 200): void {
  jsonOut(res, status, body);
}

function notFound(res: ServerResponse, msg = "Ikke fundet"): void {
  jsonOut(res, 404, { error_code: "NOT_FOUND", message: msg });
}

function badRequest(res: ServerResponse, msg: string): void {
  jsonOut(res, 400, { error_code: "BAD_REQUEST", message: msg });
}

function handleErr(res: ServerResponse, err: unknown, label = "experts"): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[vercel/${label}]`, msg);
  if (!res.headersSent) jsonOut(res, 500, { error_code: "INTERNAL_ERROR", message: msg });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getDb() {
  const { db } = await import("../../server/db");
  return db;
}

async function loadExpert(expertId: string, orgId: string) {
  const db = await getDb();
  const { architectureProfiles } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const [expert] = await db
    .select()
    .from(architectureProfiles)
    .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)));
  return expert ?? null;
}

async function loadVersion(versionId: string, orgId: string) {
  const db = await getDb();
  const { expertVersions } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const [version] = await db
    .select()
    .from(expertVersions)
    .where(and(eq(expertVersions.id, versionId), eq(expertVersions.organizationId, orgId)));
  return version ?? null;
}

async function buildAndUpsertDraft(expertId: string, orgId: string, userId: string | null) {
  const db = await getDb();
  const { architectureProfiles, specialistRules, specialistSources, expertVersions } = await import("../../shared/schema");
  const { eq, and, asc, desc } = await import("drizzle-orm");
  const { buildVersionSnapshot } = await import("../../server/lib/ai/expert-prompt-builder");

  const [expert] = await db.select().from(architectureProfiles)
    .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)));
  if (!expert) throw new Error("Expert not found");

  const rules = await db.select().from(specialistRules)
    .where(and(eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId)))
    .orderBy(asc(specialistRules.priority));

  const sources = await db.select().from(specialistSources)
    .where(and(eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)));

  const snapshot = buildVersionSnapshot({
    expert: {
      name: expert.name, description: expert.description,
      departmentId: expert.departmentId, language: expert.language ?? "da",
      instructions: expert.instructions, goal: expert.goal,
      outputStyle: expert.outputStyle, escalationPolicy: expert.escalationPolicy,
    },
    rules: rules.map((r) => ({
      id: r.id, type: r.type, name: r.name, description: r.description ?? null,
      priority: r.priority, enforcementLevel: r.enforcementLevel,
    })),
    sources: sources.map((s) => ({
      id: s.id, sourceName: s.sourceName, sourceType: s.sourceType, status: s.status,
    })),
  });

  if (expert.draftVersionId) {
    const [updated] = await db
      .update(expertVersions)
      .set({ configJson: snapshot as any })
      .where(and(eq(expertVersions.id, expert.draftVersionId), eq(expertVersions.organizationId, orgId)))
      .returning();
    return updated;
  }

  const [latest] = await db
    .select()
    .from(expertVersions)
    .where(eq(expertVersions.expertId, expertId))
    .orderBy(desc(expertVersions.versionNumber))
    .limit(1);
  const nextNum = (latest?.versionNumber ?? 0) + 1;

  const [newDraft] = await db
    .insert(expertVersions)
    .values({
      expertId, organizationId: orgId, versionNumber: nextNum,
      status: "draft", configJson: snapshot as any,
      createdBy: userId ?? undefined,
    })
    .returning();

  await db
    .update(architectureProfiles)
    .set({ draftVersionId: newDraft.id, updatedAt: new Date() })
    .where(eq(architectureProfiles.id, expertId));

  return newDraft;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function listExperts(orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { architectureProfiles } = await import("../../shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(architectureProfiles)
      .where(eq(architectureProfiles.organizationId, orgId));
    ok(res, rows);
  } catch (err) { handleErr(res, err, "experts/list"); }
}

async function createExpert(orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const data = CreateArchitectureSchema.parse(body);
    let slug = data.slug;
    if (!slug?.trim()) {
      const base = data.name.toLowerCase()
        .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ekspert";
      slug = `${base}-${Date.now().toString(36)}`;
    }
    const db = await getDb();
    const { architectureProfiles } = await import("../../shared/schema");
    const [row] = await db.insert(architectureProfiles)
      .values({ ...data, slug, language: "da", organizationId: orgId, createdBy: userId })
      .returning();
    ok(res, row, 201);
  } catch (err) { handleErr(res, err, "experts/create"); }
}

async function getExpert(expertId: string, orgId: string, res: ServerResponse) {
  try {
    const expert = await loadExpert(expertId, orgId);
    if (!expert) return notFound(res, "Expert not found");

    const db = await getDb();
    const { specialistRules, specialistSources } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const [rules, sources] = await Promise.all([
      db.select().from(specialistRules)
        .where(and(eq(specialistRules.expertId, expert.id), eq(specialistRules.organizationId, orgId))),
      db.select().from(specialistSources)
        .where(and(eq(specialistSources.expertId, expert.id), eq(specialistSources.organizationId, orgId))),
    ]);

    let liveConfig: unknown = null;
    let draftConfig: unknown = null;
    if (expert.currentVersionId) { const v = await loadVersion(expert.currentVersionId, orgId); liveConfig = v?.configJson ?? null; }
    if (expert.draftVersionId)   { const v = await loadVersion(expert.draftVersionId, orgId);   draftConfig = v?.configJson ?? null; }

    ok(res, { ...expert, rule_count: rules.length, source_count: sources.length, live_config: liveConfig, draft_config: draftConfig });
  } catch (err) { handleErr(res, err, "experts/get"); }
}

async function updateExpert(expertId: string, orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const data = UpdateExpertSchema.parse(body);
    const db = await getDb();
    const { architectureProfiles } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [updated] = await db
      .update(architectureProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)))
      .returning();
    if (!updated) return notFound(res, "Expert not found");
    buildAndUpsertDraft(expertId, orgId, userId).catch((e) => console.error("[experts/patch] draft error:", e));
    ok(res, updated);
  } catch (err) { handleErr(res, err, "experts/update"); }
}

async function setExpertStatus(expertId: string, orgId: string, status: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { architectureProfiles } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [updated] = await db
      .update(architectureProfiles)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)))
      .returning();
    if (!updated) return notFound(res, "Expert not found");
    ok(res, updated);
  } catch (err) { handleErr(res, err, `experts/${status}`); }
}

async function duplicateExpert(expertId: string, orgId: string, userId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { architectureProfiles } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [src] = await db.select().from(architectureProfiles)
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)));
    if (!src) return notFound(res, "Expert not found");
    const slug = `${src.slug}-kopi-${Date.now().toString(36)}`;
    const [copy] = await db.insert(architectureProfiles).values({
      organizationId: orgId, createdBy: userId,
      name: `${src.name} (kopi)`, slug, description: src.description,
      goal: src.goal, instructions: src.instructions, outputStyle: src.outputStyle,
      departmentId: src.departmentId, language: src.language ?? "da", status: "draft",
    }).returning();
    ok(res, copy);
  } catch (err) { handleErr(res, err, "experts/duplicate"); }
}

async function promoteExpert(expertId: string, orgId: string, userId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { architectureProfiles, expertVersions } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const expert = await loadExpert(expertId, orgId);
    if (!expert) return notFound(res, "Expert not found");

    let draftVersionId = expert.draftVersionId;
    if (!draftVersionId) {
      const newDraft = await buildAndUpsertDraft(expertId, orgId, userId);
      draftVersionId = newDraft.id;
    }

    if (expert.currentVersionId) {
      await db.update(expertVersions)
        .set({ status: "archived" })
        .where(and(eq(expertVersions.id, expert.currentVersionId), eq(expertVersions.organizationId, orgId)));
    }

    await db.update(expertVersions)
      .set({ status: "live" })
      .where(and(eq(expertVersions.id, draftVersionId!), eq(expertVersions.organizationId, orgId)));

    const [updatedExpert] = await db
      .update(architectureProfiles)
      .set({ currentVersionId: draftVersionId, draftVersionId: null, updatedAt: new Date() })
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)))
      .returning();

    ok(res, { expert: updatedExpert, promoted_version_id: draftVersionId });
  } catch (err) { handleErr(res, err, "experts/promote"); }
}

async function listVersions(expertId: string, orgId: string, res: ServerResponse) {
  try {
    const expert = await loadExpert(expertId, orgId);
    if (!expert) return notFound(res, "Expert not found");
    const db = await getDb();
    const { expertVersions } = await import("../../shared/schema");
    const { eq, and, desc } = await import("drizzle-orm");
    const versions = await db.select().from(expertVersions)
      .where(and(eq(expertVersions.expertId, expertId), eq(expertVersions.organizationId, orgId)))
      .orderBy(desc(expertVersions.versionNumber));
    ok(res, versions);
  } catch (err) { handleErr(res, err, "experts/versions"); }
}

// ── Rules ─────────────────────────────────────────────────────────────────────

async function listRules(expertId: string, orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { specialistRules } = await import("../../shared/schema");
    const { eq, and, asc } = await import("drizzle-orm");
    const rows = await db.select().from(specialistRules)
      .where(and(eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId)))
      .orderBy(asc(specialistRules.priority));
    ok(res, rows);
  } catch (err) { handleErr(res, err, "experts/rules/list"); }
}

async function createRule(expertId: string, orgId: string, body: unknown, res: ServerResponse) {
  try {
    const data = CreateSpecialistRuleSchema.parse(body);
    const db = await getDb();
    const { specialistRules } = await import("../../shared/schema");
    const [row] = await db.insert(specialistRules)
      .values({ ...data, expertId, organizationId: orgId, config: data.config ?? null })
      .returning();
    ok(res, row, 201);
  } catch (err) { handleErr(res, err, "experts/rules/create"); }
}

async function updateRule(expertId: string, ruleId: string, orgId: string, body: unknown, res: ServerResponse) {
  try {
    const data = UpdateRuleSchema.parse(body);
    const db = await getDb();
    const { specialistRules } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [updated] = await db
      .update(specialistRules)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(specialistRules.id, ruleId), eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId)))
      .returning();
    if (!updated) return notFound(res, "Rule not found");
    ok(res, updated);
  } catch (err) { handleErr(res, err, "experts/rules/update"); }
}

async function deleteRule(expertId: string, ruleId: string, orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { specialistRules } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    await db.delete(specialistRules)
      .where(and(eq(specialistRules.id, ruleId), eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId)));
    ok(res, { ok: true });
  } catch (err) { handleErr(res, err, "experts/rules/delete"); }
}

// ── Sources ───────────────────────────────────────────────────────────────────

async function listSources(expertId: string, orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { specialistSources } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const rows = await db.select().from(specialistSources)
      .where(and(eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)));
    ok(res, rows);
  } catch (err) { handleErr(res, err, "experts/sources/list"); }
}

async function createSource(expertId: string, orgId: string, body: unknown, res: ServerResponse) {
  try {
    const data = CreateSpecialistSourceSchema.parse(body);
    const db = await getDb();
    const { specialistSources } = await import("../../shared/schema");
    const [row] = await db.insert(specialistSources)
      .values({ ...data, expertId, organizationId: orgId })
      .returning();
    ok(res, row, 201);
  } catch (err) { handleErr(res, err, "experts/sources/create"); }
}

async function updateSource(expertId: string, sourceId: string, orgId: string, body: unknown, res: ServerResponse) {
  try {
    const data = UpdateSourceSchema.parse(body);
    const db = await getDb();
    const { specialistSources } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [updated] = await db
      .update(specialistSources)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(specialistSources.id, sourceId), eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)))
      .returning();
    ok(res, updated);
  } catch (err) { handleErr(res, err, "experts/sources/update"); }
}

async function deleteSource(expertId: string, sourceId: string, orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { specialistSources } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    await db.delete(specialistSources)
      .where(and(eq(specialistSources.id, sourceId), eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)));
    ok(res, { ok: true });
  } catch (err) { handleErr(res, err, "experts/sources/delete"); }
}

async function analyzeAuthenticity(expertId: string, sourceId: string, orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { specialistSources, documentRiskScores } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const [source] = await db.select().from(specialistSources)
      .where(and(eq(specialistSources.id, sourceId), eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)));
    if (!source) return notFound(res, "Source not found");

    const signals: string[] = [];
    const name = (source.sourceName ?? "").toLowerCase();
    const type = source.sourceType ?? "document";
    if (!source.sourceName || source.sourceName.length < 4) signals.push("very_short_name");
    if (source.status === "pending")  signals.push("not_yet_processed");
    if (type === "image")             signals.push("image_source_unverifiable");
    if (name.includes("test") || name.includes("demo") || name.includes("sample")) signals.push("test_or_demo_name");
    if (source.status === "failed")   signals.push("ingestion_failed");

    const riskScore = Math.min(signals.length * 0.2, 0.9);
    const riskLevel = riskScore >= 0.6 ? "high_risk" : riskScore >= 0.3 ? "medium_risk" : "low_risk";

    await db.insert(documentRiskScores).values({
      tenantId: orgId, documentId: source.id, documentVersionId: null,
      riskLevel, riskScore: riskScore.toString(), scoringVersion: "heuristic-v1",
      contributingSignals: { signals, sourceType: type, sourceName: source.sourceName },
    });

    ok(res, {
      source_id: source.id, source_name: source.sourceName,
      risk_score: riskScore, risk_level: riskLevel, signals,
      confidence: signals.length === 0 ? 0.9 : 0.6,
      has_risk: signals.length >= 2,
      checked_at: new Date().toISOString(), scoring_version: "heuristic-v1",
      notes: signals.length === 0
        ? "Ingen risikosignaler opdaget. Kilden fremstår autentisk."
        : `${signals.length} signal(er) identificeret. Verificér kildens oprindelse.`,
    });
  } catch (err) { handleErr(res, err, "experts/sources/analyze"); }
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function aiRefine(orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const data = z.object({
      field:        z.string().min(1),
      currentValue: z.string().min(1),
      action:       z.enum(["improve", "shorten", "rewrite", "more_precise"]),
    }).parse(body);

    const { runAiCall } = await import("../../server/lib/ai/runner");
    const ACTION_PROMPTS: Record<string, string> = {
      improve:      "Improve this text while keeping its meaning and purpose. Make it more professional and clear.",
      shorten:      "Shorten this text significantly while keeping all key meaning. Keep it Danish if it is Danish.",
      rewrite:      "Rewrite this text with different wording but the same intent. Keep it Danish if it is Danish.",
      more_precise: "Make this text more precise and specific. Remove vague language. Keep it Danish if it is Danish.",
    };
    const systemPrompt = `You are an expert configuration assistant for a B2B AI platform. 
The user wants to refine a specific field of their AI expert configuration.
Field being refined: "${data.field}"
Action requested: ${ACTION_PROMPTS[data.action]}
Return ONLY the refined text — no quotes, no explanation, no JSON. Just the improved text directly.`;

    const result = await runAiCall(
      { feature: "expert-refine", useCase: "configuration_assist", tenantId: orgId, userId },
      { systemPrompt, userInput: data.currentValue },
    );
    ok(res, { refined: result.content.trim() });
  } catch (err) { handleErr(res, err, "experts/ai-refine"); }
}

async function aiSuggest(orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const data = z.object({
      rawDescription: z.string().min(1),
      industry:       z.string().optional(),
      department:     z.string().optional(),
      language:       z.string().optional().default("da"),
    }).parse(body);

    const { runAiCall } = await import("../../server/lib/ai/runner");
    const langNote = data.language === "en" ? "English" : "danish";

    const systemPrompt = `You are an AI configuration assistant for a multi-tenant B2B AI specialist platform.
The user describes an AI expert they want to build. Return ONLY valid JSON with this exact schema:
{
  "suggested_name": "string",
  "improved_description": "string",
  "goal": "string",
  "instructions": "string",
  "restrictions": "string",
  "suggested_output_style": "concise | formal | advisory",
  "suggested_rules": [{"type": "string","name": "string","description": "string","priority": 100,"enforcement_level": "hard | soft"}],
  "suggested_source_types": ["document | policy | legal | rulebook | image | other"],
  "warnings": []
}
Respond only in JSON. No markdown fences. No explanation. Generate names and content in ${langNote}.`;

    const userInput = [
      data.rawDescription,
      data.industry   ? `Industry: ${data.industry}`   : "",
      data.department ? `Department: ${data.department}` : "",
    ].filter(Boolean).join("\n");

    const result = await runAiCall(
      { feature: "expert-suggest", useCase: "analysis", tenantId: orgId, userId },
      { systemPrompt, userInput },
    );

    const AiSuggestionSchema = z.object({
      suggested_name:         z.string().min(1),
      improved_description:   z.string(),
      goal:                   z.string(),
      instructions:           z.string(),
      restrictions:           z.string().optional().default(""),
      suggested_output_style: z.enum(["concise", "formal", "advisory"]).catch("advisory"),
      suggested_rules: z.array(z.object({
        type:              z.string(),
        name:              z.string(),
        description:       z.string(),
        priority:          z.number().int().catch(100),
        enforcement_level: z.enum(["hard", "soft"]).catch("soft"),
      })).default([]),
      suggested_source_types: z.array(z.string()).default([]),
      warnings:               z.array(z.string()).default([]),
    });

    let parsed: unknown;
    try { parsed = JSON.parse(result.content.replace(/```json\n?|\n?```/g, "").trim()); }
    catch { return jsonOut(res, 422, { error: "AI output could not be parsed. Please try again." }); }

    const validated = AiSuggestionSchema.safeParse(parsed);
    if (!validated.success) return jsonOut(res, 422, { error: "AI output did not match expected schema. Please try again." });
    ok(res, validated.data);
  } catch (err) { handleErr(res, err, "experts/ai-suggest"); }
}

async function testExpert(expertId: string, orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const data = z.object({
      prompt:  z.string().min(1),
      version: z.enum(["draft", "live"]).optional().default("live"),
    }).parse(body);

    const startMs = Date.now();
    const expert = await loadExpert(expertId, orgId);
    if (!expert) return notFound(res, "Expert not found or access denied.");
    if (expert.status === "archived") return badRequest(res, "Expert is archived.");

    const { buildExpertPromptFromSnapshot, buildExpertPrompt } = await import("../../server/lib/ai/expert-prompt-builder");
    const targetVersionId = data.version === "draft" ? expert.draftVersionId : expert.currentVersionId;

    let builtPrompt: Awaited<ReturnType<typeof buildExpertPromptFromSnapshot>>;

    if (targetVersionId) {
      const version = await loadVersion(targetVersionId, orgId);
      if (!version) return notFound(res, `${data.version} version not found.`);
      builtPrompt = buildExpertPromptFromSnapshot(version.configJson as any);
    } else {
      const db = await getDb();
      const { specialistRules, specialistSources } = await import("../../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const [allRules, allSources] = await Promise.all([
        db.select().from(specialistRules).where(and(eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId))),
        db.select().from(specialistSources).where(and(eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId))),
      ]);
      builtPrompt = buildExpertPrompt(
        {
          name: expert.name, goal: expert.goal ?? null,
          instructions: expert.instructions ?? null, outputStyle: expert.outputStyle ?? null,
          language: expert.language ?? "da", modelProvider: expert.modelProvider ?? "openai",
          modelName: expert.modelName ?? "gpt-4o", temperature: expert.temperature ?? 0.3,
          maxOutputTokens: expert.maxOutputTokens ?? 2048,
        },
        allRules.map((r) => ({ id: r.id, type: r.type, name: r.name, description: r.description ?? null, priority: r.priority, enforcementLevel: r.enforcementLevel })),
        allSources.map((s) => ({ id: s.id, sourceName: s.sourceName, sourceType: s.sourceType, status: s.status })),
      );
    }

    const { runAiCall } = await import("../../server/lib/ai/runner");
    const { runRetrieval } = await import("../../server/lib/retrieval/retrieval-orchestrator");

    const [aiResult, retrievalResult] = await Promise.all([
      runAiCall(
        { feature: "expert-test", useCase: "analysis", tenantId: orgId, userId, model: builtPrompt.modelName },
        { systemPrompt: builtPrompt.systemPrompt, userInput: data.prompt },
      ),
      runRetrieval({ tenantId: orgId, queryText: data.prompt, strategy: "hybrid", topK: 5 }).catch(() => null),
    ]);

    const latencyMs = Date.now() - startMs;
    const metadataSources = builtPrompt.usedSources.map((s: any) => ({
      id: s.id, name: s.sourceName, source_type: s.sourceType, status: s.status, retrieval_type: "metadata" as const,
    }));
    const retrievedSources = ((retrievalResult as any)?.results ?? []).map((r: any) => ({
      id: r.chunkId, name: `Hentet kilde (score: ${r.scoreCombined.toFixed(2)})`,
      source_type: "retrieved", status: "active", retrieval_type: "semantic" as const,
      relevance_score: r.scoreCombined, rank_position: r.rankPosition,
    }));
    const allSources = metadataSources.length > 0 ? metadataSources : retrievedSources;

    ok(res, {
      answer: aiResult.content,
      used_sources: allSources,
      latency_ms: latencyMs,
      model_used: builtPrompt.modelName,
      version_used: data.version,
      expert_name: expert.name,
      token_usage: (aiResult as any).usage ?? null,
    });
  } catch (err) { handleErr(res, err, "experts/test"); }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  const method = req.method?.toUpperCase() ?? "GET";

  // Strip /api/experts prefix, remove query string, split into segments
  const segs = rawUrl.replace(/^\/api\/experts/, "").replace(/\?.*$/, "").split("/").filter(Boolean);

  const authResult = await authenticate(req);
  if (authResult.status !== "ok" || !authResult.user) {
    const status = authResult.status === "lockdown" ? 403 : 401;
    jsonOut(res, status, { error_code: "UNAUTHENTICATED", message: "Log ind for at fortsætte" });
    return;
  }

  const { user } = authResult;
  const orgId  = user.organizationId;
  const userId = user.id;

  let body: unknown = {};
  if (["POST", "PATCH", "PUT"].includes(method)) {
    try { body = await readBody(req); }
    catch { return badRequest(res, "Ugyldigt JSON"); }
  }

  try {
    // POST /api/experts/ai-suggest  (before /:id routes)
    if (segs[0] === "ai-suggest" && method === "POST") return aiSuggest(orgId, userId, body, res);

    // POST /api/experts/ai-refine
    if (segs[0] === "ai-refine"  && method === "POST") return aiRefine(orgId, userId, body, res);

    // GET  /api/experts
    if (segs.length === 0 && method === "GET")  return listExperts(orgId, res);

    // POST /api/experts
    if (segs.length === 0 && method === "POST") return createExpert(orgId, userId, body, res);

    const [id, sub, subId, action] = segs;

    if (!id) return jsonOut(res, 404, { error_code: "NOT_FOUND", message: "Route ikke fundet" });

    // No sub-resource
    if (!sub) {
      if (method === "GET")   return getExpert(id, orgId, res);
      if (method === "PATCH") return updateExpert(id, orgId, userId, body, res);
    }

    // POST /api/experts/:id/archive|unarchive|pause|resume|duplicate|promote|test
    if (!subId) {
      if (method === "POST") {
        if (sub === "archive")   return setExpertStatus(id, orgId, "archived", res);
        if (sub === "unarchive") return setExpertStatus(id, orgId, "active",   res);
        if (sub === "pause")     return setExpertStatus(id, orgId, "paused",   res);
        if (sub === "resume")    return setExpertStatus(id, orgId, "active",   res);
        if (sub === "duplicate") return duplicateExpert(id, orgId, userId, res);
        if (sub === "promote")   return promoteExpert(id, orgId, userId, res);
        if (sub === "test")      return testExpert(id, orgId, userId, body, res);
      }
      // GET /api/experts/:id/versions|rules|sources
      if (method === "GET") {
        if (sub === "versions") return listVersions(id, orgId, res);
        if (sub === "rules")    return listRules(id, orgId, res);
        if (sub === "sources")  return listSources(id, orgId, res);
      }
      // POST /api/experts/:id/rules|sources
      if (method === "POST") {
        if (sub === "rules")   return createRule(id, orgId, body, res);
        if (sub === "sources") return createSource(id, orgId, body, res);
      }
    }

    // Routes with sub-resource ID: /api/experts/:id/rules/:ruleId  or  /api/experts/:id/sources/:sourceId[/action]
    if (subId) {
      if (sub === "rules") {
        if (method === "PUT")    return updateRule(id, subId, orgId, body, res);
        if (method === "DELETE") return deleteRule(id, subId, orgId, res);
      }
      if (sub === "sources") {
        if (!action) {
          if (method === "PATCH")  return updateSource(id, subId, orgId, body, res);
          if (method === "DELETE") return deleteSource(id, subId, orgId, res);
        }
        if (action === "analyze-authenticity" && method === "POST")
          return analyzeAuthenticity(id, subId, orgId, res);
      }
    }

    jsonOut(res, 404, { error_code: "NOT_FOUND", message: "Route ikke fundet" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vercel/experts] unhandled:", msg);
    if (!res.headersSent) jsonOut(res, 500, { error_code: "INTERNAL_ERROR", message: msg });
  }
}
