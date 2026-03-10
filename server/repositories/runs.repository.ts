import { eq, and, desc, max, or } from "drizzle-orm";
import { db } from "../db";
import {
  aiRuns,
  aiSteps,
  aiArtifacts,
  aiToolCalls,
  aiApprovals,
  artifactDependencies,
  type AiRun,
  type InsertAiRun,
  type AiStep,
  type InsertAiStep,
  type AiArtifact,
  type InsertAiArtifact,
  type AiToolCall,
  type InsertAiToolCall,
  type AiApproval,
  type InsertAiApproval,
  type ArtifactDependency,
  type InsertArtifactDependency,
} from "@shared/schema";

export const runsRepository = {
  // ─── Runs ──────────────────────────────────────────────────────────────────

  async list(organizationId: string, filters?: { status?: AiRun["status"]; projectId?: string }): Promise<AiRun[]> {
    const conditions = [eq(aiRuns.organizationId, organizationId)];
    if (filters?.status) conditions.push(eq(aiRuns.status, filters.status));
    if (filters?.projectId) conditions.push(eq(aiRuns.projectId, filters.projectId));

    return db
      .select()
      .from(aiRuns)
      .where(and(...conditions))
      .orderBy(desc(aiRuns.runNumber));
  },

  async getById(id: string, organizationId: string): Promise<AiRun | undefined> {
    const [run] = await db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.organizationId, organizationId)));
    return run;
  },

  /**
   * Assigns a sequential run_number per organization before inserting.
   * Uses MAX(run_number) + 1 within a single transaction to prevent gaps/races.
   */
  async createRun(data: Omit<InsertAiRun, "runNumber"> & { organizationId: string }): Promise<AiRun> {
    return db.transaction(async (tx) => {
      const [{ maxNum }] = await tx
        .select({ maxNum: max(aiRuns.runNumber) })
        .from(aiRuns)
        .where(eq(aiRuns.organizationId, data.organizationId));

      const nextRunNumber = (maxNum ?? 0) + 1;

      const [run] = await tx
        .insert(aiRuns)
        .values({ ...(data as InsertAiRun), runNumber: nextRunNumber })
        .returning();
      return run;
    });
  },

  async updateStatus(
    id: string,
    organizationId: string,
    status: AiRun["status"],
  ): Promise<AiRun | undefined> {
    const now = new Date();
    const timestamps: Partial<AiRun> = { status, updatedAt: now };
    if (status === "running") {
      timestamps.startedAt = now;
    }
    if (status === "completed") {
      timestamps.completedAt = now;
      timestamps.finishedAt = now;
    }
    if (status === "failed" || status === "cancelled") {
      timestamps.finishedAt = now;
    }

    const [updated] = await db
      .update(aiRuns)
      .set(timestamps)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.organizationId, organizationId)))
      .returning();
    return updated;
  },

  async updateGithubMetadata(
    id: string,
    organizationId: string,
    data: {
      githubBranch?: string;
      githubCommitSha?: string;
      githubPrNumber?: number;
      githubTags?: string[];
    },
  ): Promise<AiRun | undefined> {
    const [updated] = await db
      .update(aiRuns)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(aiRuns.id, id), eq(aiRuns.organizationId, organizationId)))
      .returning();
    return updated;
  },

  // ─── Steps ─────────────────────────────────────────────────────────────────

  async listSteps(runId: string): Promise<AiStep[]> {
    return db
      .select()
      .from(aiSteps)
      .where(eq(aiSteps.runId, runId))
      .orderBy(aiSteps.createdAt);
  },

  async appendStep(data: InsertAiStep): Promise<AiStep> {
    const [step] = await db.insert(aiSteps).values(data).returning();
    return step;
  },

  async updateStep(
    id: string,
    data: Partial<Pick<AiStep, "status" | "output" | "error" | "startedAt" | "completedAt">>,
  ): Promise<AiStep | undefined> {
    const [updated] = await db
      .update(aiSteps)
      .set(data)
      .where(eq(aiSteps.id, id))
      .returning();
    return updated;
  },

  // ─── Artifacts ─────────────────────────────────────────────────────────────

  async listArtifacts(runId: string): Promise<AiArtifact[]> {
    return db
      .select()
      .from(aiArtifacts)
      .where(eq(aiArtifacts.runId, runId))
      .orderBy(aiArtifacts.createdAt);
  },

  async appendArtifact(data: InsertAiArtifact): Promise<AiArtifact> {
    const [artifact] = await db.insert(aiArtifacts).values(data).returning();
    return artifact;
  },

  // ─── Tool Calls ────────────────────────────────────────────────────────────

  async listToolCalls(runId: string): Promise<AiToolCall[]> {
    return db
      .select()
      .from(aiToolCalls)
      .where(eq(aiToolCalls.runId, runId))
      .orderBy(aiToolCalls.executedAt);
  },

  async appendToolCall(data: InsertAiToolCall): Promise<AiToolCall> {
    const [toolCall] = await db.insert(aiToolCalls).values(data).returning();
    return toolCall;
  },

  // ─── Approvals ─────────────────────────────────────────────────────────────

  async listApprovals(runId: string): Promise<AiApproval[]> {
    return db
      .select()
      .from(aiApprovals)
      .where(eq(aiApprovals.runId, runId))
      .orderBy(aiApprovals.createdAt);
  },

  async appendApproval(data: InsertAiApproval): Promise<AiApproval> {
    const [approval] = await db.insert(aiApprovals).values(data).returning();
    return approval;
  },

  async resolveApproval(
    id: string,
    data: { status: "approved" | "rejected"; approvedBy: string; notes?: string },
  ): Promise<AiApproval | undefined> {
    const [updated] = await db
      .update(aiApprovals)
      .set({ ...data, resolvedAt: new Date() })
      .where(eq(aiApprovals.id, id))
      .returning();
    return updated;
  },

  // ─── Artifact Dependencies ─────────────────────────────────────────────────

  async createArtifactDependency(data: InsertArtifactDependency): Promise<ArtifactDependency> {
    const [dep] = await db.insert(artifactDependencies).values(data).returning();
    return dep;
  },

  async listArtifactDependenciesForRun(runId: string): Promise<ArtifactDependency[]> {
    const artifacts = await db
      .select({ id: aiArtifacts.id })
      .from(aiArtifacts)
      .where(eq(aiArtifacts.runId, runId));

    if (artifacts.length === 0) return [];
    const artifactIds = artifacts.map((a) => a.id);

    return db
      .select()
      .from(artifactDependencies)
      .where(
        or(
          ...artifactIds.map((id) => eq(artifactDependencies.fromArtifactId, id)),
        ),
      )
      .orderBy(artifactDependencies.createdAt);
  },
};
