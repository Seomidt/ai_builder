import { z } from "zod";
import { runsRepository } from "../repositories/runs.repository";
import type { AiRun, AiStep, AiArtifact, AiToolCall, AiApproval } from "@shared/schema";

export const createRunSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  architectureProfileId: z.string().min(1),
  architectureVersionId: z.string().min(1),
  createdBy: z.string().min(1),
  // GitHub versioning metadata
  title: z.string().max(200).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  // Pipeline
  goal: z.string().optional(),
  pipelineVersion: z.string().max(50).optional(),
});

export const updateRunStatusSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
});

export const appendStepSchema = z.object({
  runId: z.string().min(1),
  stepKey: z.string().min(1),
  title: z.string().max(200).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  agentKey: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]).default("pending"),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export const appendArtifactSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().optional(),
  artifactType: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  content: z.string().optional(),
  path: z.string().optional(),
  version: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const appendToolCallSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().optional(),
  toolName: z.string().min(1).max(100),
  toolVersion: z.string().max(50).optional(),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  status: z.enum(["pending", "success", "failed"]).default("pending"),
  error: z.string().optional(),
});

export const appendApprovalSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().optional(),
  requestedBy: z.string().min(1),
  notes: z.string().optional(),
});

export const resolveApprovalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  approvedBy: z.string().min(1),
  notes: z.string().optional(),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type UpdateRunStatusInput = z.infer<typeof updateRunStatusSchema>;
export type AppendStepInput = z.infer<typeof appendStepSchema>;
export type AppendArtifactInput = z.infer<typeof appendArtifactSchema>;
export type AppendToolCallInput = z.infer<typeof appendToolCallSchema>;
export type AppendApprovalInput = z.infer<typeof appendApprovalSchema>;
export type ResolveApprovalInput = z.infer<typeof resolveApprovalSchema>;

export const runsService = {
  async list(organizationId: string, filters?: { status?: AiRun["status"]; projectId?: string }) {
    return runsRepository.list(organizationId, filters);
  },

  async getById(id: string, organizationId: string) {
    const run = await runsRepository.getById(id, organizationId);
    if (!run) throw new Error(`Run not found: ${id}`);
    const [steps, artifacts, toolCalls, approvals] = await Promise.all([
      runsRepository.listSteps(id),
      runsRepository.listArtifacts(id),
      runsRepository.listToolCalls(id),
      runsRepository.listApprovals(id),
    ]);
    return { ...run, steps, artifacts, toolCalls, approvals };
  },

  async createRun(input: CreateRunInput): Promise<AiRun> {
    const data = createRunSchema.parse(input);
    return runsRepository.createRun({ ...data, status: "pending" });
  },

  async updateStatus(id: string, organizationId: string, input: UpdateRunStatusInput): Promise<AiRun> {
    const { status } = updateRunStatusSchema.parse(input);
    const updated = await runsRepository.updateStatus(id, organizationId, status);
    if (!updated) throw new Error(`Run not found: ${id}`);
    return updated;
  },

  async appendStep(input: AppendStepInput): Promise<AiStep> {
    const data = appendStepSchema.parse(input);
    return runsRepository.appendStep(data);
  },

  async appendArtifact(input: AppendArtifactInput): Promise<AiArtifact> {
    const data = appendArtifactSchema.parse(input);
    return runsRepository.appendArtifact(data);
  },

  async appendToolCall(input: AppendToolCallInput): Promise<AiToolCall> {
    const data = appendToolCallSchema.parse(input);
    return runsRepository.appendToolCall(data);
  },

  async appendApproval(input: AppendApprovalInput): Promise<AiApproval> {
    const data = appendApprovalSchema.parse(input);
    return runsRepository.appendApproval({ ...data, status: "pending" });
  },

  async resolveApproval(id: string, input: ResolveApprovalInput): Promise<AiApproval> {
    const data = resolveApprovalSchema.parse(input);
    const updated = await runsRepository.resolveApproval(id, data);
    if (!updated) throw new Error(`Approval not found: ${id}`);
    return updated;
  },
};
