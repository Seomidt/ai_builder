/**
 * Supabase / Postgres Schema — AI Builder Platform
 *
 * ─── RLS Security Posture (Phase 4E.1 hardening) ─────────────────────────────
 *
 * ALL 45 tables in the public schema have Row Level Security (RLS) ENABLED.
 * RLS policies are applied directly in Postgres (not via Drizzle — unsupported).
 *
 * CLASSIFICATION:
 *
 * Client-facing tables (RLS ON + SELECT policies via auth.uid()):
 *   profiles              — own profile only (SELECT/INSERT/UPDATE: auth.uid() = id)
 *   organizations         — orgs user is a member of
 *   organization_members  — memberships in user's orgs
 *   projects              — projects in user's orgs
 *   integrations          — integrations in user's orgs
 *   knowledge_documents   — documents in user's orgs
 *   ai_runs               — AI runs in user's orgs (via organization_id)
 *   ai_steps              — steps for runs user can see
 *   ai_artifacts          — artifacts for runs user can see
 *   ai_tool_calls         — tool calls for runs user can see
 *   ai_approvals          — approvals for runs user can see
 *   artifact_dependencies — dependencies in user's orgs
 *
 * Backend/internal-only tables (RLS ON, NO client policies):
 *   All other tables — PostgREST access blocked. Backend Drizzle ORM connects
 *   directly to Postgres via service connection (bypasses RLS). Includes:
 *   ai_usage, ai_billing_usage, tenant_credit_accounts, tenant_credit_ledger,
 *   billing_periods, billing_period_tenant_snapshots, billing_audit_runs,
 *   billing_audit_findings, ai_request_states, ai_request_state_events,
 *   ai_anomaly_*, ai_provider_reconciliation_*, ai_response_cache, ai_cache_events,
 *   ai_customer_pricing_configs, ai_model_pricing, ai_model_overrides,
 *   ai_request_step_*, architecture_*, organization_secrets, tenant_rate_limits,
 *   tenant_ai_usage_periods, request_safety_events, usage_threshold_events,
 *   ai_usage_limits.
 *
 * WHY TABLES STAY IN public SCHEMA:
 *   Drizzle ORM does not support non-public schemas without significant refactoring
 *   of all query files. RLS achieves the same PostgREST blocking goal with zero
 *   risk to the existing backend architecture.
 *
 * FUNCTION HARDENING:
 *   prevent_billing_snapshot_mutation() — SET search_path = public (hardened)
 *
 * EXTENSION NOTE:
 *   btree_gist is installed in public schema (Supabase managed). Moving it to
 *   extensions schema is not safe — it would invalidate the billing_periods_no_overlap
 *   exclusion constraint. Acceptable in managed Supabase environment.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  integer,
  bigint,
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

// ─── AI Anomaly Configs ───────────────────────────────────────────────────────
// Admin-configured thresholds for cost/token/rate anomaly detection.
// Two scopes:
//   "global"  — applies to all tenants unless a tenant-specific row overrides it
//   "tenant"  — per-tenant override; takes precedence over global row
//
// Only one active row per scope (enforced via partial unique indexes).
// Detection is purely observational — no runtime blocking in this phase.

export const aiAnomalyConfigs = pgTable(
  "ai_anomaly_configs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null for global scope; set for tenant scope */
    tenantId: text("tenant_id"),
    /** "global" | "tenant" */
    scope: text("scope").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /** Max estimated_cost_usd per single request before anomaly event is fired */
    maxCostPerRequestUsd: numeric("max_cost_per_request_usd", { precision: 14, scale: 8 }),
    /** Max total_tokens per single request */
    maxTotalTokensPerRequest: integer("max_total_tokens_per_request"),
    /** Max output/completion tokens per single request */
    maxOutputTokensPerRequest: integer("max_output_tokens_per_request"),
    /** Max successful requests in any rolling 5-minute window */
    maxRequestsPer5m: integer("max_requests_per_5m"),
    /** Max estimated_cost_usd in any rolling 5-minute window */
    maxCostPer5mUsd: numeric("max_cost_per_5m_usd", { precision: 14, scale: 8 }),
    /** Max successful requests in any rolling 1-hour window */
    maxRequestsPer1h: integer("max_requests_per_1h"),
    /** Max estimated_cost_usd in any rolling 1-hour window */
    maxCostPer1hUsd: numeric("max_cost_per_1h_usd", { precision: 14, scale: 8 }),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("ai_anomaly_configs_scope_check", sql`scope IN ('global','tenant')`),
    // One active global config row at most
    uniqueIndex("ai_anomaly_configs_active_global_idx")
      .on(t.scope)
      .where(sql`scope = 'global' AND is_active = true`),
    // One active tenant config row per tenant_id at most
    uniqueIndex("ai_anomaly_configs_active_tenant_idx")
      .on(t.tenantId)
      .where(sql`scope = 'tenant' AND is_active = true`),
    index("ai_anomaly_configs_tenant_idx").on(t.tenantId),
    index("ai_anomaly_configs_active_idx").on(t.isActive),
  ],
);

export const insertAiAnomalyConfigSchema = createInsertSchema(aiAnomalyConfigs).omit({ id: true, createdAt: true });
export type InsertAiAnomalyConfig = z.infer<typeof insertAiAnomalyConfigSchema>;
export type AiAnomalyConfig = typeof aiAnomalyConfigs.$inferSelect;

// ─── AI Anomaly Events ────────────────────────────────────────────────────────
// Append-only log of detected cost/token/rate anomaly signals.
// Linked to specific request context when available.
// Events are admin/debug signals only — no auto-blocking in this phase.
//
// event_type values:
//   "cost_per_request_exceeded"        — single request cost above threshold
//   "tokens_per_request_exceeded"      — single request total tokens above threshold
//   "output_tokens_per_request_exceeded" — single request output tokens above threshold
//   "requests_per_5m_exceeded"         — rolling 5m request count above threshold
//   "cost_per_5m_exceeded"             — rolling 5m cost above threshold
//   "requests_per_1h_exceeded"         — rolling 1h request count above threshold
//   "cost_per_1h_exceeded"             — rolling 1h cost above threshold

