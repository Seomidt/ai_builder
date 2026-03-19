/**
 * Phase 18 — Experiments Service
 * Lifecycle management for controlled experiments and variants.
 *
 * INV-FLAG4: Traffic percentages must validate cleanly.
 * INV-FLAG5: Pause/complete lifecycle transitions must be explicit.
 */

import { db } from "../../db";
import { experiments, experimentVariants } from "@shared/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";

const VALID_SUBJECT_TYPES = ["tenant", "actor", "request"] as const;
const VALID_LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  draft: ["active"],
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: ["archived"],
  archived: [],
};

export interface CreateExperimentParams {
  experimentKey: string;
  tenantId?: string;
  subjectType: string;
  trafficAllocationPercent?: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateVariantParams {
  variantKey: string;
  trafficPercent: number;
  config?: Record<string, unknown>;
  isControl?: boolean;
}

export async function createExperiment(params: CreateExperimentParams): Promise<{ id: string; experimentKey: string }> {
  if (!params.experimentKey?.trim()) throw new Error("experimentKey is required");
  if (!VALID_SUBJECT_TYPES.includes(params.subjectType as (typeof VALID_SUBJECT_TYPES)[number])) {
    throw new Error(`Invalid subjectType: ${params.subjectType}`);
  }
  const alloc = params.trafficAllocationPercent ?? 100;
  if (alloc < 0 || alloc > 100) throw new Error("trafficAllocationPercent must be in [0, 100]");

  const rows = await db
    .insert(experiments)
    .values({
      experimentKey: params.experimentKey.trim(),
      tenantId: params.tenantId ?? null,
      subjectType: params.subjectType,
      lifecycleStatus: "draft",
      trafficAllocationPercent: String(alloc),
      description: params.description ?? null,
      metadata: (params.metadata ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: experiments.id, experimentKey: experiments.experimentKey });
  return rows[0];
}

export async function createExperimentVariant(
  experimentKey: string,
  params: CreateVariantParams,
): Promise<{ id: string; variantKey: string }> {
  if (params.trafficPercent < 0 || params.trafficPercent > 100) {
    throw new Error("trafficPercent must be in [0, 100]");
  }
  const expRows = await db.execute(drizzleSql`
    SELECT id FROM experiments WHERE experiment_key = ${experimentKey} LIMIT 1
  `);
  const exp = expRows.rows[0] as Record<string, unknown> | undefined;
  if (!exp) throw new Error(`Experiment not found: ${experimentKey}`);

  const existingRows = await db.execute(drizzleSql`
    SELECT SUM(traffic_percent::numeric) AS total
    FROM experiment_variants WHERE experiment_id = ${exp.id as string}
  `);
  const currentTotal = Number((existingRows.rows[0] as Record<string, unknown>)?.total ?? 0);
  if (currentTotal + params.trafficPercent > 100.01) {
    throw new Error(`Adding ${params.trafficPercent}% would exceed 100% (current: ${currentTotal}%)`);
  }

  const rows = await db
    .insert(experimentVariants)
    .values({
      experimentId: exp.id as string,
      variantKey: params.variantKey,
      trafficPercent: String(params.trafficPercent),
      config: (params.config ?? null) as Record<string, unknown> | null,
      isControl: params.isControl ?? false,
    })
    .returning({ id: experimentVariants.id, variantKey: experimentVariants.variantKey });
  return rows[0];
}

async function transitionExperiment(experimentKey: string, targetStatus: string): Promise<{ transitioned: boolean; from: string; to: string }> {
  const rows = await db.execute(drizzleSql`
    SELECT id, lifecycle_status FROM experiments WHERE experiment_key = ${experimentKey} LIMIT 1
  `);
  const exp = rows.rows[0] as Record<string, unknown> | undefined;
  if (!exp) throw new Error(`Experiment not found: ${experimentKey}`);

  const current = exp.lifecycle_status as string;
  const allowed = VALID_LIFECYCLE_TRANSITIONS[current] ?? [];
  if (!allowed.includes(targetStatus)) {
    throw new Error(`Invalid lifecycle transition: ${current} → ${targetStatus}. Allowed: ${allowed.join(", ") || "none"}`);
  }

  await db.execute(drizzleSql`
    UPDATE experiments SET lifecycle_status = ${targetStatus}, updated_at = now()
    WHERE id = ${exp.id as string}
  `);
  return { transitioned: true, from: current, to: targetStatus };
}

export async function startExperiment(experimentKey: string) {
  return transitionExperiment(experimentKey, "active");
}

export async function pauseExperiment(experimentKey: string) {
  return transitionExperiment(experimentKey, "paused");
}

export async function completeExperiment(experimentKey: string) {
  return transitionExperiment(experimentKey, "completed");
}

export async function explainExperiment(experimentKey: string): Promise<{
  experiment: Record<string, unknown> | null;
  variants: Array<Record<string, unknown>>;
  totalTrafficPercent: number;
}> {
  const expRows = await db.execute(drizzleSql`
    SELECT * FROM experiments WHERE experiment_key = ${experimentKey} LIMIT 1
  `);
  const experiment = (expRows.rows[0] as Record<string, unknown>) ?? null;
  if (!experiment) return { experiment: null, variants: [], totalTrafficPercent: 0 };

  const variantRows = await db.execute(drizzleSql`
    SELECT * FROM experiment_variants WHERE experiment_id = ${experiment.id as string}
    ORDER BY created_at ASC
  `);
  const variants = variantRows.rows as Record<string, unknown>[];
  const totalTrafficPercent = variants.reduce((sum, v) => sum + Number(v.traffic_percent ?? 0), 0);

  return { experiment, variants, totalTrafficPercent };
}
