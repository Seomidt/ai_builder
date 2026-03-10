import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const orgMemberRoleEnum = pgEnum("org_member_role", [
  "owner",
  "admin",
  "member",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "archived",
]);

export const archProfileStatusEnum = pgEnum("arch_profile_status", [
  "active",
  "archived",
]);

export const integrationProviderEnum = pgEnum("integration_provider", [
  "github",
  "openai",
  "vercel",
  "supabase",
  "cloudflare",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "active",
  "inactive",
]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const stepStatusEnum = pgEnum("step_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export const toolCallStatusEnum = pgEnum("tool_call_status", [
  "pending",
  "success",
  "failed",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

export const knowledgeSourceTypeEnum = pgEnum("knowledge_source_type", [
  "manual",
  "github",
  "url",
]);

export const knowledgeStatusEnum = pgEnum("knowledge_status", [
  "pending",
  "indexed",
  "failed",
]);

// ─── Profiles (extends Supabase auth.users) ──────────────────────────────────

export const profiles = pgTable("profiles", {
  id: varchar("id").primaryKey(), // matches auth.users.id (UUID)
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Organizations ────────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: varchar("user_id").notNull(), // auth.users.id
    role: orgMemberRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("org_members_org_idx").on(t.organizationId),
    index("org_members_user_idx").on(t.userId),
    uniqueIndex("org_members_unique_idx").on(t.organizationId, t.userId),
  ],
);

// ─── Projects ─────────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("active"),
    createdBy: varchar("created_by").notNull(), // auth.users.id
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId),
    index("projects_status_idx").on(t.status),
    uniqueIndex("projects_org_slug_idx").on(t.organizationId, t.slug),
  ],
);

// ─── Architecture Profiles ────────────────────────────────────────────────────

export const architectureProfiles = pgTable(
  "architecture_profiles",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    category: text("category"),
    status: archProfileStatusEnum("status").notNull().default("active"),
    currentVersionId: varchar("current_version_id"), // FK set after versions table
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("arch_profiles_org_idx").on(t.organizationId),
    index("arch_profiles_status_idx").on(t.status),
    uniqueIndex("arch_profiles_org_slug_idx").on(t.organizationId, t.slug),
  ],
);

export const architectureVersions = pgTable(
  "architecture_versions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    architectureProfileId: varchar("architecture_profile_id")
      .notNull()
      .references(() => architectureProfiles.id),
    versionNumber: text("version_number").notNull(), // e.g. "1.0.0"
    workflowKey: text("workflow_key"),
    config: jsonb("config"),
    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("arch_versions_profile_idx").on(t.architectureProfileId),
    index("arch_versions_published_idx").on(t.isPublished),
    uniqueIndex("arch_versions_profile_number_idx").on(
      t.architectureProfileId,
      t.versionNumber,
    ),
  ],
);

export const architectureAgentConfigs = pgTable(
  "architecture_agent_configs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    versionId: varchar("version_id")
      .notNull()
      .references(() => architectureVersions.id),
    agentKey: text("agent_key").notNull(),
    executionOrder: integer("execution_order").notNull().default(0),
    modelKey: text("model_key"),
    promptVersion: text("prompt_version"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    config: jsonb("config"),
  },
  (t) => [
    index("agent_configs_version_idx").on(t.versionId),
    uniqueIndex("agent_configs_version_key_idx").on(t.versionId, t.agentKey),
  ],
);

export const architectureCapabilityConfigs = pgTable(
  "architecture_capability_configs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    versionId: varchar("version_id")
      .notNull()
      .references(() => architectureVersions.id),
    capabilityKey: text("capability_key").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(false),
  },
  (t) => [
    index("cap_configs_version_idx").on(t.versionId),
    uniqueIndex("cap_configs_version_key_idx").on(
      t.versionId,
      t.capabilityKey,
    ),
  ],
);

export const architectureTemplateBindings = pgTable(
  "architecture_template_bindings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    versionId: varchar("version_id")
      .notNull()
      .references(() => architectureVersions.id),
    templateKey: text("template_key").notNull(),
    templateRef: text("template_ref").notNull(),
  },
  (t) => [index("template_bindings_version_idx").on(t.versionId)],
);

