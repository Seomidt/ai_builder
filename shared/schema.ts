import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  integer,
  numeric,
  pgEnum,
  index,
  uniqueIndex,
  check,
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
    // GitHub repo binding
    githubOwner: text("github_owner"),
    githubRepo: text("github_repo"),
    githubDefaultBranch: text("github_default_branch").default("main"),
    githubRepoUrl: text("github_repo_url"),
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
    // ── GitHub versioning metadata ─────────────────────────────────────────
    versionLabel: text("version_label"),             // human label e.g. "Initial Release"
    description: text("description"),               // what changed in this version
    changelog: text("changelog"),                   // markdown changelog — used in commit body
    // ── Pipeline ─────────────────────────────────────────────────────────
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
    // ── Identity & versioning ────────────────────────────────────────────────
    runNumber: integer("run_number").notNull().default(0),   // sequential per org: 1, 2, 3 …
    title: text("title"),                                     // e.g. "Implement auth module"
    description: text("description"),                         // longer goal description
    tags: text("tags").array(),                               // e.g. ["auth", "backend"]
    // ── Pipeline ─────────────────────────────────────────────────────────────
    status: runStatusEnum("status").notNull().default("pending"),
    goal: text("goal"),                                       // original user prompt / intent
    pipelineVersion: text("pipeline_version"),                // e.g. "v1.2"
    // ── Timing ───────────────────────────────────────────────────────────────
    createdBy: varchar("created_by").notNull(),               // auth.users.id
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),                     // any terminal state
    completedAt: timestamp("completed_at"),                   // only on successful completion
    // ── GitHub (populated once GitHub write pipeline is enabled) ─────────────
    githubBranch: text("github_branch"),                      // branch created for this run
    githubCommitSha: text("github_commit_sha"),               // commit SHA of the final push
    githubPrNumber: integer("github_pr_number"),              // PR opened for review
    githubTags: text("github_tags").array(),                  // e.g. ["ai-run-v3"]
    // ── Audit ─────────────────────────────────────────────────────────────────
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_runs_org_idx").on(t.organizationId),
    index("ai_runs_project_idx").on(t.projectId),
    index("ai_runs_status_idx").on(t.status),
    index("ai_runs_arch_profile_idx").on(t.architectureProfileId),
    index("ai_runs_run_number_idx").on(t.organizationId, t.runNumber),
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
    title: text("title"),
    description: text("description"),
    tags: text("tags").array(),
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
    artifactType: text("artifact_type").notNull(), // e.g. "file", "plan", "spec", "pr_description"
    title: text("title").notNull(),
    description: text("description"),
    content: text("content"),
    path: text("path"),       // file path for code/file artifacts
    version: text("version"), // artifact-level version e.g. "v2"
    tags: text("tags").array(),
    metadata: jsonb("metadata"), // mimeType, githubRef, size, encoding, etc.
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
    approvedBy: varchar("approved_by"),             // auth.users.id nullable
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

// ─── Artifact Dependencies ───────────────────────────────────────────────────

export const artifactDependencies = pgTable(
  "artifact_dependencies",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    fromArtifactId: varchar("from_artifact_id")
      .notNull()
      .references(() => aiArtifacts.id),
    toArtifactId: varchar("to_artifact_id")
      .notNull()
      .references(() => aiArtifacts.id),
    dependencyType: text("dependency_type").notNull().default("uses"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("artifact_deps_from_idx").on(t.fromArtifactId),
    index("artifact_deps_to_idx").on(t.toArtifactId),
    index("artifact_deps_org_idx").on(t.organizationId),
  ],
);

// ─── AI Usage Limits ──────────────────────────────────────────────────────────

/**
 * Per-tenant AI usage budget configuration.
 *
 * One row per tenant. Controls warning threshold (budget mode) and hard stop.
 * Admin creates/updates rows; runtime reads them each AI call via guards.ts.
 *
 * Percent fields are integers: 80 = 80% of monthly_ai_budget_usd.
 * If no row exists for a tenant, guards.ts treats it as unlimited (normal).
 */
