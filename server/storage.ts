import type { Project, AiRun, AiStep, AiArtifact, AiToolCall, AiApproval, ArchitectureProfile, ArchitectureVersion, Integration, ArtifactDependency } from "@shared/schema";
import { projectsService, type CreateProjectInput, type UpdateProjectInput } from "./services/projects.service";
import { architecturesService, type CreateProfileInput, type UpdateProfileInput, type CreateVersionInput, type UpsertAgentConfigInput, type UpsertCapabilityConfigInput } from "./services/architectures.service";
import { runsService, type CreateRunInput, type UpdateRunStatusInput, type AppendStepInput, type AppendArtifactInput, type AppendToolCallInput, type AppendApprovalInput, type ResolveApprovalInput } from "./services/runs.service";
import { runsRepository } from "./repositories/runs.repository";
import { integrationsService, type UpsertIntegrationInput } from "./services/integrations.service";

export interface IStorage {
  // Projects
  listProjects(organizationId: string): Promise<Project[]>;
  getProject(id: string, organizationId: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, organizationId: string, input: UpdateProjectInput): Promise<Project>;
  archiveProject(id: string, organizationId: string): Promise<Project>;

  // Architecture Profiles
  listArchitectureProfiles(organizationId: string): Promise<ArchitectureProfile[]>;
  getArchitectureProfile(id: string, organizationId: string): Promise<ArchitectureProfile & { versions: ArchitectureVersion[] }>;
  createArchitectureProfile(input: CreateProfileInput): Promise<ArchitectureProfile>;
  updateArchitectureProfile(id: string, organizationId: string, input: UpdateProfileInput): Promise<ArchitectureProfile>;
  archiveArchitectureProfile(id: string, organizationId: string): Promise<ArchitectureProfile>;
  createArchitectureVersion(input: CreateVersionInput): Promise<ArchitectureVersion>;
  publishArchitectureVersion(versionId: string, profileId: string, organizationId: string): Promise<ArchitectureVersion>;
  upsertAgentConfig(input: UpsertAgentConfigInput): Promise<unknown>;
  upsertCapabilityConfig(input: UpsertCapabilityConfigInput): Promise<unknown>;

  // Runs (lifecycle)
  listRuns(organizationId: string, filters?: { status?: AiRun["status"]; projectId?: string }): Promise<AiRun[]>;
  getRun(id: string, organizationId: string): Promise<AiRun & { steps: AiStep[]; artifacts: AiArtifact[]; toolCalls: AiToolCall[]; approvals: AiApproval[] }>;
  createRun(input: CreateRunInput): Promise<AiRun>;
  updateRunStatus(id: string, organizationId: string, input: UpdateRunStatusInput): Promise<AiRun>;
  appendStep(input: AppendStepInput): Promise<AiStep>;
  appendArtifact(input: AppendArtifactInput): Promise<AiArtifact>;
  appendToolCall(input: AppendToolCallInput): Promise<AiToolCall>;
  appendApproval(input: AppendApprovalInput): Promise<AiApproval>;
  resolveApproval(id: string, input: ResolveApprovalInput): Promise<AiApproval>;

  // Artifact Dependencies
  listArtifactDependencies(runId: string): Promise<ArtifactDependency[]>;

  // Integrations
  listIntegrations(organizationId: string): Promise<Integration[]>;
  upsertIntegration(input: UpsertIntegrationInput): Promise<Integration>;
}

export class DatabaseStorage implements IStorage {
  // Projects
  listProjects(organizationId: string) { return projectsService.list(organizationId); }
  getProject(id: string, organizationId: string) { return projectsService.getById(id, organizationId); }
  createProject(input: CreateProjectInput) { return projectsService.create(input); }
  updateProject(id: string, organizationId: string, input: UpdateProjectInput) { return projectsService.update(id, organizationId, input); }
  archiveProject(id: string, organizationId: string) { return projectsService.archive(id, organizationId); }

  // Architecture Profiles
  listArchitectureProfiles(organizationId: string) { return architecturesService.listProfiles(organizationId); }
  getArchitectureProfile(id: string, organizationId: string) { return architecturesService.getProfileById(id, organizationId); }
  createArchitectureProfile(input: CreateProfileInput) { return architecturesService.createProfile(input); }
  updateArchitectureProfile(id: string, organizationId: string, input: UpdateProfileInput) { return architecturesService.updateProfile(id, organizationId, input); }
  archiveArchitectureProfile(id: string, organizationId: string) { return architecturesService.archiveProfile(id, organizationId); }
  createArchitectureVersion(input: CreateVersionInput) { return architecturesService.createVersion(input); }
  publishArchitectureVersion(versionId: string, profileId: string, organizationId: string) { return architecturesService.publishVersion(versionId, profileId, organizationId); }
  upsertAgentConfig(input: UpsertAgentConfigInput) { return architecturesService.upsertAgentConfig(input); }
  upsertCapabilityConfig(input: UpsertCapabilityConfigInput) { return architecturesService.upsertCapabilityConfig(input); }

  // Runs
  listRuns(organizationId: string, filters?: { status?: AiRun["status"]; projectId?: string }) { return runsService.list(organizationId, filters); }
  getRun(id: string, organizationId: string) { return runsService.getById(id, organizationId); }
  createRun(input: CreateRunInput) { return runsService.createRun(input); }
  updateRunStatus(id: string, organizationId: string, input: UpdateRunStatusInput) { return runsService.updateStatus(id, organizationId, input); }
  appendStep(input: AppendStepInput) { return runsService.appendStep(input); }
  appendArtifact(input: AppendArtifactInput) { return runsService.appendArtifact(input); }
  appendToolCall(input: AppendToolCallInput) { return runsService.appendToolCall(input); }
  appendApproval(input: AppendApprovalInput) { return runsService.appendApproval(input); }
  resolveApproval(id: string, input: ResolveApprovalInput) { return runsService.resolveApproval(id, input); }

  // Artifact Dependencies
  listArtifactDependencies(runId: string) { return runsRepository.listArtifactDependenciesForRun(runId); }

  // Integrations
  listIntegrations(organizationId: string) { return integrationsService.list(organizationId); }
  upsertIntegration(input: UpsertIntegrationInput) { return integrationsService.upsert(input); }
}

export const storage = new DatabaseStorage();