export const architecturePolicyBindings = pgTable(
  "architecture_policy_bindings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    versionId: varchar("version_id")
      .notNull()
      .references(() => architectureVersions.id),
    policyKey: text("policy_key").notNull(),
    policyConfig: jsonb("policy_config"),
  },
  (t) => [index("policy_bindings_version_idx").on(t.versionId)],
);

// ─── AI Runs (lifecycle resource) ────────────────────────────────────────────

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: varchar("project_id")
      .notNull()
      .references(() => projects.id),
    architectureProfileId: varchar("architecture_profile_id")
      .notNull()
      .references(() => architectureProfiles.id),
    architectureVersionId: varchar("architecture_version_id")
      .notNull()
      .references(() => architectureVersions.id),
    status: runStatusEnum("status").notNull().default("pending"),
    createdBy: varchar("created_by").notNull(), // auth.users.id
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_runs_org_idx").on(t.organizationId),
    index("ai_runs_project_idx").on(t.projectId),
    index("ai_runs_status_idx").on(t.status),
    index("ai_runs_arch_profile_idx").on(t.architectureProfileId),
  ],
);

export const aiSteps = pgTable(
  "ai_steps",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: varchar("run_id")
      .notNull()
      .references(() => aiRuns.id),
    stepKey: text("step_key").notNull(),
    agentKey: text("agent_key").notNull(),
    status: stepStatusEnum("status").notNull().default("pending"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_steps_run_idx").on(t.runId)],
);

export const aiArtifacts = pgTable(
  "ai_artifacts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: varchar("run_id")
      .notNull()
      .references(() => aiRuns.id),
    stepId: varchar("step_id").references(() => aiSteps.id),
    artifactType: text("artifact_type").notNull(), // e.g. "file", "plan", "spec"
    title: text("title").notNull(),
    content: text("content"),
    metadata: jsonb("metadata"), // path, mimeType, githubRef, etc.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_artifacts_run_idx").on(t.runId),
    index("ai_artifacts_type_idx").on(t.artifactType),
  ],
);

export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: varchar("run_id")
      .notNull()
      .references(() => aiRuns.id),
    stepId: varchar("step_id").references(() => aiSteps.id),
    toolName: text("tool_name").notNull(),
    toolVersion: text("tool_version"),
    input: jsonb("input"),
    output: jsonb("output"),
    status: toolCallStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    executedAt: timestamp("executed_at"),
  },
  (t) => [
    index("ai_tool_calls_run_idx").on(t.runId),
    index("ai_tool_calls_tool_idx").on(t.toolName),
  ],
);

export const aiApprovals = pgTable(
  "ai_approvals",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: varchar("run_id")
      .notNull()
      .references(() => aiRuns.id),
    stepId: varchar("step_id").references(() => aiSteps.id),
    requestedBy: varchar("requested_by").notNull(), // auth.users.id
    approvedBy: varchar("approved_by"), // auth.users.id nullable
    status: approvalStatusEnum("status").notNull().default("pending"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [
    index("ai_approvals_run_idx").on(t.runId),
    index("ai_approvals_status_idx").on(t.status),
  ],
);

// ─── Integrations ─────────────────────────────────────────────────────────────

export const integrations = pgTable(
  "integrations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: integrationProviderEnum("provider").notNull(),
    status: integrationStatusEnum("status").notNull().default("inactive"),
    config: jsonb("config"), // non-sensitive metadata only
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("integrations_org_idx").on(t.organizationId),
    uniqueIndex("integrations_org_provider_idx").on(
      t.organizationId,
      t.provider,
    ),
  ],
);

export const organizationSecrets = pgTable(
  "organization_secrets",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    key: text("key").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("org_secrets_org_idx").on(t.organizationId),
    uniqueIndex("org_secrets_org_key_idx").on(t.organizationId, t.key),
  ],
);