export const aiUsageLimits = pgTable(
  "ai_usage_limits",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** Monthly AI budget ceiling in USD */
    monthlyAiBudgetUsd: numeric("monthly_ai_budget_usd", { precision: 12, scale: 6 }).notNull(),
    /** Percent of budget at which budget_mode is entered (default: 80) */
    warningThresholdPercent: integer("warning_threshold_percent").notNull().default(80),
    /** Percent of budget at which AI access is blocked (default: 100) */
    hardLimitPercent: integer("hard_limit_percent").notNull().default(100),
    /** Whether to enter budget mode at warning threshold */
    budgetModeEnabled: boolean("budget_mode_enabled").notNull().default(true),
    /** Whether to hard-stop AI calls at hard limit */
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    /** Whether to allow overage beyond the hard limit (future pay-as-you-go hook) */
    overageAllowed: boolean("overage_allowed").notNull().default(false),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_usage_limits_tenant_idx").on(t.tenantId),
  ],
);

export const insertAiUsageLimitSchema = createInsertSchema(aiUsageLimits).omit({
  id: true,
  createdAt: true,
});
export type InsertAiUsageLimit = z.infer<typeof insertAiUsageLimitSchema>;
export type AiUsageLimit = typeof aiUsageLimits.$inferSelect;

// ─── Usage Threshold Events ───────────────────────────────────────────────────

/**
 * Records when a tenant newly crosses a usage threshold.
 *
 * Foundation only — no notifications, no workers.
 * Prevents the same threshold event from being recorded repeatedly
 * by checking for unresolved recent events before inserting.
 *
 * event_type examples: "warning_threshold_reached", "hard_limit_reached"
 * metric_type: "ai" (extensible for future storage / compute guardrails)
 */
export const usageThresholdEvents = pgTable(
  "usage_threshold_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** Category of metric: "ai" */
    metricType: text("metric_type").notNull(),
    /** e.g. "warning_threshold_reached" | "hard_limit_reached" */
    eventType: text("event_type").notNull(),
    /** Threshold percent that was reached */
    thresholdPercent: integer("threshold_percent").notNull(),
    /** Current metric value (AI usage cost USD) at event time */
    metricValue: numeric("metric_value", { precision: 12, scale: 6 }).notNull(),
    /** Configured budget value (USD) at event time */
    budgetValue: numeric("budget_value", { precision: 12, scale: 6 }).notNull(),
    /** Request ID that triggered the threshold crossing, if available */
    requestId: text("request_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Set when threshold is resolved (usage drops below, or limit raised) */
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [
    index("usage_threshold_events_tenant_idx").on(t.tenantId),
    index("usage_threshold_events_event_type_idx").on(t.eventType),
    index("usage_threshold_events_created_at_idx").on(t.createdAt),
  ],
);

export const insertUsageThresholdEventSchema = createInsertSchema(usageThresholdEvents).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});
export type InsertUsageThresholdEvent = z.infer<typeof insertUsageThresholdEventSchema>;
export type UsageThresholdEvent = typeof usageThresholdEvents.$inferSelect;

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
  runNumber: true,  // assigned by storage layer
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
  completedAt: true,
  githubBranch: true,
  githubCommitSha: true,
  githubPrNumber: true,
  githubTags: true,
});

