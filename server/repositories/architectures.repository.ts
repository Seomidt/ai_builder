import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  architectureProfiles,
  architectureVersions,
  architectureAgentConfigs,
  architectureCapabilityConfigs,
  architectureTemplateBindings,
  architecturePolicyBindings,
  type ArchitectureProfile,
  type InsertArchitectureProfile,
  type ArchitectureVersion,
  type InsertArchitectureVersion,
  type ArchitectureAgentConfig,
  type InsertArchitectureAgentConfig,
  type ArchitectureCapabilityConfig,
  type InsertArchitectureCapabilityConfig,
  type InsertArchitectureTemplateBinding,
  type InsertArchitecturePolicyBinding,
} from "@shared/schema";

export const architecturesRepository = {
  // ─── Profiles ─────────────────────────────────────────────────────────────

  async listProfiles(organizationId: string): Promise<ArchitectureProfile[]> {
    return db
      .select()
      .from(architectureProfiles)
      .where(eq(architectureProfiles.organizationId, organizationId))
      .orderBy(desc(architectureProfiles.createdAt));
  },

  async listActiveProfiles(organizationId: string): Promise<ArchitectureProfile[]> {
    return db
      .select()
      .from(architectureProfiles)
      .where(and(
        eq(architectureProfiles.organizationId, organizationId),
        eq(architectureProfiles.status, "active"),
      ))
      .orderBy(desc(architectureProfiles.createdAt));
  },

  async getProfileById(id: string, organizationId: string): Promise<ArchitectureProfile | undefined> {
    const [profile] = await db
      .select()
      .from(architectureProfiles)
      .where(and(
        eq(architectureProfiles.id, id),
        eq(architectureProfiles.organizationId, organizationId),
      ));
    return profile;
  },

  async createProfile(data: InsertArchitectureProfile): Promise<ArchitectureProfile> {
    const [profile] = await db.insert(architectureProfiles).values(data).returning();
    return profile;
  },

  async updateProfile(
    id: string,
    organizationId: string,
    data: Partial<Pick<ArchitectureProfile, "name" | "slug" | "description" | "category">>,
  ): Promise<ArchitectureProfile | undefined> {
    const [updated] = await db
      .update(architectureProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(and(
        eq(architectureProfiles.id, id),
        eq(architectureProfiles.organizationId, organizationId),
      ))
      .returning();
    return updated;
  },

  async archiveProfile(id: string, organizationId: string): Promise<ArchitectureProfile | undefined> {
    const [updated] = await db
      .update(architectureProfiles)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(
        eq(architectureProfiles.id, id),
        eq(architectureProfiles.organizationId, organizationId),
      ))
      .returning();
    return updated;
  },

  async setCurrentVersion(profileId: string, versionId: string): Promise<void> {
    await db
      .update(architectureProfiles)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(architectureProfiles.id, profileId));
  },

  // ─── Versions ─────────────────────────────────────────────────────────────

  async listVersions(profileId: string): Promise<ArchitectureVersion[]> {
    return db
      .select()
      .from(architectureVersions)
      .where(eq(architectureVersions.architectureProfileId, profileId))
      .orderBy(desc(architectureVersions.createdAt));
  },

  async getVersionById(id: string): Promise<ArchitectureVersion | undefined> {
    const [version] = await db
      .select()
      .from(architectureVersions)
      .where(eq(architectureVersions.id, id));
    return version;
  },

  async createVersion(data: InsertArchitectureVersion): Promise<ArchitectureVersion> {
    const [version] = await db.insert(architectureVersions).values(data).returning();
    return version;
  },

  async publishVersion(versionId: string, profileId: string): Promise<ArchitectureVersion | undefined> {
    const now = new Date();
    const [version] = await db
      .update(architectureVersions)
      .set({ isPublished: true, publishedAt: now })
      .where(and(
        eq(architectureVersions.id, versionId),
        eq(architectureVersions.architectureProfileId, profileId),
      ))
      .returning();

    if (version) {
      await db
        .update(architectureProfiles)
        .set({ currentVersionId: versionId, updatedAt: now })
        .where(eq(architectureProfiles.id, profileId));
    }
    return version;
  },

  // ─── Agent Configs ────────────────────────────────────────────────────────

  async listAgentConfigs(versionId: string): Promise<ArchitectureAgentConfig[]> {
    return db
      .select()
      .from(architectureAgentConfigs)
      .where(eq(architectureAgentConfigs.versionId, versionId));
  },

  async upsertAgentConfig(data: InsertArchitectureAgentConfig): Promise<ArchitectureAgentConfig> {
    const [config] = await db
      .insert(architectureAgentConfigs)
      .values(data)
      .onConflictDoUpdate({
        target: [architectureAgentConfigs.versionId, architectureAgentConfigs.agentKey],
        set: {
          executionOrder: data.executionOrder,
          modelKey: data.modelKey,
          promptVersion: data.promptVersion,
          isEnabled: data.isEnabled,
          config: data.config,
        },
      })
      .returning();
    return config;
  },

  // ─── Capability Configs ───────────────────────────────────────────────────

  async listCapabilityConfigs(versionId: string): Promise<ArchitectureCapabilityConfig[]> {
    return db
      .select()
      .from(architectureCapabilityConfigs)
      .where(eq(architectureCapabilityConfigs.versionId, versionId));
  },

  async upsertCapabilityConfig(data: InsertArchitectureCapabilityConfig): Promise<ArchitectureCapabilityConfig> {
    const [config] = await db
      .insert(architectureCapabilityConfigs)
      .values(data)
      .onConflictDoUpdate({
        target: [architectureCapabilityConfigs.versionId, architectureCapabilityConfigs.capabilityKey],
        set: {
          isEnabled: data.isEnabled,
          requiresApproval: data.requiresApproval,
        },
      })
      .returning();
    return config;
  },

  // ─── Template Bindings ────────────────────────────────────────────────────

  async upsertTemplateBinding(data: InsertArchitectureTemplateBinding) {
    const [binding] = await db
      .insert(architectureTemplateBindings)
      .values(data)
      .returning();
    return binding;
  },

  // ─── Policy Bindings ──────────────────────────────────────────────────────

  async upsertPolicyBinding(data: InsertArchitecturePolicyBinding) {
    const [binding] = await db
      .insert(architecturePolicyBindings)
      .values(data)
      .returning();
    return binding;
  },
};