// ─── Knowledge Documents (RAG foundation) ────────────────────────────────────

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: varchar("project_id").references(() => projects.id),
    title: text("title").notNull(),
    sourceType: knowledgeSourceTypeEnum("source_type").notNull().default("manual"),
    sourceRef: text("source_ref"), // URL, GitHub path, etc.
    contentHash: text("content_hash"),
    status: knowledgeStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_docs_org_idx").on(t.organizationId),
    index("knowledge_docs_project_idx").on(t.projectId),
    index("knowledge_docs_status_idx").on(t.status),
  ],
);

// ─── Insert Schemas ───────────────────────────────────────────────────────────

export const insertOrganizationSchema = createInsertSchema(organizations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertArchitectureProfileSchema = createInsertSchema(
  architectureProfiles,
).omit({ id: true, createdAt: true, updatedAt: true, currentVersionId: true });

export const insertArchitectureVersionSchema = createInsertSchema(
  architectureVersions,
).omit({ id: true, createdAt: true, publishedAt: true });

export const insertArchitectureAgentConfigSchema = createInsertSchema(
  architectureAgentConfigs,
).omit({ id: true });

export const insertArchitectureCapabilityConfigSchema = createInsertSchema(
  architectureCapabilityConfigs,
).omit({ id: true });

export const insertArchitectureTemplateBindingSchema = createInsertSchema(
  architectureTemplateBindings,
).omit({ id: true });

export const insertArchitecturePolicyBindingSchema = createInsertSchema(
  architecturePolicyBindings,
).omit({ id: true });

export const insertAiRunSchema = createInsertSchema(aiRuns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
});

export const insertAiStepSchema = createInsertSchema(aiSteps).omit({
  id: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
});

export const insertAiArtifactSchema = createInsertSchema(aiArtifacts).omit({
  id: true,
  createdAt: true,
});

export const insertAiToolCallSchema = createInsertSchema(aiToolCalls).omit({
  id: true,
  executedAt: true,
});

export const insertAiApprovalSchema = createInsertSchema(aiApprovals).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertIntegrationSchema = createInsertSchema(integrations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertKnowledgeDocumentSchema = createInsertSchema(
  knowledgeDocuments,
).omit({ id: true, createdAt: true, updatedAt: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

export type InsertArchitectureProfile = z.infer<typeof insertArchitectureProfileSchema>;
export type ArchitectureProfile = typeof architectureProfiles.$inferSelect;

export type InsertArchitectureVersion = z.infer<typeof insertArchitectureVersionSchema>;
export type ArchitectureVersion = typeof architectureVersions.$inferSelect;

export type InsertArchitectureAgentConfig = z.infer<typeof insertArchitectureAgentConfigSchema>;
export type ArchitectureAgentConfig = typeof architectureAgentConfigs.$inferSelect;

export type InsertArchitectureCapabilityConfig = z.infer<typeof insertArchitectureCapabilityConfigSchema>;
export type ArchitectureCapabilityConfig = typeof architectureCapabilityConfigs.$inferSelect;

export type InsertAiRun = z.infer<typeof insertAiRunSchema>;
export type AiRun = typeof aiRuns.$inferSelect;

export type InsertAiStep = z.infer<typeof insertAiStepSchema>;
export type AiStep = typeof aiSteps.$inferSelect;

export type InsertAiArtifact = z.infer<typeof insertAiArtifactSchema>;
export type AiArtifact = typeof aiArtifacts.$inferSelect;

export type InsertAiToolCall = z.infer<typeof insertAiToolCallSchema>;
export type AiToolCall = typeof aiToolCalls.$inferSelect;

export type InsertAiApproval = z.infer<typeof insertAiApprovalSchema>;
export type AiApproval = typeof aiApprovals.$inferSelect;

export type InsertIntegration = z.infer<typeof insertIntegrationSchema>;
export type Integration = typeof integrations.$inferSelect;

export type InsertKnowledgeDocument = z.infer<typeof insertKnowledgeDocumentSchema>;
export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;

// Legacy types kept for compatibility
export const users = profiles;
export const insertUserSchema = createInsertSchema(profiles).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof profiles.$inferSelect;