export const insertAiStepSchema = createInsertSchema(aiSteps).omit({
  id: true,
  createdAt: true,
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

export const insertArtifactDependencySchema = createInsertSchema(
  artifactDependencies,
).omit({ id: true, createdAt: true });

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

export type InsertArtifactDependency = z.infer<typeof insertArtifactDependencySchema>;
export type ArtifactDependency = typeof artifactDependencies.$inferSelect;

// ─── AI Usage Log ─────────────────────────────────────────────────────────────
// Infrastructure table — records every LLM call for cost, latency, and debugging.
// Intentionally generic: no business-domain columns.

export const aiUsageStatusEnum = pgEnum("ai_usage_status", ["success", "error", "blocked"]);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Optional: which tenant (org) made this call */
    tenantId: varchar("tenant_id"),
    /** Optional: which user triggered this call */
    userId: varchar("user_id"),
    /** Optional: HTTP request ID for tracing AI calls back to their origin request */
    requestId: text("request_id"),
    /** Feature or agent key that made the call (e.g. "planner_agent", "summarize") */
    feature: text("feature").notNull(),
    /** AI provider key — "openai" | "anthropic" | "google" */
    provider: text("provider"),
    /** OpenAI model used (e.g. "gpt-4.1-mini") */
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** First 500 chars of the user input, for debugging only */
    inputPreview: text("input_preview"),
    status: aiUsageStatusEnum("status").notNull().default("success"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms"),
    /** Estimated USD cost calculated from token usage × pricing — null if pricing unknown */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 8 }),
    /**
     * Which pricing source resolved pricing for this call.
     * "db_override" = active row from ai_model_pricing table
     * "code_default" = fallback from AI_MODEL_PRICING_DEFAULTS in costs.ts
     * null = no pricing found (estimated_cost_usd will also be null)
     */
    pricingSource: text("pricing_source"),
    /**
     * Version identifier for the pricing used.
     * For "db_override": the ai_model_pricing row id
     * For "code_default": null (code defaults have no version id)
     * null when pricingSource is null
     */
    pricingVersion: text("pricing_version"),
    /**
     * Input tokens actually used as the billable basis for cost math.
     * Equals prompt_tokens in current formula. Null means same as prompt_tokens.
     * Stored explicitly so future billing can reconstruct the cost calculation.
     */
    inputTokensBillable: integer("input_tokens_billable"),
    /**
     * Output tokens actually used as the billable basis for cost math.
     * Equals completion_tokens in current formula. Null means same as completion_tokens.
     */
    outputTokensBillable: integer("output_tokens_billable"),
    /**
     * Cached prompt/context tokens returned by the provider.
     * OpenAI: usage.input_token_details.cached_tokens — 0 if not reported.
     * Used for future cache-aware pricing and analytics.
     */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /**
     * Reasoning tokens (OpenAI o-series models) returned by the provider.
     * OpenAI: usage.output_token_details.reasoning_tokens — 0 if not reported.
     * Used for future model-specific pricing and analytics.
     */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_tenant_id_idx").on(t.tenantId),
    index("ai_usage_user_id_idx").on(t.userId),
    index("ai_usage_feature_idx").on(t.feature),
    index("ai_usage_created_at_idx").on(t.createdAt),
    index("ai_usage_request_id_idx").on(t.requestId),
    // Composite index for period range queries: WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
    index("ai_usage_tenant_created_at_idx").on(t.tenantId, t.createdAt),
    // Composite index for status-filtered period queries (raw fallback path in guards)
    index("ai_usage_tenant_status_created_at_idx").on(t.tenantId, t.status, t.createdAt),
    // Idempotency: one log row per tenant+request. NULL request_id is excluded (untraceable calls
    // are not deduplicated — they have no stable identity to compare against).
    uniqueIndex("ai_usage_tenant_request_id_idx")
      .on(t.tenantId, t.requestId)
      .where(sql`request_id IS NOT NULL`),
    // Cost sanity: estimated cost must be non-negative if present
    check("ai_usage_cost_non_negative_check", sql`estimated_cost_usd IS NULL OR estimated_cost_usd >= 0`),
  ],
);

export const insertAiUsageSchema = createInsertSchema(aiUsage).omit({ id: true, createdAt: true });
export type InsertAiUsage = z.infer<typeof insertAiUsageSchema>;
export type AiUsage = typeof aiUsage.$inferSelect;

// ─── AI Model Overrides ───────────────────────────────────────────────────────

/**
 * Stores DB-level overrides for AI model routing.
 *
 * Overrides are keyed by route_key (e.g. "default", "cheap", "coding"),
 * not by feature. Features map to route keys; route keys map to overrides.
 *
 * Supported scopes:
 *   - "global"  — applies to all tenants unless overridden at tenant level
 *   - "tenant"  — applies to a specific organization
 *
 * Priority: tenant → global → code default (AI_MODEL_ROUTES in config.ts)
 *
 * The unique index uses coalesce(scope_id, 'global') to prevent duplicate
 * active global rows despite NULL scope_id (NULLs do not collide in Postgres
 * unique indexes without this workaround).
 */
