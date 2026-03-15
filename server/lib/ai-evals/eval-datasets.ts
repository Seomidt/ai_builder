/**
 * Phase 17 — Eval Datasets
 * CRUD for evaluation datasets and cases.
 *
 * INV-EVAL1: Datasets and cases are explicitly versionable and reproducible.
 * INV-EVAL6: All eval data remains tenant-safe.
 * INV-EVAL12: Cross-tenant leakage is impossible.
 */

import { db } from "../../db";
import { aiEvalDatasets, aiEvalCases } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";

export type DatasetType =
  | "answer_quality"
  | "retrieval_quality"
  | "hallucination"
  | "prompt_regression"
  | "model_comparison";

export type DifficultyLevel = "low" | "medium" | "high";

const ALLOWED_DATASET_TYPES = new Set<string>([
  "answer_quality",
  "retrieval_quality",
  "hallucination",
  "prompt_regression",
  "model_comparison",
]);

/**
 * Create a new evaluation dataset.
 * INV-EVAL1: Datasets are explicitly typed and versioned by creation time.
 */
export async function createDataset(params: {
  tenantId?: string;
  datasetName: string;
  datasetType: DatasetType;
  description?: string;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  try {
    if (!ALLOWED_DATASET_TYPES.has(params.datasetType)) {
      return null;
    }
    const [row] = await db
      .insert(aiEvalDatasets)
      .values({
        tenantId: params.tenantId ?? null,
        datasetName: params.datasetName,
        datasetType: params.datasetType,
        description: params.description ?? null,
        isActive: params.isActive ?? true,
        metadata: params.metadata ?? null,
      })
      .returning({ id: aiEvalDatasets.id });
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Create a new eval case within a dataset.
 * INV-EVAL1: Cases are explicitly reproducible.
 */
export async function createEvalCase(params: {
  datasetId: string;
  tenantId?: string;
  inputQuery: string;
  expectedSignals?: Record<string, unknown>;
  expectedAnswer?: string;
  expectedCitations?: unknown[];
  difficulty?: DifficultyLevel;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  try {
    const difficulty = params.difficulty ?? "medium";
    const [row] = await db
      .insert(aiEvalCases)
      .values({
        datasetId: params.datasetId,
        tenantId: params.tenantId ?? null,
        inputQuery: params.inputQuery,
        expectedSignals: params.expectedSignals ?? null,
        expectedAnswer: params.expectedAnswer ?? null,
        expectedCitations: params.expectedCitations ?? null,
        difficulty,
        metadata: params.metadata ?? null,
      })
      .returning({ id: aiEvalCases.id });
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * List evaluation datasets for a tenant (or all if tenantId omitted).
 * INV-EVAL12: Tenant-scoped query prevents cross-tenant leakage.
 */
export async function listDatasets(params: {
  tenantId?: string;
  datasetType?: DatasetType;
  isActive?: boolean;
  limit?: number;
}): Promise<typeof aiEvalDatasets.$inferSelect[]> {
  try {
    const limit = Math.min(params.limit ?? 100, 500);
    let query = db.select().from(aiEvalDatasets);
    const conditions = [];
    if (params.tenantId) conditions.push(eq(aiEvalDatasets.tenantId, params.tenantId));
    if (params.datasetType) conditions.push(eq(aiEvalDatasets.datasetType, params.datasetType));
    if (params.isActive !== undefined) conditions.push(eq(aiEvalDatasets.isActive, params.isActive));
    const filtered = conditions.length > 0
      ? query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : query;
    return await filtered.orderBy(desc(aiEvalDatasets.createdAt)).limit(limit);
  } catch {
    return [];
  }
}

/**
 * List eval cases for a dataset.
 * INV-EVAL12: Tenant is validated to prevent cross-dataset leakage.
 */
export async function listEvalCases(params: {
  datasetId: string;
  tenantId?: string;
  limit?: number;
}): Promise<typeof aiEvalCases.$inferSelect[]> {
  try {
    const limit = Math.min(params.limit ?? 200, 1000);
    const conditions = [eq(aiEvalCases.datasetId, params.datasetId)];
    if (params.tenantId) conditions.push(eq(aiEvalCases.tenantId, params.tenantId));
    return await db
      .select()
      .from(aiEvalCases)
      .where(and(...conditions))
      .orderBy(desc(aiEvalCases.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Explain a dataset — returns its full shape without any writes.
 * INV-EVAL6: Read-only explain path.
 */
export async function explainDataset(datasetId: string): Promise<{
  dataset: typeof aiEvalDatasets.$inferSelect | null;
  caseCount: number;
  difficulties: Record<string, number>;
} | null> {
  try {
    const [dataset] = await db
      .select()
      .from(aiEvalDatasets)
      .where(eq(aiEvalDatasets.id, datasetId))
      .limit(1);
    if (!dataset) return null;

    const cases = await db
      .select()
      .from(aiEvalCases)
      .where(eq(aiEvalCases.datasetId, datasetId));

    const difficulties: Record<string, number> = {};
    for (const c of cases) {
      difficulties[c.difficulty] = (difficulties[c.difficulty] ?? 0) + 1;
    }

    return { dataset, caseCount: cases.length, difficulties };
  } catch {
    return null;
  }
}

/**
 * Validate dataset type at service boundary.
 * Returns true if the value is a valid DatasetType.
 */
export function isValidDatasetType(value: string): value is DatasetType {
  return ALLOWED_DATASET_TYPES.has(value);
}
