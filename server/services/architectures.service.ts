import { z } from "zod";
import { architecturesRepository } from "../repositories/architectures.repository.ts";
import { NotFoundError, ConflictError } from "../lib/errors.ts";
import type {
  ArchitectureProfile,
  ArchitectureVersion,
  ArchitectureAgentConfig,
  ArchitectureCapabilityConfig,
} from "@shared/schema";

export const createProfileSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers and hyphens only"),
  description: z.string().optional(),
  category: z.string().max(50).optional(),
  goal: z.string().optional(),
  instructions: z.string().optional(),
  outputStyle: z.string().optional(),
  departmentId: z.string().optional(),
  language: z.string().optional().default("da"),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
});

export const createVersionSchema = z.object({
  architectureProfileId: z.string().min(1),
  versionNumber: z.string().min(1).max(20),
  versionLabel: z.string().max(100).optional(),
  description: z.string().optional(),
  changelog: z.string().optional(),
  workflowKey: z.string().max(100).optional(),
  config: z.record(z.unknown()).optional(),
});

export const upsertAgentConfigSchema = z.object({
  versionId: z.string().min(1),
  agentKey: z.string().min(1).max(100),
  executionOrder: z.number().int().min(0).default(0),
  modelKey: z.string().max(100).optional(),
  promptVersion: z.string().max(50).optional(),
  isEnabled: z.boolean().default(true),
  config: z.record(z.unknown()).optional(),
});

export const upsertCapabilityConfigSchema = z.object({
  versionId: z.string().min(1),
  capabilityKey: z.string().min(1).max(100),
  isEnabled: z.boolean().default(true),
  requiresApproval: z.boolean().default(false),
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateVersionInput = z.infer<typeof createVersionSchema>;
export type UpsertAgentConfigInput = z.infer<typeof upsertAgentConfigSchema>;
export type UpsertCapabilityConfigInput = z.infer<typeof upsertCapabilityConfigSchema>;

function isDuplicateSlug(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

export const architecturesService = {
  async listProfiles(organizationId: string): Promise<ArchitectureProfile[]> {
    return architecturesRepository.listActiveProfiles(organizationId);
  },

  async getProfileById(id: string, organizationId: string) {
    const profile = await architecturesRepository.getProfileById(id, organizationId);
    if (!profile) throw new NotFoundError("Architecture profile not found.");
    const versions = await architecturesRepository.listVersions(id);
    return { ...profile, versions };
  },

  async createProfile(input: CreateProfileInput): Promise<ArchitectureProfile> {
    const data = createProfileSchema.parse(input);
    try {
      return await architecturesRepository.createProfile({ ...data, status: "draft" });
    } catch (err: unknown) {
      if (isDuplicateSlug(err)) {
        throw new ConflictError("DUPLICATE_SLUG", "An architecture with this slug already exists in your organization. Choose a different slug.");
      }
      throw err;
    }
  },

  async updateProfile(id: string, organizationId: string, input: UpdateProfileInput): Promise<ArchitectureProfile> {
    const data = updateProfileSchema.parse(input);
    try {
      const updated = await architecturesRepository.updateProfile(id, organizationId, data);
      if (!updated) throw new NotFoundError("Architecture profile not found.");
      return updated;
    } catch (err: unknown) {
      if (isDuplicateSlug(err)) {
        throw new ConflictError("DUPLICATE_SLUG", "An architecture with this slug already exists in your organization. Choose a different slug.");
      }
      throw err;
    }
  },

  async archiveProfile(id: string, organizationId: string): Promise<ArchitectureProfile> {
    const archived = await architecturesRepository.archiveProfile(id, organizationId);
    if (!archived) throw new NotFoundError("Architecture profile not found.");
    return archived;
  },

  async createVersion(input: CreateVersionInput): Promise<ArchitectureVersion> {
    const data = createVersionSchema.parse(input);
    return architecturesRepository.createVersion({ ...data, isPublished: false });
  },

  async publishVersion(versionId: string, profileId: string, organizationId: string): Promise<ArchitectureVersion> {
    const profile = await architecturesRepository.getProfileById(profileId, organizationId);
    if (!profile) throw new NotFoundError("Architecture profile not found.");
    const version = await architecturesRepository.publishVersion(versionId, profileId);
    if (!version) throw new NotFoundError("Architecture version not found.");
    return version;
  },

  async upsertAgentConfig(input: UpsertAgentConfigInput): Promise<ArchitectureAgentConfig> {
    const data = upsertAgentConfigSchema.parse(input);
    return architecturesRepository.upsertAgentConfig(data);
  },

  async upsertCapabilityConfig(input: UpsertCapabilityConfigInput): Promise<ArchitectureCapabilityConfig> {
    const data = upsertCapabilityConfigSchema.parse(input);
    return architecturesRepository.upsertCapabilityConfig(data);
  },

  async getVersionDetails(versionId: string) {
    const version = await architecturesRepository.getVersionById(versionId);
    if (!version) throw new NotFoundError("Architecture version not found.");
    const [agentConfigs, capabilityConfigs] = await Promise.all([
      architecturesRepository.listAgentConfigs(versionId),
      architecturesRepository.listCapabilityConfigs(versionId),
    ]);
    return { ...version, agentConfigs, capabilityConfigs };
  },
};