export const aiModelOverrides = pgTable(
  "ai_model_overrides",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** "global" | "tenant" */
    scope: text("scope").notNull(),
    /** NULL for global scope; organization id for tenant scope */
    scopeId: text("scope_id"),
    /** Logical route key: "default" | "heavy" | "coding" | "cheap" | "reasoning" | "nano" */
    routeKey: text("route_key").notNull(),
    /** Provider key: "openai" | "anthropic" | "google" */
    provider: text("provider").notNull(),
    /** Concrete model string e.g. "gpt-4.1", "claude-opus-4-5" */
    model: text("model").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_model_overrides_active_idx").on(t.isActive),
    index("ai_model_overrides_route_key_idx").on(t.routeKey),
    // Enforces "global" | "tenant" only — prevents silent bad data
    check("ai_model_overrides_scope_check", sql`scope IN ('global', 'tenant')`),
    // Partial unique index for active rows is applied directly via SQL (see replit.md) because
    // Drizzle does not support expression indexes (COALESCE). Index name:
    //   ai_model_overrides_active_unique_idx
    //   ON ai_model_overrides (scope, COALESCE(scope_id, 'global'), route_key) WHERE is_active = true
  ],
);

export const insertAiModelOverrideSchema = createInsertSchema(aiModelOverrides).omit({
  id: true,
  createdAt: true,
});
export type InsertAiModelOverride = z.infer<typeof insertAiModelOverrideSchema>;
export type AiModelOverride = typeof aiModelOverrides.$inferSelect;

// ─── AI Model Pricing ─────────────────────────────────────────────────────────

/**
 * Stores DB-level pricing for AI provider + model pairs.
 *
 * Used by the pricing loader (server/lib/ai/pricing.ts) to estimate the USD
 * cost of every AI call and persist it on ai_usage.estimated_cost_usd.
 *
 * Rules:
 *   - Only one active pricing row per provider + model (enforced by partial unique index)
 *   - DB pricing takes priority over code defaults in server/lib/ai/costs.ts
 *   - Rows are deactivated rather than deleted to preserve history for future Admin UI
 *
 * Future Admin UI will be able to list, create, and deactivate rows without
 * any runtime refactor.
 */
export const aiModelPricing = pgTable(
  "ai_model_pricing",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** AI provider key — "openai" | "anthropic" | "google" */
    provider: text("provider").notNull(),
    /** Concrete model identifier — e.g. "gpt-4.1-mini" */
    model: text("model").notNull(),
    /** USD cost per 1,000,000 input tokens */
    inputPerMillionUsd: numeric("input_per_million_usd", { precision: 10, scale: 6 }).notNull(),
    /** USD cost per 1,000,000 output tokens */
    outputPerMillionUsd: numeric("output_per_million_usd", { precision: 10, scale: 6 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /** Optional context for Admin — e.g. "Updated after OpenAI price drop 2025-04" */
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_model_pricing_active_idx").on(t.isActive),
    index("ai_model_pricing_provider_model_idx").on(t.provider, t.model),
    // Enforces at most one active pricing row per provider+model combination
    uniqueIndex("ai_model_pricing_active_unique_idx")
      .on(t.provider, t.model)
      .where(sql`is_active = true`),
  ],
);

export const insertAiModelPricingSchema = createInsertSchema(aiModelPricing).omit({
  id: true,
  createdAt: true,
});
export type InsertAiModelPricing = z.infer<typeof insertAiModelPricingSchema>;
export type AiModelPricing = typeof aiModelPricing.$inferSelect;

// ─── Tenant AI Usage Periods ──────────────────────────────────────────────────
// Fast runtime/admin/billing summary table.
//
// Layer 2 of the 2-layer usage architecture:
//   Layer 1: ai_usage = raw append-only audit/event log
//   Layer 2: tenant_ai_usage_periods = pre-aggregated period summary for fast reads
//
// One row per tenant + period. Updated synchronously when ai_usage is written.
// Allows guardrails and future billing to avoid scanning raw ai_usage on every call.

export const tenantAiUsagePeriods = pgTable(
  "tenant_ai_usage_periods",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** Inclusive start of this billing/usage period (calendar month start for now) */
    periodStart: timestamp("period_start").notNull(),
    /** Exclusive end of this billing/usage period (calendar month start of next month) */
    periodEnd: timestamp("period_end").notNull(),
    /** Running sum of estimated_cost_usd for successful calls in this period */
    totalCostUsd: numeric("total_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Count of successful AI calls in this period */
    totalRequests: integer("total_requests").notNull().default(0),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One aggregate row per tenant per period
    uniqueIndex("tenant_ai_usage_periods_tenant_period_idx").on(
      t.tenantId,
      t.periodStart,
      t.periodEnd,
    ),
    // Fast tenant period lookup for guardrails and admin
    index("tenant_ai_usage_periods_tenant_idx").on(t.tenantId),
  ],
);

export const insertTenantAiUsagePeriodSchema = createInsertSchema(tenantAiUsagePeriods).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTenantAiUsagePeriod = z.infer<typeof insertTenantAiUsagePeriodSchema>;
export type TenantAiUsagePeriod = typeof tenantAiUsagePeriods.$inferSelect;

// ─── Tenant Rate Limits ───────────────────────────────────────────────────────
// Admin-configured per-tenant rate and concurrency limits for AI request safety.
// One active row per tenant. Overrides global AI_SAFETY_DEFAULTS in config.ts.

export const tenantRateLimits = pgTable(
  "tenant_rate_limits",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** Maximum AI requests allowed per minute */
    requestsPerMinute: integer("requests_per_minute").notNull(),
    /** Maximum AI requests allowed per hour */
    requestsPerHour: integer("requests_per_hour").notNull(),
    /** Maximum simultaneous in-flight AI requests for this tenant */
    maxConcurrentRequests: integer("max_concurrent_requests").notNull(),
    /** When false, this row is ignored and global defaults apply */
    isActive: boolean("is_active").notNull().default(true),
    /** Optional admin notes */
    notes: text("notes"),
    /** Who created this limit row */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // One active limit row per tenant — partial unique index consistent with repo conventions
    uniqueIndex("tenant_rate_limits_tenant_active_idx")
      .on(t.tenantId)
      .where(sql`is_active = true`),
    index("tenant_rate_limits_tenant_idx").on(t.tenantId),
  ],
);

