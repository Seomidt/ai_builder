import { z } from "zod";
import { architecturesRepository } from "../repositories/architectures.repository";
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
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
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
  // GitHub versioning metadata
  versionLabel: z.string().max(100).optional(),    // e.g. "Initial Release"
  description: z.string().optional(),             // what this version introduces
  changelog: z.string().optional(),               // markdown changelog for commit body
  // Pipeline
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

export const architecturesService = {
  async listProfiles(organizationId: string): Promise<ArchitectureProfile[]> {
    return architecturesRepository.listActiveProfiles(organizationId);
  },

  async getProfileById(id: string, organizationId: string) {
    const profile = await architecturesRepository.getProfileById(id, organizationId);
    if (!profile) throw new Error(`Architecture profile not found: ${id}`);
    const versions = await architecturesRepository.listVersions(id);
    return { ...profile, versions };
  },

  async createProfile(input: CreateProfileInput): Promise<ArchitectureProfile> {
    const data = createProfileSchema.parse(input);
    return architecturesRepository.createProfile({ ...data, status: "active" });
  },

  async updateProfile(id: string, organizationId: string, input: UpdateProfileInput): Promise<ArchitectureProfile> {
    const data = updateProfileSchema.parse(input);
    const updated = await architecturesRepository.updateProfile(id, organizationId, data);
    if (!updated) throw new Error(`Architecture profile not found: ${id}`);
    return updated;
  },

  async archiveProfile(id: string, organizationId: string): Promise<ArchitectureProfile> {
    const archived = await architecturesRepository.archiveProfile(id, organizationId);
    if (!archived) throw new Error(`Architecture profile not found: ${id}`);
    return archived;
  },

  async createVersion(input: CreateVersionInput): Promise<ArchitectureVersion> {
    const data = createVersionSchema.parse(input);
    return architecturesRepository.createVersion({ ...data, isPublished: false });
  },

  async publishVersion(versionId: string, profileId: string, organizationId: string): Promise<ArchitectureVersion> {
    const profile = await architecturesRepository.getProfileById(profileId, organizationId);
    if (!profile) throw new Error(`Architecture profile not found: ${profileId}`);
    const version = await architecturesRepository.publishVersion(versionId, profileId);
    if (!version) throw new Error(`Architecture version not found: ${versionId}`);
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
    if (!version) throw new Error(`Architecture version not found: ${versionId}`);
    const [agentConfigs, capabilityConfigs] = await Promise.all([
      architecturesRepository.listAgentConfigs(versionId),
      architecturesRepository.listCapabilityConfigs(versionId),
    ]);
    return { ...version, agentConfigs, capabilityConfigs };
  },
};