export const aiAnomalyEvents = pgTable(
  "ai_anomaly_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    /** HTTP request ID — ties this event back to its origin request (null for window events) */
    requestId: text("request_id"),
    /** Feature/agent key that triggered the call */
    feature: text("feature"),
    /** Logical route key used for the call */
    routeKey: text("route_key"),
    /** Resolved provider at time of event */
    provider: text("provider"),
    /** Resolved model at time of event */
    model: text("model"),
    /** Anomaly signal type — see table comment for allowed values */
    eventType: text("event_type").notNull(),
    /** Observed metric value that triggered the anomaly */
    observedValue: numeric("observed_value", { precision: 14, scale: 8 }),
    /** Configured threshold that was exceeded */
    thresholdValue: numeric("threshold_value", { precision: 14, scale: 8 }),
    /** Start of the window for window-based anomalies (null for per-request) */
    periodStart: timestamp("period_start"),
    /** End of the window for window-based anomalies (null for per-request) */
    periodEnd: timestamp("period_end"),
    /**
     * Deduplication key used for cooldown suppression.
     * Format: "<tenantId>:<eventType>[:<routeKey>][:<model>]"
     */
    cooldownKey: text("cooldown_key"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_anomaly_events_tenant_idx").on(t.tenantId),
    index("ai_anomaly_events_event_type_idx").on(t.eventType),
    index("ai_anomaly_events_created_at_idx").on(t.createdAt),
    index("ai_anomaly_events_request_idx").on(t.requestId),
    index("ai_anomaly_events_tenant_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertAiAnomalyEventSchema = createInsertSchema(aiAnomalyEvents).omit({ id: true, createdAt: true });
export type InsertAiAnomalyEvent = z.infer<typeof insertAiAnomalyEventSchema>;
export type AiAnomalyEvent = typeof aiAnomalyEvents.$inferSelect;

// ─── AI Request Step States ───────────────────────────────────────────────────
// Per-request AI step budget tracking.
// One row per (tenant_id, request_id) — enforces max AI calls per logical request.
//
// Status lifecycle:
//   "active"    — request is executing, steps remaining
//   "exhausted" — step limit reached; further AI calls are blocked
//   "completed" — all AI steps finished normally
//
// Retention: expires_at aligned with idempotency retention (24h).

export const aiRequestStepStates = pgTable(
  "ai_request_step_states",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    requestId: text("request_id").notNull(),
    /** Running count of AI provider calls attempted under this request */
    totalAiCalls: integer("total_ai_calls").notNull().default(0),
    /** Configured maximum AI calls allowed for this request */
    maxAiCalls: integer("max_ai_calls").notNull(),
    /** "active" | "exhausted" | "completed" */
    status: text("status").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /** Absolute expiry — rows past this time can be purged */
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("ai_request_step_states_tenant_request_idx").on(t.tenantId, t.requestId),
    index("ai_request_step_states_tenant_idx").on(t.tenantId),
    index("ai_request_step_states_expires_idx").on(t.expiresAt),
    index("ai_request_step_states_status_idx").on(t.status),
  ],
);

export const insertAiRequestStepStateSchema = createInsertSchema(aiRequestStepStates).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiRequestStepState = z.infer<typeof insertAiRequestStepStateSchema>;
export type AiRequestStepState = typeof aiRequestStepStates.$inferSelect;

// ─── AI Customer Pricing Configs ─────────────────────────────────────────────
// Admin-configured customer-facing pricing for AI usage.
// Determines how provider_cost_usd is marked up to produce customer_price_usd.
//
// Two scopes:
//   "global"  — fallback for all tenants that have no tenant-specific config
//   "tenant"  — per-tenant override; takes precedence over global row
//
// Only one active row per scope (enforced via partial unique indexes).
// Pricing changes never mutate past ai_billing_usage rows — billing is immutable.
//
// Supported pricing modes:
//   "cost_plus_multiplier" — customer_price = max(min_charge, provider_cost × multiplier)
//   "fixed_markup"         — customer_price = max(min_charge, provider_cost + fixed_markup)
//   "per_1k_tokens"        — customer_price = (input/1000 × rate) + (output/1000 × rate)

export const aiCustomerPricingConfigs = pgTable(
  "ai_customer_pricing_configs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null for global scope; tenant/org id for tenant scope */
    tenantId: text("tenant_id"),
    /** "global" | "tenant" */
    scope: text("scope").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * How customer price is computed from provider cost.
     * "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens"
     */
    pricingMode: text("pricing_mode").notNull(),
    /** Used by cost_plus_multiplier: customer = provider_cost × multiplier */
    multiplier: numeric("multiplier", { precision: 12, scale: 4 }),
    /** Used by fixed_markup: customer = provider_cost + fixed_markup_usd */
    fixedMarkupUsd: numeric("fixed_markup_usd", { precision: 14, scale: 8 }),
    /** Used by per_1k_tokens: price per 1,000 input tokens */
    pricePer1kInputTokensUsd: numeric("price_per_1k_input_tokens_usd", { precision: 14, scale: 8 }),
    /** Used by per_1k_tokens: price per 1,000 output tokens */
    pricePer1kOutputTokensUsd: numeric("price_per_1k_output_tokens_usd", { precision: 14, scale: 8 }),
    /** Optional floor: customer_price is always >= minimum_charge_usd */
    minimumChargeUsd: numeric("minimum_charge_usd", { precision: 14, scale: 8 }),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("ai_customer_pricing_configs_scope_check", sql`scope IN ('global','tenant')`),
    check(
      "ai_customer_pricing_configs_mode_check",
      sql`pricing_mode IN ('cost_plus_multiplier','fixed_markup','per_1k_tokens')`,
    ),
    // One active global config row at most
    uniqueIndex("ai_customer_pricing_configs_active_global_idx")
      .on(t.scope)
      .where(sql`scope = 'global' AND is_active = true`),
    // One active tenant config row per tenant_id at most
    uniqueIndex("ai_customer_pricing_configs_active_tenant_idx")
      .on(t.tenantId)
      .where(sql`scope = 'tenant' AND is_active = true`),
    index("ai_customer_pricing_configs_tenant_idx").on(t.tenantId),
    index("ai_customer_pricing_configs_active_idx").on(t.isActive),
  ],
);

export const insertAiCustomerPricingConfigSchema = createInsertSchema(aiCustomerPricingConfigs).omit({
  id: true,
  createdAt: true,
});
export type InsertAiCustomerPricingConfig = z.infer<typeof insertAiCustomerPricingConfigSchema>;
export type AiCustomerPricingConfig = typeof aiCustomerPricingConfigs.$inferSelect;

// ─── AI Billing Usage Ledger ──────────────────────────────────────────────────
// Immutable billing ledger — one row per successful ai_usage row.
// Records both provider cost and customer price at the moment of billing.
//
// Design rules:
//   - One billing row per ai_usage row max (UNIQUE on usage_id)
//   - Rows are never updated — pricing changes do not mutate past rows
//   - Only created after a confirmed successful ai_usage insert
//   - Blocked, error, cache-hit, and replay rows never create billing rows
//   - margin_usd = customer_price_usd - provider_cost_usd (may be 0)
//   - pricing_source records config resolution path for audit

export const aiBillingUsage = pgTable(
  "ai_billing_usage",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Tenant that owns this billing row */
    tenantId: text("tenant_id").notNull(),
    /** Foreign key to ai_usage.id — one billing row per usage row */
    usageId: text("usage_id").notNull(),
    /** HTTP request ID for tracing */
    requestId: text("request_id"),
    /** Feature or agent key that made the AI call */
    feature: text("feature"),
    /** Logical route key */
    routeKey: text("route_key"),
    /** AI provider key */
    provider: text("provider"),
    /** Concrete model identifier */
    model: text("model"),
    /** Input tokens used as billable basis */
    inputTokensBillable: integer("input_tokens_billable").notNull().default(0),
    /** Output tokens used as billable basis */
    outputTokensBillable: integer("output_tokens_billable").notNull().default(0),
    /** Total tokens used as billable basis */
    totalTokensBillable: integer("total_tokens_billable").notNull().default(0),
    /** Provider cost at time of billing (from ai_usage.estimated_cost_usd) */
    providerCostUsd: numeric("provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Customer-facing price calculated from pricing config */
    customerPriceUsd: numeric("customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** margin_usd = customer_price_usd - provider_cost_usd */
    marginUsd: numeric("margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /**
     * How pricing was resolved for this billing row.
     * "tenant_config"  — active tenant-specific row from ai_customer_pricing_configs
     * "global_config"  — active global row from ai_customer_pricing_configs
     * "code_default"   — no DB config found; hardcoded fallback used
     */
    pricingSource: text("pricing_source").notNull(),
    /** Version: ai_customer_pricing_configs.id used, or null for code_default */
    pricingVersion: text("pricing_version"),
    /**
     * Phase 4H: resolved provider_pricing_versions.id at billing time.
     * Null if no provider pricing version row existed for this provider/model.
     */
    providerPricingVersionId: text("provider_pricing_version_id"),
    /**
     * Phase 4H: resolved customer_pricing_versions.id at billing time.
     * Null if no customer pricing version row existed for this tenant/feature/provider.
     */
    customerPricingVersionId: text("customer_pricing_version_id"),
    /**
     * Pricing mode applied to compute this row.
     * "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens"
     */
    pricingMode: text("pricing_mode").notNull(),
    /**
     * Wallet downstream delivery status.
     *
     * Immutability note:
     *   Financial value columns (provider_cost_usd, customer_price_usd, margin_usd,
     *   pricing_mode, pricing_source, pricing_version, created_at, usage_id, tenant_id,
     *   feature, provider, model) are NEVER updated after insert.
     *
     *   ONLY these three wallet-delivery fields may be updated — they track downstream
     *   processing state, not billing value. They do not affect the canonical financial
     *   record; ai_billing_usage remains the source of truth.
     *
     * wallet_status values:
     *   "pending"  — row created; wallet debit not yet confirmed
     *   "debited"  — wallet debit row created successfully in tenant_credit_ledger
     *   "failed"   — wallet debit attempt failed; replayable via billing_usage_id
     */
    walletStatus: text("wallet_status").notNull().default("pending"),
    /** Error message if wallet debit failed — null on success */
    walletErrorMessage: text("wallet_error_message"),
    /** Timestamp when wallet debit was confirmed — null until debited */
    walletDebitedAt: timestamp("wallet_debited_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Core invariant: one billing row per ai_usage row
    uniqueIndex("ai_billing_usage_usage_id_idx").on(t.usageId),
    index("ai_billing_usage_tenant_idx").on(t.tenantId),
    index("ai_billing_usage_created_at_idx").on(t.createdAt),
    index("ai_billing_usage_request_id_idx").on(t.requestId),
    index("ai_billing_usage_feature_idx").on(t.feature),
    index("ai_billing_usage_route_key_idx").on(t.routeKey),
    check("ai_billing_usage_provider_cost_check", sql`provider_cost_usd >= 0`),
    check("ai_billing_usage_customer_price_check", sql`customer_price_usd >= 0`),
    check("ai_billing_usage_input_tokens_check", sql`input_tokens_billable >= 0`),
    check("ai_billing_usage_output_tokens_check", sql`output_tokens_billable >= 0`),
    check("ai_billing_usage_total_tokens_check", sql`total_tokens_billable >= 0`),
    check(
      "ai_billing_usage_wallet_status_check",
      sql`wallet_status IN ('pending','debited','failed')`,
    ),
    // Composite index for per-tenant billing range queries (billing summary, wallet queries)
    index("ai_billing_usage_tenant_created_idx").on(t.tenantId, t.createdAt),
    // Analytics indexes: per-feature and per-model cost breakdowns
    index("ai_billing_usage_tenant_feature_idx").on(t.tenantId, t.feature),
    index("ai_billing_usage_tenant_model_idx").on(t.tenantId, t.model),
    // Wallet replay queries: find pending/failed rows for a tenant sorted by time
    index("ai_billing_usage_tenant_wallet_status_idx").on(t.tenantId, t.walletStatus, t.createdAt),
  ],
);

export const insertAiBillingUsageSchema = createInsertSchema(aiBillingUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertAiBillingUsage = z.infer<typeof insertAiBillingUsageSchema>;
export type AiBillingUsage = typeof aiBillingUsage.$inferSelect;

// ─── AI Request Step Events ───────────────────────────────────────────────────
// Append-only observability log for step budget lifecycle events.
//
// event_type values:
//   "step_started"         — one AI provider call acquired and starting
//   "step_completed"       — AI provider call finished (success or error)
//   "step_budget_exceeded" — request attempted more calls than allowed

export const aiRequestStepEvents = pgTable(
  "ai_request_step_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    requestId: text("request_id").notNull(),
    /** "step_started" | "step_completed" | "step_budget_exceeded" */
    eventType: text("event_type").notNull(),
    /** Which step number this event belongs to (1-indexed) */
    stepNumber: integer("step_number"),
    routeKey: text("route_key"),
    feature: text("feature"),
    provider: text("provider"),
    model: text("model"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_request_step_events_tenant_idx").on(t.tenantId),
    index("ai_request_step_events_request_idx").on(t.requestId),
    index("ai_request_step_events_event_type_idx").on(t.eventType),
    index("ai_request_step_events_created_at_idx").on(t.createdAt),
  ],
);

export const insertAiRequestStepEventSchema = createInsertSchema(aiRequestStepEvents).omit({ id: true, createdAt: true });
export type InsertAiRequestStepEvent = z.infer<typeof insertAiRequestStepEventSchema>;
export type AiRequestStepEvent = typeof aiRequestStepEvents.$inferSelect;

// ─── Tenant Credit Accounts ───────────────────────────────────────────────────
// One wallet account per tenant.
// This table is account metadata only — NOT the source of truth for balance.
// Balance must be derived from tenant_credit_ledger rows.
//
// Kept minimal: no balance column. No balance stored here.
// Balance = SUM(credit ledger rows) - SUM(debit ledger rows).

export const tenantCreditAccounts = pgTable(
  "tenant_credit_accounts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Tenant that owns this account */
    tenantId: text("tenant_id").notNull(),
    /** Currency for this account — USD only for Phase 4B */
    currency: text("currency").notNull().default("USD"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Negative balance policy limits (Phase 4C).
     *
     * Both values are <= 0. Default 0 means no negative balance allowed.
     *
     * soft_limit_usd: warning threshold — available_balance may go this far below 0.
     *   Must be <= 0. Example: -5.00 means warn when balance is between -5 and 0.
     *
     * hard_limit_usd: enforcement boundary — if available_balance <= hard_limit_usd,
     *   future billable AI calls are blocked with AiWalletLimitError (402).
     *   Must be <= soft_limit_usd (stricter than soft limit).
     *   Default 0 means block immediately at zero balance.
     *
     * Check: soft_limit_usd <= 0
     * Check: hard_limit_usd <= soft_limit_usd
     */
    softLimitUsd: numeric("soft_limit_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    hardLimitUsd: numeric("hard_limit_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_credit_accounts_tenant_idx").on(t.tenantId),
    index("tenant_credit_accounts_active_idx").on(t.isActive),
    check("tenant_credit_accounts_soft_limit_check", sql`soft_limit_usd <= 0`),
    check("tenant_credit_accounts_hard_limit_check", sql`hard_limit_usd <= soft_limit_usd`),
  ],
);

export const insertTenantCreditAccountSchema = createInsertSchema(tenantCreditAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTenantCreditAccount = z.infer<typeof insertTenantCreditAccountSchema>;
export type TenantCreditAccount = typeof tenantCreditAccounts.$inferSelect;

// ─── Tenant Credit Ledger ─────────────────────────────────────────────────────
// Immutable ledger of all wallet events.
// This IS the source of truth for tenant credit balance.
//
// Ledger rules:
//   - Rows are NEVER updated or deleted during normal operation
//   - Balance = SUM(credits) - SUM(debits)
//   - Available balance excludes expired credits (expires_at < NOW())
//   - One debit row per ai_billing_usage row (enforced by partial unique index on billing_usage_id)
//   - Debits must always reference a billing_usage_id
//
// entry_type values:
//   "credit_grant"      — credits manually or automatically added to the account
//   "credit_debit"      — credits consumed by a billable AI call
//   "credit_expiration" — explicit expiration event (reduces balance when posted)
//   "credit_adjustment" — admin correction entry
//
// direction values:
//   "credit" — increases balance (grants, adjustments up)
//   "debit"  — decreases balance (AI usage, expirations)

export const tenantCreditLedger = pgTable(
  "tenant_credit_ledger",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Tenant that owns this ledger entry */
    tenantId: text("tenant_id").notNull(),
    /** FK to tenant_credit_accounts.id */
    accountId: text("account_id").notNull(),
    /**
     * "credit_grant" | "credit_debit" | "credit_expiration" | "credit_adjustment"
     */
    entryType: text("entry_type").notNull(),
    /** Amount in USD — always >= 0. Direction determines sign semantics. */
    amountUsd: numeric("amount_usd", { precision: 14, scale: 8 }).notNull(),
    /**
     * "credit" — increases balance
     * "debit"  — decreases balance
     */
    direction: text("direction").notNull(),
    /**
     * FK to ai_billing_usage.id — populated on credit_debit entries.
     * Partial unique index ensures one debit row per billing_usage_id.
     */
    billingUsageId: text("billing_usage_id"),
    /** Category of the reference that created this entry */
    referenceType: text("reference_type"),
    /** ID of the reference object (plan ID, promo code, etc.) */
    referenceId: text("reference_id"),
    /** HTTP request ID for tracing */
    requestId: text("request_id"),
    /**
     * When this credit expires (only relevant for credit_grant entries).
     * NULL = no expiration. expires_at < NOW() = excluded from available balance.
     */
    expiresAt: timestamp("expires_at"),
    description: text("description"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "tenant_credit_ledger_entry_type_check",
      sql`entry_type IN ('credit_grant','credit_debit','credit_expiration','credit_adjustment')`,
    ),
    check(
      "tenant_credit_ledger_direction_check",
      sql`direction IN ('credit','debit')`,
    ),
    check("tenant_credit_ledger_amount_check", sql`amount_usd >= 0`),
    // Core idempotency rule: one debit row per billing_usage_id
    uniqueIndex("tenant_credit_ledger_billing_debit_idx")
      .on(t.billingUsageId)
      .where(sql`entry_type = 'credit_debit' AND billing_usage_id IS NOT NULL`),
    index("tenant_credit_ledger_tenant_idx").on(t.tenantId),
    index("tenant_credit_ledger_account_idx").on(t.accountId),
    index("tenant_credit_ledger_created_at_idx").on(t.createdAt),
    index("tenant_credit_ledger_expires_at_idx").on(t.expiresAt),
    index("tenant_credit_ledger_billing_usage_idx").on(t.billingUsageId),
    index("tenant_credit_ledger_tenant_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertTenantCreditLedgerSchema = createInsertSchema(tenantCreditLedger).omit({
  id: true,
  createdAt: true,
});
export type InsertTenantCreditLedger = z.infer<typeof insertTenantCreditLedgerSchema>;
export type TenantCreditLedgerEntry = typeof tenantCreditLedger.$inferSelect;

// ─── Provider Reconciliation Runs ────────────────────────────────────────────
// Foundation for detecting discrepancies between internal billing records
// and provider invoices/usage reports.
//
// Phase 4C: foundation only — detection, not auto-correction.
// Reconciliation logic is manual/admin initiated. No auto-correction of billing rows.
//
// status values:
//   "started"   — run is in progress
//   "completed" — run finished successfully (deltas recorded)
//   "failed"    — run encountered an error

export const aiProviderReconciliationRuns = pgTable(
  "ai_provider_reconciliation_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Provider this run covers (e.g. "openai") */
    provider: text("provider").notNull(),
    /** Start of the reconciliation period */
    periodStart: timestamp("period_start").notNull(),
    /** End of the reconciliation period */
    periodEnd: timestamp("period_end").notNull(),
    /** "started" | "completed" | "failed" */
    status: text("status").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    check(
      "ai_recon_runs_status_check",
      sql`status IN ('started','completed','failed')`,
    ),
    // Query pattern: find runs by provider + time period
    index("ai_recon_runs_provider_period_idx").on(t.provider, t.periodStart, t.periodEnd),
    index("ai_recon_runs_status_idx").on(t.status),
  ],
);

export const insertAiProviderReconciliationRunSchema = createInsertSchema(aiProviderReconciliationRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertAiProviderReconciliationRun = z.infer<typeof insertAiProviderReconciliationRunSchema>;
export type AiProviderReconciliationRun = typeof aiProviderReconciliationRuns.$inferSelect;

// ─── Provider Reconciliation Deltas ──────────────────────────────────────────
// Individual discrepancy records within a reconciliation run.
// Each delta records one metric (cost, tokens, request count) where internal
// and external values differ.
//
// metric_type values:
//   "provider_cost_delta"   — cost discrepancy in USD
//   "request_count_delta"   — request count discrepancy
//   "input_tokens_delta"    — input token count discrepancy
//   "output_tokens_delta"   — output token count discrepancy
//   "total_tokens_delta"    — total token count discrepancy
//
// severity values:
//   "info"     — negligible delta, within expected rounding tolerance
//   "warning"  — notable delta, may require investigation
//   "critical" — significant delta, requires immediate review

export const aiProviderReconciliationDeltas = pgTable(
  "ai_provider_reconciliation_deltas",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK to ai_provider_reconciliation_runs.id */
    runId: text("run_id").notNull(),
    /** Tenant this delta relates to — null means aggregate/cross-tenant */
    tenantId: text("tenant_id"),
    /** Provider this delta relates to */
    provider: text("provider").notNull(),
    /** Model this delta relates to — null for aggregate */
    model: text("model"),
    /** Type of discrepancy */
    metricType: text("metric_type").notNull(),
    /** Value as recorded in our internal system */
    internalValue: numeric("internal_value", { precision: 14, scale: 8 }),
    /** Value as reported by provider invoice/API */
    externalValue: numeric("external_value", { precision: 14, scale: 8 }),
    /** external_value - internal_value (positive = we under-counted) */
    deltaValue: numeric("delta_value", { precision: 14, scale: 8 }),
    /** "info" | "warning" | "critical" */
    severity: text("severity").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ai_recon_deltas_metric_type_check",
      sql`metric_type IN ('provider_cost_delta','request_count_delta','input_tokens_delta','output_tokens_delta','total_tokens_delta')`,
    ),
    check(
      "ai_recon_deltas_severity_check",
      sql`severity IN ('info','warning','critical')`,
    ),
    index("ai_recon_deltas_run_idx").on(t.runId),
    index("ai_recon_deltas_provider_idx").on(t.provider),
    index("ai_recon_deltas_tenant_idx").on(t.tenantId),
    index("ai_recon_deltas_severity_idx").on(t.severity),
    index("ai_recon_deltas_created_at_idx").on(t.createdAt),
  ],
);

export const insertAiProviderReconciliationDeltaSchema = createInsertSchema(aiProviderReconciliationDeltas).omit({
  id: true,
  createdAt: true,
});
export type InsertAiProviderReconciliationDelta = z.infer<typeof insertAiProviderReconciliationDeltaSchema>;
export type AiProviderReconciliationDelta = typeof aiProviderReconciliationDeltas.$inferSelect;

// ─── Billing Periods ──────────────────────────────────────────────────────────
//
// Represents a billing period (e.g. calendar month) in the platform.
//
// Lifecycle: open → closing → closed
//   open:    active period; new ai_billing_usage rows accrue here
//   closing: snapshot generation in progress; transitional state
//   closed:  fully closed; snapshots are canonical for this period
//
// Reporting rule:
//   open   → aggregate from live ai_billing_usage
//   closed → aggregate from billing_period_tenant_snapshots
//
// Phase 5: foundation only. No cron/scheduler. Manual close via closeBillingPeriod().
// Exactly one open period is the operational norm, but this is not DB-enforced —
// the application layer is responsible for this invariant.

export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Period window — inclusive start, exclusive end */
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    /** 'open' | 'closing' | 'closed' */
    status: text("status").notNull().default("open"),
    /** Set when status transitions to 'closed' */
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "billing_periods_start_before_end_check",
      sql`period_start < period_end`,
    ),
    check(
      "billing_periods_status_check",
      sql`status IN ('open','closing','closed')`,
    ),
    uniqueIndex("billing_periods_start_end_unique").on(t.periodStart, t.periodEnd),
    index("billing_periods_status_idx").on(t.status),
    // Composite index: fast lookup on (period_start, period_end) for boundary queries
    index("billing_periods_start_end_idx").on(t.periodStart, t.periodEnd),
  ],
);

export const insertBillingPeriodSchema = createInsertSchema(billingPeriods).omit({
  id: true,
  createdAt: true,
  closedAt: true,
});
export type InsertBillingPeriod = z.infer<typeof insertBillingPeriodSchema>;
export type BillingPeriod = typeof billingPeriods.$inferSelect;

// ─── Billing Period Tenant Snapshots ─────────────────────────────────────────
//
// Immutable per-tenant summary records derived from ai_billing_usage for a
// closed billing period. One row per (billing_period_id, tenant_id).
//
// These are REPORTING ARTIFACTS only:
//   - Source of truth for reporting on closed periods
//   - Never mutated after creation
//   - Generated by closeBillingPeriod() as part of the period close flow
//
// Financial amounts come from ai_billing_usage (canonical).
// debited_amount_usd reflects successful wallet debits (wallet_status='debited').
//
// Period inclusion rule (consistent with snapshot generation):
//   ai_billing_usage.created_at >= period_start AND < period_end
//
// Only tenants with actual usage in the period receive a snapshot row.
// Tenants with zero usage are excluded to avoid zero-value padding.

export const billingPeriodTenantSnapshots = pgTable(
  "billing_period_tenant_snapshots",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK to billing_periods.id */
    billingPeriodId: text("billing_period_id").notNull(),
    /** Tenant this snapshot belongs to */
    tenantId: text("tenant_id").notNull(),
    /** Sum of provider_cost_usd from ai_billing_usage in period */
    providerCostUsd: numeric("provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of customer_price_usd from ai_billing_usage in period */
    customerPriceUsd: numeric("customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of margin_usd from ai_billing_usage in period */
    marginUsd: numeric("margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Count of ai_billing_usage rows in period */
    requestCount: integer("request_count").notNull().default(0),
    /** Sum of customer_price_usd where wallet_status='debited' — successful wallet debits */
    debitedAmountUsd: numeric("debited_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    // ─── Phase 4K: Storage billing totals (added to existing snapshot row) ─────
    /** Sum of storage_billing_usage.customer_price_usd in period (Phase 4K) */
    storageCustomerPriceUsd: numeric("storage_customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of storage_billing_usage.provider_cost_usd in period (Phase 4K) */
    storageProviderCostUsd: numeric("storage_provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of storage margin in period (Phase 4K) */
    storageMarginUsd: numeric("storage_margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of storage_billing_usage.billable_usage_amount in period (Phase 4K) */
    storageBillableUsage: numeric("storage_billable_usage", { precision: 18, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Uniqueness: exactly one snapshot per (period, tenant) — idempotency guarantee
    uniqueIndex("billing_period_snapshots_period_tenant_unique").on(t.billingPeriodId, t.tenantId),
    // Non-negative financial value constraints
    check(
      "billing_period_snapshots_provider_cost_check",
      sql`provider_cost_usd >= 0`,
    ),
    check(
      "billing_period_snapshots_customer_price_check",
      sql`customer_price_usd >= 0`,
    ),
    check(
      "billing_period_snapshots_margin_check",
      sql`margin_usd >= 0`,
    ),
    check(
      "billing_period_snapshots_request_count_check",
      sql`request_count >= 0`,
    ),
    check(
      "billing_period_snapshots_debited_amount_check",
      sql`debited_amount_usd >= 0`,
    ),
    // Query indexes
    index("billing_period_snapshots_period_idx").on(t.billingPeriodId),
    index("billing_period_snapshots_tenant_idx").on(t.tenantId),
  ],
);

export const insertBillingPeriodTenantSnapshotSchema = createInsertSchema(billingPeriodTenantSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingPeriodTenantSnapshot = z.infer<typeof insertBillingPeriodTenantSnapshotSchema>;
export type BillingPeriodTenantSnapshot = typeof billingPeriodTenantSnapshots.$inferSelect;

// ─── Phase 4E: Billing Audit & Reconciliation ─────────────────────────────────

/**
 * billing_audit_runs
 *
 * Execution metadata for each billing audit pass.
 * One row per audit run — created at start, updated at completion/failure.
 *
 * audit_type values:
 *   'usage_billing_consistency'   — ai_usage ↔ ai_billing_usage
 *   'billing_wallet_consistency'  — ai_billing_usage ↔ tenant_credit_ledger
 *   'period_snapshot_consistency' — closed period snapshot ↔ live aggregation
 *   'full_billing_audit'          — all checks in sequence
 */
export const billingAuditRuns = pgTable(
  "billing_audit_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Type of audit executed */
    auditType: text("audit_type").notNull(),
    /**
     * Lifecycle status of this run.
     * 'started'   — running
     * 'completed' — finished; check findings for results
     * 'failed'    — audit itself failed (infra error, not billing error)
     */
    status: text("status").notNull().default("started"),
    /** Optional: billing period scoped to this run (for period_snapshot_consistency) */
    periodId: text("period_id"),
    /** Optional human-readable notes (set on completion/failure) */
    notes: text("notes"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "billing_audit_runs_status_check",
      sql`status IN ('started','completed','failed')`,
    ),
    index("billing_audit_runs_type_started_idx").on(t.auditType, t.startedAt),
    index("billing_audit_runs_status_started_idx").on(t.status, t.startedAt),
    index("billing_audit_runs_period_idx").on(t.periodId),
  ],
);

export const insertBillingAuditRunSchema = createInsertSchema(billingAuditRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingAuditRun = z.infer<typeof insertBillingAuditRunSchema>;
export type BillingAuditRun = typeof billingAuditRuns.$inferSelect;

/**
 * billing_audit_findings
 *
 * Immutable audit findings — one row per detected inconsistency.
 * Never updated or deleted. Designed for incident investigation and future admin tooling.
 *
 * finding_type values:
 *   'missing_billing_row'       — ai_usage row has no corresponding ai_billing_usage row
 *   'orphan_billing_row'        — ai_billing_usage row has no matching ai_usage row
 *   'missing_wallet_debit'      — billing row with wallet_status='debited' but no ledger debit
 *   'orphan_wallet_debit'       — ledger debit row references nonexistent billing_usage_id
 *   'wallet_amount_mismatch'    — ledger debit amount differs from customer_price_usd
 *   'duplicate_wallet_debit'    — more than one effective debit row for same billing_usage_id
 *   'snapshot_total_mismatch'   — snapshot total differs from live aggregation
 *   'request_count_mismatch'    — snapshot request_count differs from live count
 *   'negative_margin_detected'  — margin_usd < 0
 *   'invalid_pricing_result'    — arithmetic inconsistency in pricing columns
 *   'period_total_mismatch'     — period grand total mismatch (provider_cost or customer_price)
 *   'missing_snapshot_row'      — closed period has active tenant with no snapshot row
 *   'orphan_snapshot_row'       — snapshot row exists for tenant with no activity in period
 *   'tenant_mismatch'           — tenant_id inconsistency between related rows
 *
 * severity values (see AUDIT_SEVERITY_POLICY):
 *   'critical' — revenue loss, silent data corruption, or invoice integrity risk
 *   'warning'  — anomaly worth investigating; not immediately harmful
 *   'info'     — benign note; bookkeeping or metadata discrepancy
 *
 * entity_type values:
 *   'ai_usage' | 'ai_billing_usage' | 'tenant_credit_ledger'
 *   'billing_period' | 'billing_period_tenant_snapshot' | 'tenant' | 'system'
 */
export const billingAuditFindings = pgTable(
  "billing_audit_findings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK to billing_audit_runs.id */
    runId: text("run_id").notNull(),
    /** Tenant this finding belongs to — null for system-level findings */
    tenantId: text("tenant_id"),
    /** Billing period ID if finding is period-scoped */
    periodId: text("period_id"),
    /** Specific type of inconsistency detected */
    findingType: text("finding_type").notNull(),
    /** Severity tier — see AUDIT_SEVERITY_POLICY in billing-audit.ts */
    severity: text("severity").notNull(),
    /** Category of the primary entity this finding concerns */
    entityType: text("entity_type").notNull(),
    /** ID of the primary entity (usage_id, billing_usage_id, ledger_id, etc.) */
    entityId: text("entity_id"),
    /** Expected value (from canonical source) — null for count-based findings */
    expectedValue: numeric("expected_value", { precision: 14, scale: 8 }),
    /** Actual value found — null for count-based findings */
    actualValue: numeric("actual_value", { precision: 14, scale: 8 }),
    /** delta = actual - expected — null if not numeric */
    deltaValue: numeric("delta_value", { precision: 14, scale: 8 }),
    /** Structured forensic context — IDs, boundaries, relevant values for diagnosis */
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "billing_audit_findings_severity_check",
      sql`severity IN ('info','warning','critical')`,
    ),
    index("billing_audit_findings_run_idx").on(t.runId),
    index("billing_audit_findings_tenant_idx").on(t.tenantId),
    index("billing_audit_findings_period_idx").on(t.periodId),
    index("billing_audit_findings_type_idx").on(t.findingType),
    index("billing_audit_findings_severity_created_idx").on(t.severity, t.createdAt),
    index("billing_audit_findings_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const insertBillingAuditFindingSchema = createInsertSchema(billingAuditFindings).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingAuditFinding = z.infer<typeof insertBillingAuditFindingSchema>;
export type BillingAuditFinding = typeof billingAuditFindings.$inferSelect;

// ─── Phase 4F: Billing Event Log ──────────────────────────────────────────────

/**
 * billing_events — immutable monetization event timeline.
 *
 * Append-only. Rows are never updated or deleted (within retention window).
 * Not the billing source of truth — canonical truth remains ai_billing_usage.
 *
 * Event type vocabulary (see BILLING_EVENT_TYPES in billing-events.ts):
 *   request_started        — idempotency ownership acquired
 *   provider_call_started  — provider call about to execute
 *   usage_recorded         — ai_usage row created
 *   billing_usage_created  — ai_billing_usage row created
 *   wallet_debit_attempted — wallet debit write started
 *   wallet_debit_succeeded — wallet debit committed
 *   wallet_debit_failed    — wallet debit failed (billing row intact)
 *   request_completed      — request finished successfully
 *   request_replayed       — idempotency/cache replay returned existing result
 *   cache_hit_replayed     — cache hit returned without provider call
 *   wallet_replay_attempted — wallet replay worker attempted a missed debit
 *
 * Failure policy: event writes are best-effort (fire-and-forget).
 * A billing event write failure must never break ai_usage, ai_billing_usage,
 * or tenant_credit_ledger writes.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    requestId: text("request_id"),
    usageId: text("usage_id"),
    billingUsageId: text("billing_usage_id"),
    walletLedgerId: text("wallet_ledger_id"),
    status: text("status").notNull().default("recorded"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("billing_events_status_check", sql`${t.status} IN ('recorded')`),
    index("billing_events_tenant_created_at_idx").on(t.tenantId, t.createdAt),
    index("billing_events_event_type_created_at_idx").on(t.eventType, t.createdAt),
    index("billing_events_request_id_idx").on(t.requestId),
    index("billing_events_usage_id_idx").on(t.usageId),
    index("billing_events_billing_usage_id_idx").on(t.billingUsageId),
    index("billing_events_wallet_ledger_id_idx").on(t.walletLedgerId),
  ],
);

export const insertBillingEventSchema = createInsertSchema(billingEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingEvent = z.infer<typeof insertBillingEventSchema>;
export type BillingEvent = typeof billingEvents.$inferSelect;

// ─── Phase 4G: Provider Cost Reconciliation ────────────────────────────────────

/**
 * provider_usage_snapshots — externally supplied provider usage/cost totals.
 *
 * Inserted manually or via admin import. Represents provider-reported numbers
 * for a specific provider/model/period combination.
 * Used as the reference side in provider reconciliation runs.
 * Not the billing source of truth — diagnostic reference only.
 */
export const providerUsageSnapshots = pgTable(
  "provider_usage_snapshots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    model: text("model").notNull(),
    providerInputTokens: bigint("provider_input_tokens", { mode: "number" }).notNull().default(0),
    providerOutputTokens: bigint("provider_output_tokens", { mode: "number" }).notNull().default(0),
    providerTotalTokens: bigint("provider_total_tokens", { mode: "number" }).notNull().default(0),
    providerCostUsd: numeric("provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    invoiceReference: text("invoice_reference"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("provider_usage_snapshots_period_check", sql`${t.periodStart} < ${t.periodEnd}`),
    check("provider_usage_snapshots_input_tokens_check", sql`${t.providerInputTokens} >= 0`),
    check("provider_usage_snapshots_output_tokens_check", sql`${t.providerOutputTokens} >= 0`),
    check("provider_usage_snapshots_total_tokens_check", sql`${t.providerTotalTokens} >= 0`),
    check("provider_usage_snapshots_cost_check", sql`${t.providerCostUsd} >= 0`),
    index("provider_usage_snapshots_provider_period_idx").on(t.provider, t.periodStart, t.periodEnd),
    index("provider_usage_snapshots_model_idx").on(t.model),
  ],
);

export const insertProviderUsageSnapshotSchema = createInsertSchema(providerUsageSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertProviderUsageSnapshot = z.infer<typeof insertProviderUsageSnapshotSchema>;
export type ProviderUsageSnapshot = typeof providerUsageSnapshots.$inferSelect;

/**
 * provider_reconciliation_runs — tracks each reconciliation run execution.
 *
 * One run covers a specific provider + period window.
 * Stores aggregate diff totals and status. Findings are in
 * provider_reconciliation_findings (FK: reconciliation_run_id).
 */
export const providerReconciliationRuns = pgTable(
  "provider_reconciliation_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    status: text("status").notNull().default("running"),
    totalUsageRows: integer("total_usage_rows").notNull().default(0),
    totalBillingRows: integer("total_billing_rows").notNull().default(0),
    tokenDiff: bigint("token_diff", { mode: "number" }).notNull().default(0),
    costDiffUsd: numeric("cost_diff_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    check("provider_reconciliation_runs_period_check", sql`${t.periodStart} < ${t.periodEnd}`),
    check(
      "provider_reconciliation_runs_status_check",
      sql`${t.status} IN ('running','completed','failed')`,
    ),
    index("provider_reconciliation_runs_provider_period_idx").on(t.provider, t.periodStart, t.periodEnd),
    index("provider_reconciliation_runs_status_created_idx").on(t.status, t.createdAt),
  ],
);

export const insertProviderReconciliationRunSchema = createInsertSchema(providerReconciliationRuns).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});
export type InsertProviderReconciliationRun = z.infer<typeof insertProviderReconciliationRunSchema>;
export type ProviderReconciliationRun = typeof providerReconciliationRuns.$inferSelect;

/**
 * provider_reconciliation_findings — persisted drift/mismatch records.
 *
 * Each finding represents one detected discrepancy in a reconciliation run.
 * Immutable — never updated or deleted except by retention cleanup.
 *
 * finding_type values:
 *   'missing_billing_row'   — ai_usage row exists but no ai_billing_usage
 *   'duplicate_billing_row' — multiple ai_billing_usage rows for same usage_id
 *   'token_mismatch'        — provider token totals differ from internal ai_usage totals
 *   'cost_mismatch'         — provider cost differs from internal ai_billing_usage totals
 *   'provider_drift'        — model/pricing-level discrepancy between provider and internal
 *
 * severity:
 *   'critical' — revenue loss or invoice integrity risk
 *   'warning'  — anomaly worth investigating
 *   'info'     — benign note or informational
 */
export const providerReconciliationFindings = pgTable(
  "provider_reconciliation_findings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    reconciliationRunId: text("reconciliation_run_id").notNull(),
    findingType: text("finding_type").notNull(),
    severity: text("severity").notNull().default("warning"),
    usageId: text("usage_id"),
    billingUsageId: text("billing_usage_id"),
    expectedTokens: bigint("expected_tokens", { mode: "number" }),
    actualTokens: bigint("actual_tokens", { mode: "number" }),
    expectedCostUsd: numeric("expected_cost_usd", { precision: 14, scale: 8 }),
    actualCostUsd: numeric("actual_cost_usd", { precision: 14, scale: 8 }),
    tenantId: text("tenant_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "provider_reconciliation_findings_severity_check",
      sql`${t.severity} IN ('info','warning','critical')`,
    ),
    index("provider_reconciliation_findings_run_idx").on(t.reconciliationRunId),
    index("provider_reconciliation_findings_type_idx").on(t.findingType),
    index("provider_reconciliation_findings_tenant_idx").on(t.tenantId),
    index("provider_reconciliation_findings_severity_created_idx").on(t.severity, t.createdAt),
  ],
);

export const insertProviderReconciliationFindingSchema = createInsertSchema(
  providerReconciliationFindings,
).omit({ id: true, createdAt: true });
export type InsertProviderReconciliationFinding = z.infer<
  typeof insertProviderReconciliationFindingSchema
>;
export type ProviderReconciliationFinding = typeof providerReconciliationFindings.$inferSelect;

// ─── Phase 4H: Pricing Versioning ────────────────────────────────────────────

/**
 * provider_pricing_versions — immutable historical provider cost prices.
 *
 * One row = one pricing regime for a provider/model combination.
 * effective_from/effective_to define non-overlapping windows.
 * Overlapping windows for the same provider+model are rejected by a DB
 * EXCLUDE constraint (btree_gist extension, applied via raw SQL migration).
 *
 * Immutability rule: rows used for historical billing must never be edited.
 * Future price changes must insert a new row with a new pricing_version and
 * updated effective_from — never mutate existing rows.
 */
export const providerPricingVersions = pgTable(
  "provider_pricing_versions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    inputTokenPriceUsd: numeric("input_token_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    outputTokenPriceUsd: numeric("output_token_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    cachedInputTokenPriceUsd: numeric("cached_input_token_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    reasoningTokenPriceUsd: numeric("reasoning_token_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ppv_input_price_check",
      sql`${t.inputTokenPriceUsd} >= 0`,
    ),
    check(
      "ppv_output_price_check",
      sql`${t.outputTokenPriceUsd} >= 0`,
    ),
    check(
      "ppv_cached_input_price_check",
      sql`${t.cachedInputTokenPriceUsd} >= 0`,
    ),
    check(
      "ppv_reasoning_price_check",
      sql`${t.reasoningTokenPriceUsd} >= 0`,
    ),
    check(
      "ppv_effective_range_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    index("ppv_provider_model_from_idx").on(t.provider, t.model, t.effectiveFrom),
    index("ppv_pricing_version_idx").on(t.pricingVersion),
    index("ppv_provider_model_to_idx").on(t.provider, t.model, t.effectiveTo),
  ],
);

export const insertProviderPricingVersionSchema = createInsertSchema(providerPricingVersions).omit({
  id: true,
  createdAt: true,
});
export type InsertProviderPricingVersion = z.infer<typeof insertProviderPricingVersionSchema>;
export type ProviderPricingVersion = typeof providerPricingVersions.$inferSelect;

/**
 * customer_pricing_versions — immutable historical customer pricing overrides.
 *
 * One row = one pricing regime for a tenant/feature/provider combination.
 * model is optional — null means "applies to all models for this provider".
 * effective_from/effective_to define non-overlapping windows.
 * Overlapping windows for the same scope are rejected by a DB EXCLUDE constraint.
 *
 * Immutability rule: same as provider_pricing_versions — append new rows,
 * never mutate rows that have been used for billing.
 */
export const customerPricingVersions = pgTable(
  "customer_pricing_versions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    pricingVersion: text("pricing_version").notNull(),
    pricingMode: text("pricing_mode").notNull(),
    pricingSource: text("pricing_source").notNull().default("tenant_config"),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    multiplier: numeric("multiplier", { precision: 14, scale: 8 }),
    flatMarkupUsd: numeric("flat_markup_usd", { precision: 14, scale: 8 }),
    perRequestMarkupUsd: numeric("per_request_markup_usd", { precision: 14, scale: 8 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "cpv_effective_range_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check(
      "cpv_multiplier_check",
      sql`${t.multiplier} IS NULL OR ${t.multiplier} >= 0`,
    ),
    check(
      "cpv_flat_markup_check",
      sql`${t.flatMarkupUsd} IS NULL OR ${t.flatMarkupUsd} >= 0`,
    ),
    check(
      "cpv_per_request_markup_check",
      sql`${t.perRequestMarkupUsd} IS NULL OR ${t.perRequestMarkupUsd} >= 0`,
    ),
    index("cpv_tenant_feature_provider_from_idx").on(t.tenantId, t.feature, t.provider, t.effectiveFrom),
    index("cpv_tenant_version_idx").on(t.tenantId, t.pricingVersion),
    index("cpv_tenant_feature_to_idx").on(t.tenantId, t.feature, t.effectiveTo),
  ],
);

export const insertCustomerPricingVersionSchema = createInsertSchema(customerPricingVersions).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomerPricingVersion = z.infer<typeof insertCustomerPricingVersionSchema>;
export type CustomerPricingVersion = typeof customerPricingVersions.$inferSelect;

// ─── Phase 4I: Cost & Margin Tracking ────────────────────────────────────────

/**
 * margin_tracking_runs — records execution of a margin aggregation pass.
 *
 * scope_type controls what was aggregated:
 *   'tenant'  — single tenant over a time window
 *   'period'  — a specific billing period (by period_id)
 *   'global'  — all tenants over a time window
 *
 * Financial totals here are aggregate summaries of the run — not canonical truth.
 * ai_billing_usage remains the canonical source for all billing values.
 */
export const marginTrackingRuns = pgTable(
  "margin_tracking_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    scopeType: text("scope_type").notNull(),
    periodId: text("period_id"),
    tenantId: text("tenant_id"),
    status: text("status").notNull().default("running"),
    totalBillingRows: integer("total_billing_rows").notNull().default(0),
    totalProviderCostUsd: numeric("total_provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    totalCustomerPriceUsd: numeric("total_customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    totalMarginUsd: numeric("total_margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    check(
      "mtr_status_check",
      sql`${t.status} IN ('running','completed','failed')`,
    ),
    check(
      "mtr_provider_cost_check",
      sql`${t.totalProviderCostUsd} >= 0`,
    ),
    check(
      "mtr_customer_price_check",
      sql`${t.totalCustomerPriceUsd} >= 0`,
    ),
    index("mtr_scope_created_idx").on(t.scopeType, t.createdAt),
    index("mtr_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("mtr_period_created_idx").on(t.periodId, t.createdAt),
  ],
);

export const insertMarginTrackingRunSchema = createInsertSchema(marginTrackingRuns).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});
export type InsertMarginTrackingRun = z.infer<typeof insertMarginTrackingRunSchema>;
export type MarginTrackingRun = typeof marginTrackingRuns.$inferSelect;

/**
 * margin_tracking_snapshots — aggregated margin breakdown rows per run.
 *
 * Each row represents the margin summary for a (tenant, feature, provider, model)
 * combination within a margin tracking run.
 *
 * Derived from ai_billing_usage — not canonical financial truth.
 * margin_pct is null when customer_price_usd = 0 (avoid divide-by-zero).
 *
 * FK: run_id → margin_tracking_runs.id (enforced in DB, text in Drizzle for consistency).
 */
export const marginTrackingSnapshots = pgTable(
  "margin_tracking_snapshots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    runId: text("run_id").notNull(),
    tenantId: text("tenant_id"),
    periodId: text("period_id"),
    feature: text("feature"),
    provider: text("provider"),
    model: text("model"),
    billingRowCount: integer("billing_row_count").notNull().default(0),
    providerCostUsd: numeric("provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    customerPriceUsd: numeric("customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    marginUsd: numeric("margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    marginPct: numeric("margin_pct", { precision: 10, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "mts_billing_row_count_check",
      sql`${t.billingRowCount} >= 0`,
    ),
    check(
      "mts_provider_cost_check",
      sql`${t.providerCostUsd} >= 0`,
    ),
    check(
      "mts_customer_price_check",
      sql`${t.customerPriceUsd} >= 0`,
    ),
    index("mts_run_id_idx").on(t.runId),
    index("mts_tenant_idx").on(t.tenantId),
    index("mts_period_idx").on(t.periodId),
    index("mts_feature_idx").on(t.feature),
    index("mts_provider_idx").on(t.provider),
    index("mts_model_idx").on(t.model),
    index("mts_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertMarginTrackingSnapshotSchema = createInsertSchema(marginTrackingSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertMarginTrackingSnapshot = z.infer<typeof insertMarginTrackingSnapshotSchema>;
export type MarginTrackingSnapshot = typeof marginTrackingSnapshots.$inferSelect;

// ─── Phase 4J: Invoice Generation System ─────────────────────────────────────

/**
 * invoices — immutable tenant invoice records generated from closed billing periods.
 *
 * Design rules:
 *   - One invoice per (tenant_id, billing_period_id) — enforced by UNIQUE constraint
 *   - Totals derived from billing_period_tenant_snapshots.customer_price_usd
 *   - Finalized invoices must not be mutated (service-level + DB enforcement)
 *   - invoice_number format: INV-{YYYYMM}-{TENANT8}-{PERIOD8}
 *     where YYYYMM = period start month, TENANT8 and PERIOD8 = first 8 chars of their IDs
 *
 * Status lifecycle: draft → finalized (terminal positive) | void (terminal negative)
 * Stripe sync: not in this phase.
 * Tax engine: not in this phase.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    billingPeriodId: text("billing_period_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull().default("USD"),
    subtotalUsd: numeric("subtotal_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    totalUsd: numeric("total_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    issuedAt: timestamp("issued_at"),
    finalizedAt: timestamp("finalized_at"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "invoices_status_check",
      sql`${t.status} IN ('draft','finalized','void')`,
    ),
    check(
      "invoices_subtotal_check",
      sql`${t.subtotalUsd} >= 0`,
    ),
    check(
      "invoices_total_check",
      sql`${t.totalUsd} >= 0`,
    ),
    uniqueIndex("invoices_invoice_number_unique").on(t.invoiceNumber),
    uniqueIndex("invoices_tenant_period_unique").on(t.tenantId, t.billingPeriodId),
    index("invoices_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("invoices_period_idx").on(t.billingPeriodId),
    index("invoices_status_created_idx").on(t.status, t.createdAt),
  ],
);

export const insertInvoiceSchema = createInsertSchema(invoices).omit({
  id: true,
  createdAt: true,
  finalizedAt: true,
  issuedAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoices.$inferSelect;

/**
 * invoice_line_items — summary line items belonging to an invoice.
 *
 * Design rules:
 *   - FK: invoice_id → invoices.id
 *   - Line items are summary-oriented — not one row per ai_billing_usage request
 *   - For finalized invoices, line items must not be mutated (service-level enforcement)
 *   - metadata jsonb may include source snapshot IDs and aggregate totals
 *
 * line_type:
 *   'ai_usage_summary'     — primary charge line (customer_price_usd)
 *   'wallet_debit_summary' — informational: debited_amount_usd
 *   'margin_summary'       — informational: margin_usd
 *   'adjustment'           — manual correction (future use)
 */
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    invoiceId: text("invoice_id").notNull(),
    lineType: text("line_type").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 8 }).notNull().default("1"),
    unitAmountUsd: numeric("unit_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    lineTotalUsd: numeric("line_total_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ili_line_type_check",
      sql`${t.lineType} IN ('ai_usage_summary','wallet_debit_summary','margin_summary','adjustment','storage_usage')`,
    ),
    check(
      "ili_quantity_check",
      sql`${t.quantity} >= 0`,
    ),
    check(
      "ili_unit_amount_check",
      sql`${t.unitAmountUsd} >= 0`,
    ),
    check(
      "ili_line_total_check",
      sql`${t.lineTotalUsd} >= 0`,
    ),
    index("ili_invoice_id_idx").on(t.invoiceId),
    index("ili_line_type_idx").on(t.lineType),
  ],
);

export const insertInvoiceLineItemSchema = createInsertSchema(invoiceLineItems).omit({
  id: true,
  createdAt: true,
});
export type InsertInvoiceLineItem = z.infer<typeof insertInvoiceLineItemSchema>;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;

// ─── Phase 4K: Storage Usage Billing ─────────────────────────────────────────

/**
 * storage_usage — canonical storage usage measurements per tenant.
 *
 * This is the primary source of raw usage data for storage billing.
 * Supports future Cloudflare R2 API import (source_type='imported_snapshot').
 *
 * metric_type values:
 *   'gb_stored'    — gigabytes stored (at-rest storage)
 *   'gb_egress'    — gigabytes egressed (data transfer)
 *   'class_a_ops'  — Class A operations (writes, lists)
 *   'class_b_ops'  — Class B operations (reads)
 */
export const storageUsage = pgTable(
  "storage_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    storageProvider: text("storage_provider").notNull().default("cloudflare"),
    storageProduct: text("storage_product").notNull().default("r2"),
    bucket: text("bucket"),
    metricType: text("metric_type").notNull(),
    usageAmount: numeric("usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    usageUnit: text("usage_unit").notNull(),
    usagePeriodStart: timestamp("usage_period_start").notNull(),
    usagePeriodEnd: timestamp("usage_period_end").notNull(),
    sourceType: text("source_type").notNull().default("manual_snapshot"),
    sourceReference: text("source_reference"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("su_usage_amount_check", sql`${t.usageAmount} >= 0`),
    check("su_period_check", sql`${t.usagePeriodEnd} > ${t.usagePeriodStart}`),
    check(
      "su_metric_type_check",
      sql`${t.metricType} IN ('gb_stored','gb_egress','class_a_ops','class_b_ops')`,
    ),
    check(
      "su_source_type_check",
      sql`${t.sourceType} IN ('manual_snapshot','imported_snapshot','system_measurement')`,
    ),
    index("su_tenant_period_idx").on(t.tenantId, t.usagePeriodStart, t.usagePeriodEnd),
    index("su_provider_product_idx").on(t.storageProvider, t.storageProduct),
    index("su_metric_type_idx").on(t.metricType),
    index("su_tenant_metric_period_idx").on(t.tenantId, t.metricType, t.usagePeriodStart),
  ],
);

export const insertStorageUsageSchema = createInsertSchema(storageUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertStorageUsage = z.infer<typeof insertStorageUsageSchema>;
export type StorageUsage = typeof storageUsage.$inferSelect;

/**
 * storage_pricing_versions — provider-side storage pricing basis per metric.
 *
 * Supports included/free usage threshold (included_usage).
 * Non-overlapping windows enforced in DB via btree_gist EXCLUDE constraint
 * on (storage_provider, storage_product, metric_type, tsrange).
 */
export const storagePricingVersions = pgTable(
  "storage_pricing_versions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    storageProvider: text("storage_provider").notNull().default("cloudflare"),
    storageProduct: text("storage_product").notNull().default("r2"),
    metricType: text("metric_type").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    includedUsage: numeric("included_usage", { precision: 18, scale: 8 }),
    unitPriceUsd: numeric("unit_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("spv_unit_price_check", sql`${t.unitPriceUsd} >= 0`),
    check(
      "spv_included_usage_check",
      sql`${t.includedUsage} IS NULL OR ${t.includedUsage} >= 0`,
    ),
    check(
      "spv_effective_window_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    index("spv_provider_product_metric_idx").on(
      t.storageProvider,
      t.storageProduct,
      t.metricType,
      t.effectiveFrom,
    ),
    index("spv_pricing_version_idx").on(t.pricingVersion),
  ],
);

export const insertStoragePricingVersionSchema = createInsertSchema(storagePricingVersions).omit({
  id: true,
  createdAt: true,
});
export type InsertStoragePricingVersion = z.infer<typeof insertStoragePricingVersionSchema>;
export type StoragePricingVersion = typeof storagePricingVersions.$inferSelect;

/**
 * customer_storage_pricing_versions — tenant-specific storage pricing.
 *
 * Allows per-tenant overrides for storage pricing (markup, custom tiers).
 * Non-overlapping windows enforced in DB via btree_gist EXCLUDE constraint
 * on (tenant_id, storage_provider, storage_product, metric_type, tsrange).
 */
export const customerStoragePricingVersions = pgTable(
  "customer_storage_pricing_versions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    storageProvider: text("storage_provider").notNull().default("cloudflare"),
    storageProduct: text("storage_product").notNull().default("r2"),
    metricType: text("metric_type").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    includedUsage: numeric("included_usage", { precision: 18, scale: 8 }),
    unitPriceUsd: numeric("unit_price_usd", { precision: 18, scale: 10 }).notNull().default("0"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("cspv_unit_price_check", sql`${t.unitPriceUsd} >= 0`),
    check(
      "cspv_included_usage_check",
      sql`${t.includedUsage} IS NULL OR ${t.includedUsage} >= 0`,
    ),
    check(
      "cspv_effective_window_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    index("cspv_tenant_provider_metric_idx").on(
      t.tenantId,
      t.storageProvider,
      t.storageProduct,
      t.metricType,
      t.effectiveFrom,
    ),
    index("cspv_tenant_version_idx").on(t.tenantId, t.pricingVersion),
  ],
);

export const insertCustomerStoragePricingVersionSchema = createInsertSchema(
  customerStoragePricingVersions,
).omit({ id: true, createdAt: true });
export type InsertCustomerStoragePricingVersion = z.infer<
  typeof insertCustomerStoragePricingVersionSchema
>;
export type CustomerStoragePricingVersion =
  typeof customerStoragePricingVersions.$inferSelect;

/**
 * storage_billing_usage — canonical storage billing ledger.
 *
 * One row per storage_usage row (UNIQUE on storage_usage_id).
 * Canonical storage billing truth — do not merge with ai_billing_usage.
 *
 * Derivation rules (from storage_usage + pricing versions):
 *   included_usage_amount = min(raw_usage_amount, included threshold)
 *   billable_usage_amount = max(raw_usage_amount - included_usage_amount, 0)
 *   provider_cost_usd     = billable_usage_amount × provider unit price
 *   customer_price_usd    = billable_usage_amount × customer unit price
 *   margin_usd            = customer_price_usd - provider_cost_usd
 */
export const storageBillingUsage = pgTable(
  "storage_billing_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    storageUsageId: text("storage_usage_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageProduct: text("storage_product").notNull(),
    metricType: text("metric_type").notNull(),
    providerPricingVersionId: text("provider_pricing_version_id"),
    customerPricingVersionId: text("customer_pricing_version_id"),
    rawUsageAmount: numeric("raw_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    includedUsageAmount: numeric("included_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    billableUsageAmount: numeric("billable_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    providerCostUsd: numeric("provider_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    customerPriceUsd: numeric("customer_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    marginUsd: numeric("margin_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    pricingVersion: text("pricing_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("sbu_raw_usage_check", sql`${t.rawUsageAmount} >= 0`),
    check("sbu_included_usage_check", sql`${t.includedUsageAmount} >= 0`),
    check("sbu_billable_usage_check", sql`${t.billableUsageAmount} >= 0`),
    check("sbu_provider_cost_check", sql`${t.providerCostUsd} >= 0`),
    check("sbu_customer_price_check", sql`${t.customerPriceUsd} >= 0`),
    uniqueIndex("sbu_storage_usage_id_unique").on(t.storageUsageId),
    index("sbu_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("sbu_metric_created_idx").on(t.metricType, t.createdAt),
    index("sbu_tenant_metric_created_idx").on(t.tenantId, t.metricType, t.createdAt),
  ],
);

export const insertStorageBillingUsageSchema = createInsertSchema(storageBillingUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertStorageBillingUsage = z.infer<typeof insertStorageBillingUsageSchema>;
export type StorageBillingUsage = typeof storageBillingUsage.$inferSelect;

// Legacy types kept for compatibility
export const users = profiles;
export const insertUserSchema = createInsertSchema(profiles).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof profiles.$inferSelect;