export const insertTenantRateLimitSchema = createInsertSchema(tenantRateLimits).omit({ id: true, createdAt: true });
export type InsertTenantRateLimit = z.infer<typeof insertTenantRateLimitSchema>;
export type TenantRateLimit = typeof tenantRateLimits.$inferSelect;

// ─── Request Safety Events ────────────────────────────────────────────────────
// Append-only event log for request-level safety blocks.
// Distinct from usage_threshold_events (which tracks budget thresholds).
// Provides traceability for token cap, rate limit, and concurrency blocks.

export const requestSafetyEvents = pgTable(
  "request_safety_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** HTTP request ID — ties this event back to its origin request */
    requestId: text("request_id"),
    /** Feature key that triggered the blocked call */
    feature: text("feature"),
    /**
     * What kind of safety block occurred.
     * "token_cap_exceeded"  — input too large before provider call
     * "rate_limit_blocked"  — tenant exceeded requests_per_minute or requests_per_hour
     * "concurrency_blocked" — too many simultaneous in-flight requests for this tenant
     */
    eventType: text("event_type").notNull(),
    /** Observed value that triggered the block (tokens, request count, concurrent count) */
    metricValue: integer("metric_value"),
    /** Configured limit that was breached */
    limitValue: integer("limit_value"),
    /** Logical route key used for this call (e.g. "default", "heavy") */
    routeKey: text("route_key"),
    /** Resolved provider at time of block */
    provider: text("provider"),
    /** Resolved model at time of block */
    model: text("model"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("request_safety_events_tenant_idx").on(t.tenantId),
    index("request_safety_events_tenant_created_at_idx").on(t.tenantId, t.createdAt),
    index("request_safety_events_event_type_idx").on(t.eventType),
  ],
);

export const insertRequestSafetyEventSchema = createInsertSchema(requestSafetyEvents).omit({ id: true, createdAt: true });
export type InsertRequestSafetyEvent = z.infer<typeof insertRequestSafetyEventSchema>;
export type RequestSafetyEvent = typeof requestSafetyEvents.$inferSelect;

// ─── AI Response Cache ────────────────────────────────────────────────────────
// Stores successful normalized AI responses keyed by tenant + deterministic hash.
// Only successful provider responses are stored here — never blocked/error outcomes.
// Unique constraint on (tenant_id, cache_key) enforces tenant isolation at DB level.

export const aiResponseCache = pgTable(
  "ai_response_cache",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Tenant that owns this cache entry — never reused across tenants */
    tenantId: text("tenant_id").notNull(),
    /** Logical route key used when this response was generated */
    routeKey: text("route_key").notNull(),
    /** Resolved provider at write time */
    provider: text("provider").notNull(),
    /** Resolved model at write time */
    model: text("model").notNull(),
    /**
     * SHA-256 hash of the fully qualified cache fingerprint.
     * Includes tenantId, routeKey, provider, model, cacheKeyVersion,
     * and SHA-256 of (systemPrompt + "|" + userInput).
     * Unique per tenant — enforced via unique index.
     */
    cacheKey: text("cache_key").notNull(),
    /**
     * Pre-hash fingerprint for debugging (without raw prompt text).
     * Format: "<version>:<tenantId>:<routeKey>:<provider>:<model>:<contentHash>"
     */
    requestFingerprint: text("request_fingerprint").notNull(),
    /**
     * Full normalized AI response stored as JSON.
     * Shape: { text: string, usage: {...} | null, model: string, feature: string }
     */
    responsePayload: jsonb("response_payload").notNull(),
    /** Response text extracted from payload for direct reads without JSON parsing */
    responseText: text("response_text"),
    /** Always "success" — only successful provider responses are cached */
    status: text("status").notNull().default("success"),
    /** TTL in seconds from write time */
    ttlSeconds: integer("ttl_seconds").notNull(),
    /** Absolute expiry timestamp — entries past this are stale and must not be returned */
    expiresAt: timestamp("expires_at").notNull(),
    /** Number of times this entry has been served from cache */
    hitCount: integer("hit_count").notNull().default(0),
    /** Timestamp of most recent cache hit */
    lastHitAt: timestamp("last_hit_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_response_cache_tenant_key_idx").on(t.tenantId, t.cacheKey),
    index("ai_response_cache_tenant_idx").on(t.tenantId),
    index("ai_response_cache_expires_idx").on(t.expiresAt),
    index("ai_response_cache_tenant_route_idx").on(t.tenantId, t.routeKey),
  ],
);

export const insertAiResponseCacheSchema = createInsertSchema(aiResponseCache).omit({ id: true, createdAt: true, hitCount: true });
export type InsertAiResponseCache = z.infer<typeof insertAiResponseCacheSchema>;
export type AiResponseCache = typeof aiResponseCache.$inferSelect;

// ─── AI Cache Events ─────────────────────────────────────────────────────────
// Append-only event log for cache hit/miss/write/skip observability.
// Used for analytics and debugging — not in hot-path decision-making.

export const aiCacheEvents = pgTable(
  "ai_cache_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** HTTP request ID — ties this event back to its origin request */
    requestId: text("request_id"),
    /** Logical route key used for this call */
    routeKey: text("route_key"),
    /** Resolved provider */
    provider: text("provider"),
    /** Resolved model */
    model: text("model"),
    /**
     * What happened at the cache layer.
     * "cache_hit"   — valid cached response found and returned (no provider call)
     * "cache_miss"  — no valid cache entry; provider call will follow
     * "cache_write" — successful provider response written to cache
     * "cache_skip"  — route is cacheable but caching skipped (see reason)
     */
    eventType: text("event_type").notNull(),
    /** SHA-256 cache key used for the lookup or write */
    cacheKey: text("cache_key"),
    /** Human-readable reason for cache_skip events */
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_cache_events_tenant_idx").on(t.tenantId),
    index("ai_cache_events_event_type_idx").on(t.eventType),
    index("ai_cache_events_created_at_idx").on(t.createdAt),
    index("ai_cache_events_tenant_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertAiCacheEventSchema = createInsertSchema(aiCacheEvents).omit({ id: true, createdAt: true });
export type InsertAiCacheEvent = z.infer<typeof insertAiCacheEventSchema>;
export type AiCacheEvent = typeof aiCacheEvents.$inferSelect;

// ─── AI Request States ────────────────────────────────────────────────────────
// Persisted idempotency state for AI calls.
// One row per (tenant_id, request_id) — unique constraint enforced at DB level.
//
// Lifecycle:
//   "in_progress" — request is actively executing (provider call not yet finished)
//   "completed"   — provider call succeeded; response_payload is safe for replay
//   "failed"      — provider call failed; retries are allowed after this state
//
// Retention: rows expire 24 hours after creation. This window:
//   - Covers all realistic client retry windows (browser backoff, mobile reconnect)
//   - Is long enough to protect against same-day replay storms
//   - Is short enough not to accumulate unbounded state
//   - Matches a single working session; next-day requests get fresh state

export const aiRequestStates = pgTable(
  "ai_request_states",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Tenant that owns this request state — never shared across tenants */
    tenantId: text("tenant_id").notNull(),
    /** Caller-supplied request ID — idempotency scope key */
    requestId: text("request_id").notNull(),
    /** Route key used for this request */
    routeKey: text("route_key").notNull(),
    /** Resolved provider at request start (null if resolution failed before record) */
    provider: text("provider"),
    /** Resolved model at request start */
    model: text("model"),
    /**
     * Current state of this request execution.
     * "in_progress" — actively executing, no result yet
     * "completed"   — succeeded; response_payload populated for replay
     * "failed"      — execution failed; retries allowed
     */
    status: text("status").notNull(),
    /**
     * Normalized success response stored for deterministic replay.
     * Shape: { text: string, usage: {...}|null, model: string, feature: string }
     * Only populated when status = "completed". Null otherwise.
     */
    responsePayload: jsonb("response_payload"),
    /** HTTP status code of the final response */
    responseStatusCode: integer("response_status_code"),
    /** Stable error code from AiError subclass (populated on failure) */
    errorCode: text("error_code"),
    /** When the request execution began */
    startedAt: timestamp("started_at").notNull().defaultNow(),
    /** When the request execution ended (success or failure) */
    completedAt: timestamp("completed_at"),
    /** Absolute expiry — rows past this time can be purged */
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_request_states_tenant_request_idx").on(t.tenantId, t.requestId),
    index("ai_request_states_tenant_idx").on(t.tenantId),
    index("ai_request_states_status_idx").on(t.status),
    index("ai_request_states_expires_idx").on(t.expiresAt),
    index("ai_request_states_tenant_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertAiRequestStateSchema = createInsertSchema(aiRequestStates).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiRequestState = z.infer<typeof insertAiRequestStateSchema>;
export type AiRequestState = typeof aiRequestStates.$inferSelect;

// ─── AI Request State Events ──────────────────────────────────────────────────
// Append-only observability log for idempotency lifecycle events.
// Provides admin/debug traceability without blocking the hot path.
//
// Event types:
//   "request_started"      — new execution ownership acquired
//   "duplicate_inflight"   — duplicate arrived while first still executing
//   "duplicate_replayed"   — completed result replayed to duplicate request
//   "request_completed"    — execution finished successfully
//   "request_failed"       — execution finished with error

export const aiRequestStateEvents = pgTable(
  "ai_request_state_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** HTTP request ID — ties this event back to its origin request */
    requestId: text("request_id").notNull(),
    /**
     * What happened at the idempotency layer.
     * "request_started"    — new ownership acquired, proceeding with execution
     * "duplicate_inflight" — duplicate arrived, first request still running
     * "duplicate_replayed" — duplicate served stored completed result
     * "request_completed"  — first execution completed and stored result
     * "request_failed"     — first execution failed; retry allowed
     */
    eventType: text("event_type").notNull(),
    routeKey: text("route_key"),
    provider: text("provider"),
    model: text("model"),
    /** Human-readable context for debugging */
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_request_state_events_tenant_idx").on(t.tenantId),
    index("ai_request_state_events_request_idx").on(t.requestId),
    index("ai_request_state_events_event_type_idx").on(t.eventType),
    index("ai_request_state_events_created_at_idx").on(t.createdAt),
  ],
);

export const insertAiRequestStateEventSchema = createInsertSchema(aiRequestStateEvents).omit({ id: true, createdAt: true });
export type InsertAiRequestStateEvent = z.infer<typeof insertAiRequestStateEventSchema>;
export type AiRequestStateEvent = typeof aiRequestStateEvents.$inferSelect;

// Legacy types kept for compatibility
export const users = profiles;
export const insertUserSchema = createInsertSchema(profiles).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof profiles.$inferSelect;
