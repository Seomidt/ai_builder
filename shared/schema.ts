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
  real,
  doublePrecision,
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

// ─── Phase 5A — Document Registry & Storage Foundation ──────────────────────
//
// Architecture rules (enforced at service layer):
//   • All tables are tenant-scoped — tenant_id is required everywhere
//   • knowledge_documents.current_version_id is NOT a FK (circular dependency with
//     knowledge_document_versions.knowledge_document_id). Invariant enforced by service layer.
//   • Chunks, embeddings, and index state are derived/rebuildable artifacts
//   • Original document identity and version history are canonical and immutable

// ─── knowledge_bases ─────────────────────────────────────────────────────────

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    visibility: text("visibility").notNull().default("private"),
    defaultRetrievalK: integer("default_retrieval_k"),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT kb_lifecycle_check CHECK (${t.lifecycleState} IN ('active','archived','deleted'))`,
    sql`CONSTRAINT kb_visibility_check CHECK (${t.visibility} IN ('private','internal'))`,
    uniqueIndex("kb_tenant_slug_unique").on(t.tenantId, t.slug),
    index("kb_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("kb_tenant_lifecycle_idx").on(t.tenantId, t.lifecycleState, t.createdAt),
  ],
);

export const insertKnowledgeBaseSchema = createInsertSchema(knowledgeBases).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeBase = z.infer<typeof insertKnowledgeBaseSchema>;
export type KnowledgeBase = typeof knowledgeBases.$inferSelect;

// ─── knowledge_documents ─────────────────────────────────────────────────────

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    externalReference: text("external_reference"),
    title: text("title").notNull(),
    documentType: text("document_type").notNull().default("other"),
    sourceType: text("source_type").notNull().default("upload"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    documentStatus: text("document_status").notNull().default("draft"),
    // NOTE: no FK here — circular dependency with knowledge_document_versions.
    // Invariant enforced at service layer: must reference a version from this document where is_current=true
    currentVersionId: varchar("current_version_id"),
    latestVersionNumber: integer("latest_version_number").notNull().default(0),
    tags: jsonb("tags"),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    sql`CONSTRAINT kd_lifecycle_check CHECK (${t.lifecycleState} IN ('active','archived','deleted'))`,
    sql`CONSTRAINT kd_status_check CHECK (${t.documentStatus} IN ('draft','processing','ready','failed','superseded'))`,
    sql`CONSTRAINT kd_version_number_check CHECK (${t.latestVersionNumber} >= 0)`,
    index("kd_tenant_kb_created_idx").on(t.tenantId, t.knowledgeBaseId, t.createdAt),
    index("kd_tenant_lifecycle_status_idx").on(t.tenantId, t.lifecycleState, t.documentStatus, t.createdAt),
    index("kd_tenant_kb_title_idx").on(t.tenantId, t.knowledgeBaseId, t.title),
  ],
);

export const insertKnowledgeDocumentSchema = createInsertSchema(knowledgeDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});
export type InsertKnowledgeDocument = z.infer<typeof insertKnowledgeDocumentSchema>;
export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;

// ─── knowledge_document_versions ─────────────────────────────────────────────

export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    versionNumber: integer("version_number").notNull(),
    sourceLabel: text("source_label"),
    versionStatus: text("version_status").notNull().default("pending"),
    isCurrent: boolean("is_current").notNull().default(false),
    contentChecksum: text("content_checksum"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    characterCount: integer("character_count"),
    pageCount: integer("page_count"),
    languageCode: text("language_code"),
    uploadedAt: timestamp("uploaded_at"),
    processingStartedAt: timestamp("processing_started_at"),
    processingCompletedAt: timestamp("processing_completed_at"),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    parserName: text("parser_name"),
    parserVersion: text("parser_version"),
    parseStatus: text("parse_status"),
    parseStartedAt: timestamp("parse_started_at"),
    parseCompletedAt: timestamp("parse_completed_at"),
    parsedTextChecksum: text("parsed_text_checksum"),
    normalizedCharacterCount: integer("normalized_character_count"),
    parseFailureReason: text("parse_failure_reason"),
    structuredSheetCount: integer("structured_sheet_count"),
    structuredRowCount: integer("structured_row_count"),
    structuredColumnCount: integer("structured_column_count"),
    structuredParseStatus: text("structured_parse_status"),
    structuredParseStartedAt: timestamp("structured_parse_started_at"),
    structuredParseCompletedAt: timestamp("structured_parse_completed_at"),
    structuredParseFailureReason: text("structured_parse_failure_reason"),
    structuredContentChecksum: text("structured_content_checksum"),
    ocrStatus: text("ocr_status"),
    ocrStartedAt: timestamp("ocr_started_at"),
    ocrCompletedAt: timestamp("ocr_completed_at"),
    ocrEngineName: text("ocr_engine_name"),
    ocrEngineVersion: text("ocr_engine_version"),
    ocrTextChecksum: text("ocr_text_checksum"),
    ocrBlockCount: integer("ocr_block_count"),
    ocrLineCount: integer("ocr_line_count"),
    ocrAverageConfidence: numeric("ocr_average_confidence"),
    ocrFailureReason: text("ocr_failure_reason"),
    transcriptStatus: text("transcript_status"),
    transcriptStartedAt: timestamp("transcript_started_at"),
    transcriptCompletedAt: timestamp("transcript_completed_at"),
    transcriptEngineName: text("transcript_engine_name"),
    transcriptEngineVersion: text("transcript_engine_version"),
    transcriptTextChecksum: text("transcript_text_checksum"),
    transcriptSegmentCount: integer("transcript_segment_count"),
    transcriptSpeakerCount: integer("transcript_speaker_count"),
    transcriptLanguageCode: text("transcript_language_code"),
    transcriptAverageConfidence: numeric("transcript_average_confidence"),
    transcriptFailureReason: text("transcript_failure_reason"),
    mediaDurationMs: bigint("media_duration_ms", { mode: "number" }),
    // Phase 5B.4 — Email / HTML / Imported Content
    importContentType: text("import_content_type"),
    importParseStatus: text("import_parse_status"),
    importParseStartedAt: timestamp("import_parse_started_at"),
    importParseCompletedAt: timestamp("import_parse_completed_at"),
    importParserName: text("import_parser_name"),
    importParserVersion: text("import_parser_version"),
    importTextChecksum: text("import_text_checksum"),
    importMessageCount: integer("import_message_count"),
    importSectionCount: integer("import_section_count"),
    importLinkCount: integer("import_link_count"),
    importFailureReason: text("import_failure_reason"),
    sourceLanguageCode: text("source_language_code"),
  },
  (t) => [
    sql`CONSTRAINT kdv_version_number_check CHECK (${t.versionNumber} > 0)`,
    sql`CONSTRAINT kdv_version_status_check CHECK (${t.versionStatus} IN ('pending','uploaded','processing','indexed','failed','superseded'))`,
    sql`CONSTRAINT kdv_file_size_check CHECK (${t.fileSizeBytes} IS NULL OR ${t.fileSizeBytes} >= 0)`,
    sql`CONSTRAINT kdv_char_count_check CHECK (${t.characterCount} IS NULL OR ${t.characterCount} >= 0)`,
    sql`CONSTRAINT kdv_page_count_check CHECK (${t.pageCount} IS NULL OR ${t.pageCount} >= 0)`,
    sql`CONSTRAINT kdv_parse_status_check CHECK (${t.parseStatus} IS NULL OR ${t.parseStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT kdv_norm_char_count_check CHECK (${t.normalizedCharacterCount} IS NULL OR ${t.normalizedCharacterCount} >= 0)`,
    sql`CONSTRAINT kdv_struct_parse_status_check CHECK (${t.structuredParseStatus} IS NULL OR ${t.structuredParseStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT kdv_struct_sheet_count_check CHECK (${t.structuredSheetCount} IS NULL OR ${t.structuredSheetCount} >= 0)`,
    sql`CONSTRAINT kdv_ocr_status_check CHECK (${t.ocrStatus} IS NULL OR ${t.ocrStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT kdv_ocr_block_count_check CHECK (${t.ocrBlockCount} IS NULL OR ${t.ocrBlockCount} >= 0)`,
    sql`CONSTRAINT kdv_ocr_line_count_check CHECK (${t.ocrLineCount} IS NULL OR ${t.ocrLineCount} >= 0)`,
    sql`CONSTRAINT kdv_ocr_avg_confidence_check CHECK (${t.ocrAverageConfidence} IS NULL OR (${t.ocrAverageConfidence} >= 0 AND ${t.ocrAverageConfidence} <= 1))`,
    sql`CONSTRAINT kdv_struct_row_count_check CHECK (${t.structuredRowCount} IS NULL OR ${t.structuredRowCount} >= 0)`,
    sql`CONSTRAINT kdv_struct_col_count_check CHECK (${t.structuredColumnCount} IS NULL OR ${t.structuredColumnCount} >= 0)`,
    sql`CONSTRAINT kdv_transcript_status_check CHECK (${t.transcriptStatus} IS NULL OR ${t.transcriptStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT kdv_transcript_segment_count_check CHECK (${t.transcriptSegmentCount} IS NULL OR ${t.transcriptSegmentCount} >= 0)`,
    sql`CONSTRAINT kdv_transcript_speaker_count_check CHECK (${t.transcriptSpeakerCount} IS NULL OR ${t.transcriptSpeakerCount} >= 0)`,
    sql`CONSTRAINT kdv_transcript_avg_confidence_check CHECK (${t.transcriptAverageConfidence} IS NULL OR (${t.transcriptAverageConfidence} >= 0 AND ${t.transcriptAverageConfidence} <= 1))`,
    sql`CONSTRAINT kdv_media_duration_ms_check CHECK (${t.mediaDurationMs} IS NULL OR ${t.mediaDurationMs} >= 0)`,
    uniqueIndex("kdv_doc_version_unique").on(t.knowledgeDocumentId, t.versionNumber),
    index("kdv_tenant_doc_version_idx").on(t.tenantId, t.knowledgeDocumentId, t.versionNumber),
    index("kdv_tenant_is_current_idx").on(t.tenantId, t.isCurrent, t.createdAt),
    index("kdv_tenant_status_idx").on(t.tenantId, t.versionStatus, t.createdAt),
    index("kdv_tenant_parse_status_idx").on(t.tenantId, t.parseStatus, t.createdAt),
    index("kdv_tenant_struct_parse_status_idx").on(t.tenantId, t.structuredParseStatus, t.createdAt),
    index("kdv_tenant_transcript_status_idx").on(t.tenantId, t.transcriptStatus, t.createdAt),
    sql`CONSTRAINT kdv_import_content_type_check CHECK (${t.importContentType} IS NULL OR ${t.importContentType} IN ('email','html','imported_text'))`,
    sql`CONSTRAINT kdv_import_parse_status_check CHECK (${t.importParseStatus} IS NULL OR ${t.importParseStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT kdv_import_message_count_check CHECK (${t.importMessageCount} IS NULL OR ${t.importMessageCount} >= 0)`,
    sql`CONSTRAINT kdv_import_section_count_check CHECK (${t.importSectionCount} IS NULL OR ${t.importSectionCount} >= 0)`,
    sql`CONSTRAINT kdv_import_link_count_check CHECK (${t.importLinkCount} IS NULL OR ${t.importLinkCount} >= 0)`,
    index("kdv_tenant_import_parse_status_idx").on(t.tenantId, t.importParseStatus, t.createdAt),
  ],
);

export const insertKnowledgeDocumentVersionSchema = createInsertSchema(knowledgeDocumentVersions).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeDocumentVersion = z.infer<typeof insertKnowledgeDocumentVersionSchema>;
export type KnowledgeDocumentVersion = typeof knowledgeDocumentVersions.$inferSelect;

// ─── knowledge_storage_objects ────────────────────────────────────────────────

export const knowledgeStorageObjects = pgTable(
  "knowledge_storage_objects",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    storageProvider: text("storage_provider").notNull(),
    bucketName: text("bucket_name"),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    uploadStatus: text("upload_status").notNull().default("pending"),
    uploadedAt: timestamp("uploaded_at"),
    verifiedAt: timestamp("verified_at"),
    deletedAt: timestamp("deleted_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT kso_provider_check CHECK (${t.storageProvider} IN ('r2','supabase_storage','local'))`,
    sql`CONSTRAINT kso_upload_status_check CHECK (${t.uploadStatus} IN ('pending','uploaded','verified','failed','deleted'))`,
    sql`CONSTRAINT kso_file_size_check CHECK (${t.fileSizeBytes} IS NULL OR ${t.fileSizeBytes} >= 0)`,
    index("kso_tenant_version_created_idx").on(t.tenantId, t.knowledgeDocumentVersionId, t.createdAt),
    index("kso_tenant_provider_status_idx").on(t.tenantId, t.storageProvider, t.uploadStatus, t.createdAt),
    index("kso_tenant_object_key_idx").on(t.tenantId, t.objectKey),
  ],
);

export const insertKnowledgeStorageObjectSchema = createInsertSchema(knowledgeStorageObjects).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeStorageObject = z.infer<typeof insertKnowledgeStorageObjectSchema>;
export type KnowledgeStorageObject = typeof knowledgeStorageObjects.$inferSelect;

// ─── knowledge_processing_jobs ────────────────────────────────────────────────

export const knowledgeProcessingJobs = pgTable(
  "knowledge_processing_jobs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .references(() => knowledgeDocumentVersions.id),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    idempotencyKey: text("idempotency_key"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    failureReason: text("failure_reason"),
    payload: jsonb("payload"),
    resultSummary: jsonb("result_summary"),
    workerId: text("worker_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    processorName: text("processor_name"),
    processorVersion: text("processor_version"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    structuredProcessorName: text("structured_processor_name"),
    structuredProcessorVersion: text("structured_processor_version"),
    ocrProcessorName: text("ocr_processor_name"),
    ocrProcessorVersion: text("ocr_processor_version"),
    transcriptProcessorName: text("transcript_processor_name"),
    transcriptProcessorVersion: text("transcript_processor_version"),
    importProcessorName: text("import_processor_name"),
    importProcessorVersion: text("import_processor_version"),
    embeddingProvider: text("embedding_provider"),
    embeddingModel: text("embedding_model"),
    tokenUsage: integer("token_usage"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 8 }),
  },
  (t) => [
    sql`CONSTRAINT kpj_job_type_check CHECK (${t.jobType} IN ('upload_verify','parse','chunk','embed','index','reindex','delete_index','lifecycle_sync','extract_text','structured_parse','structured_chunk','ocr_parse','ocr_chunk','transcript_parse','transcript_chunk','import_parse','import_chunk','embedding_generate','embedding_retry'))`,
    sql`CONSTRAINT kpj_status_check CHECK (${t.status} IN ('queued','running','completed','failed','cancelled','skipped'))`,
    sql`CONSTRAINT kpj_priority_check CHECK (${t.priority} >= 0)`,
    sql`CONSTRAINT kpj_attempt_count_check CHECK (${t.attemptCount} >= 0)`,
    sql`CONSTRAINT kpj_max_attempts_check CHECK (${t.maxAttempts} > 0)`,
    index("kpj_tenant_status_priority_idx").on(t.tenantId, t.status, t.priority, t.createdAt),
    index("kpj_tenant_doc_created_idx").on(t.tenantId, t.knowledgeDocumentId, t.createdAt),
    index("kpj_tenant_version_created_idx").on(t.tenantId, t.knowledgeDocumentVersionId, t.createdAt),
    index("kpj_tenant_type_status_idx").on(t.tenantId, t.jobType, t.status, t.createdAt),
    index("kpj_idempotency_key_idx").on(t.idempotencyKey),
  ],
);

export const insertKnowledgeProcessingJobSchema = createInsertSchema(knowledgeProcessingJobs).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeProcessingJob = z.infer<typeof insertKnowledgeProcessingJobSchema>;
export type KnowledgeProcessingJob = typeof knowledgeProcessingJobs.$inferSelect;

// ─── knowledge_chunks ────────────────────────────────────────────────────────

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    chunkIndex: integer("chunk_index").notNull(),
    chunkKey: text("chunk_key").notNull(),
    sourcePageStart: integer("source_page_start"),
    sourcePageEnd: integer("source_page_end"),
    characterStart: integer("character_start"),
    characterEnd: integer("character_end"),
    tokenEstimate: integer("token_estimate"),
    chunkText: text("chunk_text"),
    chunkHash: text("chunk_hash"),
    chunkActive: boolean("chunk_active").notNull().default(true),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    chunkStrategy: text("chunk_strategy"),
    chunkVersion: text("chunk_version"),
    overlapCharacters: integer("overlap_characters"),
    sourceHeadingPath: text("source_heading_path"),
    sourceSectionLabel: text("source_section_label"),
    replacedAt: timestamp("replaced_at"),
    replacedByJobId: varchar("replaced_by_job_id"),
    sheetName: text("sheet_name"),
    rowStart: integer("row_start"),
    rowEnd: integer("row_end"),
    columnHeaders: jsonb("column_headers"),
    tableChunk: boolean("table_chunk").notNull().default(false),
    tableChunkStrategy: text("table_chunk_strategy"),
    tableChunkVersion: text("table_chunk_version"),
    imageChunk: boolean("image_chunk").notNull().default(false),
    imageChunkStrategy: text("image_chunk_strategy"),
    imageChunkVersion: text("image_chunk_version"),
    imageRegionIndex: integer("image_region_index"),
    bboxLeft: numeric("bbox_left"),
    bboxTop: numeric("bbox_top"),
    bboxWidth: numeric("bbox_width"),
    bboxHeight: numeric("bbox_height"),
    ocrConfidence: numeric("ocr_confidence"),
    sourcePageNumber: integer("source_page_number"),
    transcriptChunk: boolean("transcript_chunk").notNull().default(false),
    transcriptChunkStrategy: text("transcript_chunk_strategy"),
    transcriptChunkVersion: text("transcript_chunk_version"),
    segmentStartMs: bigint("segment_start_ms", { mode: "number" }),
    segmentEndMs: bigint("segment_end_ms", { mode: "number" }),
    transcriptSegmentIndex: integer("transcript_segment_index"),
    speakerLabel: text("speaker_label"),
    transcriptConfidence: numeric("transcript_confidence"),
    sourceTrack: text("source_track"),
    // Phase 5B.4 — Email / HTML / Imported Content chunks
    emailChunk: boolean("email_chunk").notNull().default(false),
    htmlChunk: boolean("html_chunk").notNull().default(false),
    importChunkStrategy: text("import_chunk_strategy"),
    importChunkVersion: text("import_chunk_version"),
    messageIndex: integer("message_index"),
    threadPosition: integer("thread_position"),
    sectionLabel: text("section_label"),
    sourceUrl: text("source_url"),
    senderLabel: text("sender_label"),
    sentAt: timestamp("sent_at"),
    quotedContentIncluded: boolean("quoted_content_included"),
  },
  (t) => [
    sql`CONSTRAINT kc_chunk_index_check CHECK (${t.chunkIndex} >= 0)`,
    sql`CONSTRAINT kc_image_region_idx_check CHECK (${t.imageRegionIndex} IS NULL OR ${t.imageRegionIndex} >= 0)`,
    sql`CONSTRAINT kc_source_page_check CHECK (${t.sourcePageNumber} IS NULL OR ${t.sourcePageNumber} >= 0)`,
    sql`CONSTRAINT kc_bbox_left_check CHECK (${t.bboxLeft} IS NULL OR ${t.bboxLeft} >= 0)`,
    sql`CONSTRAINT kc_bbox_top_check CHECK (${t.bboxTop} IS NULL OR ${t.bboxTop} >= 0)`,
    sql`CONSTRAINT kc_bbox_width_check CHECK (${t.bboxWidth} IS NULL OR ${t.bboxWidth} >= 0)`,
    sql`CONSTRAINT kc_bbox_height_check CHECK (${t.bboxHeight} IS NULL OR ${t.bboxHeight} >= 0)`,
    sql`CONSTRAINT kc_ocr_confidence_check CHECK (${t.ocrConfidence} IS NULL OR (${t.ocrConfidence} >= 0 AND ${t.ocrConfidence} <= 1))`,
    sql`CONSTRAINT kc_page_start_check CHECK (${t.sourcePageStart} IS NULL OR ${t.sourcePageStart} >= 0)`,
    sql`CONSTRAINT kc_page_end_check CHECK (${t.sourcePageEnd} IS NULL OR ${t.sourcePageEnd} >= 0)`,
    sql`CONSTRAINT kc_char_start_check CHECK (${t.characterStart} IS NULL OR ${t.characterStart} >= 0)`,
    sql`CONSTRAINT kc_char_end_check CHECK (${t.characterEnd} IS NULL OR ${t.characterEnd} >= 0)`,
    sql`CONSTRAINT kc_token_estimate_check CHECK (${t.tokenEstimate} IS NULL OR ${t.tokenEstimate} >= 0)`,
    sql`CONSTRAINT kc_overlap_chars_check CHECK (${t.overlapCharacters} IS NULL OR ${t.overlapCharacters} >= 0)`,
    sql`CONSTRAINT kc_row_start_check CHECK (${t.rowStart} IS NULL OR ${t.rowStart} >= 0)`,
    sql`CONSTRAINT kc_row_end_check CHECK (${t.rowEnd} IS NULL OR ${t.rowEnd} >= 0)`,
    sql`CONSTRAINT kc_row_range_check CHECK (${t.rowEnd} IS NULL OR ${t.rowStart} IS NULL OR ${t.rowEnd} >= ${t.rowStart})`,
    sql`CONSTRAINT kc_transcript_segment_idx_check CHECK (${t.transcriptSegmentIndex} IS NULL OR ${t.transcriptSegmentIndex} >= 0)`,
    sql`CONSTRAINT kc_segment_start_ms_check CHECK (${t.segmentStartMs} IS NULL OR ${t.segmentStartMs} >= 0)`,
    sql`CONSTRAINT kc_segment_end_ms_check CHECK (${t.segmentEndMs} IS NULL OR ${t.segmentEndMs} >= 0)`,
    sql`CONSTRAINT kc_segment_ms_range_check CHECK (${t.segmentEndMs} IS NULL OR ${t.segmentStartMs} IS NULL OR ${t.segmentEndMs} >= ${t.segmentStartMs})`,
    sql`CONSTRAINT kc_transcript_confidence_check CHECK (${t.transcriptConfidence} IS NULL OR (${t.transcriptConfidence} >= 0 AND ${t.transcriptConfidence} <= 1))`,
    sql`CONSTRAINT kc_message_index_check CHECK (${t.messageIndex} IS NULL OR ${t.messageIndex} >= 0)`,
    sql`CONSTRAINT kc_thread_position_check CHECK (${t.threadPosition} IS NULL OR ${t.threadPosition} >= 0)`,
    index("idx_kchk_email_chunk").on(t.tenantId, t.knowledgeDocumentVersionId, t.emailChunk, t.chunkActive),
    index("idx_kchk_html_chunk").on(t.tenantId, t.knowledgeDocumentVersionId, t.htmlChunk, t.chunkActive),
    uniqueIndex("kc_version_chunk_index_active_unique").on(t.knowledgeDocumentVersionId, t.chunkIndex).where(sql`chunk_active = true`),
    uniqueIndex("kc_version_chunk_key_active_unique").on(t.knowledgeDocumentVersionId, t.chunkKey).where(sql`chunk_active = true`),
    index("kc_tenant_kb_doc_idx").on(t.tenantId, t.knowledgeBaseId, t.knowledgeDocumentId),
    index("kc_tenant_version_active_idx").on(t.tenantId, t.knowledgeDocumentVersionId, t.chunkActive, t.chunkIndex),
  ],
);

export const insertKnowledgeChunkSchema = createInsertSchema(knowledgeChunks).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeChunk = z.infer<typeof insertKnowledgeChunkSchema>;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;

// ─── knowledge_embeddings ────────────────────────────────────────────────────

export const knowledgeEmbeddings = pgTable(
  "knowledge_embeddings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    knowledgeChunkId: varchar("knowledge_chunk_id")
      .notNull()
      .references(() => knowledgeChunks.id),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingStatus: text("embedding_status").notNull().default("pending"),
    embeddingVector: real("embedding_vector").array(),
    embeddingDimensions: integer("embedding_dimensions"),
    tokenUsage: integer("token_usage"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 8 }),
    vectorBackend: text("vector_backend").notNull().default("pgvector"),
    vectorStatus: text("vector_status").notNull().default("pending"),
    vectorNamespace: text("vector_namespace"),
    vectorReference: text("vector_reference"),
    dimensions: integer("dimensions"),
    contentHash: text("content_hash"),
    indexedAt: timestamp("indexed_at"),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata"),
    isActive: boolean("is_active").notNull().default(true),
    similarityMetric: text("similarity_metric"),
    embeddingVersion: text("embedding_version"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT ke_embedding_status_check CHECK (${t.embeddingStatus} IN ('pending','running','completed','failed'))`,
    sql`CONSTRAINT ke_vector_backend_check CHECK (${t.vectorBackend} IN ('pgvector','pinecone','weaviate','qdrant','custom'))`,
    sql`CONSTRAINT ke_vector_status_check CHECK (${t.vectorStatus} IN ('pending','indexed','failed','deleted'))`,
    sql`CONSTRAINT ke_dimensions_check CHECK (${t.dimensions} IS NULL OR ${t.dimensions} > 0)`,
    sql`CONSTRAINT ke_embedding_dimensions_check CHECK (${t.embeddingDimensions} IS NULL OR ${t.embeddingDimensions} > 0)`,
    sql`CONSTRAINT ke_token_usage_check CHECK (${t.tokenUsage} IS NULL OR ${t.tokenUsage} >= 0)`,
    sql`CONSTRAINT ke_similarity_metric_check CHECK (${t.similarityMetric} IS NULL OR ${t.similarityMetric} IN ('cosine','l2','inner_product'))`,
    index("ke_tenant_kb_status_idx").on(t.tenantId, t.knowledgeBaseId, t.vectorStatus, t.createdAt),
    index("ke_tenant_version_idx").on(t.tenantId, t.knowledgeDocumentVersionId, t.createdAt),
    index("ke_tenant_chunk_idx").on(t.tenantId, t.knowledgeChunkId, t.createdAt),
    index("ke_tenant_backend_status_idx").on(t.tenantId, t.vectorBackend, t.vectorStatus),
    index("ke_tenant_embedding_status_idx").on(t.tenantId, t.embeddingStatus, t.createdAt),
    index("ke_tenant_is_active_idx").on(t.tenantId, t.isActive, t.embeddingStatus),
  ],
);

export const insertKnowledgeEmbeddingSchema = createInsertSchema(knowledgeEmbeddings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeEmbedding = z.infer<typeof insertKnowledgeEmbeddingSchema>;
export type KnowledgeEmbedding = typeof knowledgeEmbeddings.$inferSelect;

// ─── knowledge_index_state ────────────────────────────────────────────────────

export const knowledgeIndexState = pgTable(
  "knowledge_index_state",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    indexState: text("index_state").notNull().default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    indexedChunkCount: integer("indexed_chunk_count").notNull().default(0),
    embeddingCount: integer("embedding_count").notNull().default(0),
    lastIndexedAt: timestamp("last_indexed_at"),
    staleReason: text("stale_reason"),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT kis_index_state_check CHECK (${t.indexState} IN ('pending','indexing','indexed','failed','stale','deleted'))`,
    sql`CONSTRAINT kis_chunk_count_check CHECK (${t.chunkCount} >= 0)`,
    sql`CONSTRAINT kis_indexed_chunk_count_check CHECK (${t.indexedChunkCount} >= 0)`,
    sql`CONSTRAINT kis_embedding_count_check CHECK (${t.embeddingCount} >= 0)`,
    uniqueIndex("kis_version_unique").on(t.knowledgeDocumentVersionId),
    index("kis_tenant_kb_state_idx").on(t.tenantId, t.knowledgeBaseId, t.indexState, t.updatedAt),
    index("kis_tenant_doc_idx").on(t.tenantId, t.knowledgeDocumentId, t.updatedAt),
    index("kis_tenant_version_idx").on(t.tenantId, t.knowledgeDocumentVersionId),
  ],
);

export const insertKnowledgeIndexStateSchema = createInsertSchema(knowledgeIndexState).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeIndexState = z.infer<typeof insertKnowledgeIndexStateSchema>;
export type KnowledgeIndexStateRow = typeof knowledgeIndexState.$inferSelect;

// ─── knowledge_search_runs ────────────────────────────────────────────────────
// Append-only observability log for vector search execution.
// Records which filters were applied, how many results came back, and timing.

export const knowledgeSearchRuns = pgTable(
  "knowledge_search_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    queryHash: text("query_hash").notNull(),
    embeddingModel: text("embedding_model"),
    topKRequested: integer("top_k_requested").notNull(),
    topKReturned: integer("top_k_returned").notNull(),
    filterSummary: jsonb("filter_summary"),
    searchDurationMs: integer("search_duration_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT ksr_top_k_requested_check CHECK (${t.topKRequested} > 0)`,
    sql`CONSTRAINT ksr_top_k_returned_check CHECK (${t.topKReturned} >= 0)`,
    index("ksr_tenant_kb_idx").on(t.tenantId, t.knowledgeBaseId, t.createdAt),
    index("ksr_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertKnowledgeSearchRunSchema = createInsertSchema(knowledgeSearchRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeSearchRun = z.infer<typeof insertKnowledgeSearchRunSchema>;
export type KnowledgeSearchRun = typeof knowledgeSearchRuns.$inferSelect;

// ─── knowledge_search_candidates ─────────────────────────────────────────────
// Append-only log of ranked candidates returned per search run.

export const knowledgeSearchCandidates = pgTable(
  "knowledge_search_candidates",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeSearchRunId: varchar("knowledge_search_run_id")
      .notNull()
      .references(() => knowledgeSearchRuns.id),
    knowledgeChunkId: varchar("knowledge_chunk_id")
      .notNull()
      .references(() => knowledgeChunks.id),
    knowledgeDocumentId: varchar("knowledge_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id),
    knowledgeDocumentVersionId: varchar("knowledge_document_version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    tenantId: varchar("tenant_id").notNull(),
    rank: integer("rank").notNull(),
    similarityScore: doublePrecision("similarity_score").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT ksc_rank_check CHECK (${t.rank} > 0)`,
    index("ksc_run_idx").on(t.knowledgeSearchRunId, t.rank),
    index("ksc_tenant_chunk_idx").on(t.tenantId, t.knowledgeChunkId),
  ],
);

export const insertKnowledgeSearchCandidateSchema = createInsertSchema(knowledgeSearchCandidates).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeSearchCandidate = z.infer<typeof insertKnowledgeSearchCandidateSchema>;
export type KnowledgeSearchCandidate = typeof knowledgeSearchCandidates.$inferSelect;

// ─── knowledge_retrieval_runs ─────────────────────────────────────────────────
// Append-only observability log for retrieval orchestration runs.

export const knowledgeRetrievalRuns = pgTable(
  "knowledge_retrieval_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    queryHash: text("query_hash").notNull(),
    embeddingModel: text("embedding_model"),
    embeddingVersion: text("embedding_version"),
    retrievalVersion: text("retrieval_version"),
    candidatesFound: integer("candidates_found").notNull().default(0),
    candidatesRanked: integer("candidates_ranked").notNull().default(0),
    chunksSelected: integer("chunks_selected").notNull().default(0),
    chunksSkippedDuplicate: integer("chunks_skipped_duplicate").notNull().default(0),
    chunksSkippedBudget: integer("chunks_skipped_budget").notNull().default(0),
    contextTokensUsed: integer("context_tokens_used").notNull().default(0),
    maxContextTokens: integer("max_context_tokens").notNull(),
    documentCount: integer("document_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // ── Phase 5Q — Query rewriting & safety columns ──────────────────────────
    originalQueryText: text("original_query_text"),
    normalizedQueryText: text("normalized_query_text"),
    rewrittenQueryText: text("rewritten_query_text"),
    expansionTerms: jsonb("expansion_terms"),
    rewriteStrategy: text("rewrite_strategy"),
    retrievalSafetyStatus: text("retrieval_safety_status"),
    queryRewriteLatencyMs: integer("query_rewrite_latency_ms"),
    queryExpansionCount: integer("query_expansion_count"),
    safetyReviewLatencyMs: integer("safety_review_latency_ms"),
    flaggedChunkCount: integer("flagged_chunk_count"),
    excludedForSafetyCount: integer("excluded_for_safety_count"),
    qualityConfidenceBand: text("quality_confidence_band"),
  },
  (t) => [
    sql`CONSTRAINT krr_max_context_check CHECK (${t.maxContextTokens} > 0)`,
    index("krr_tenant_kb_idx").on(t.tenantId, t.knowledgeBaseId, t.createdAt),
    index("krr_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertKnowledgeRetrievalRunSchema = createInsertSchema(knowledgeRetrievalRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeRetrievalRun = z.infer<typeof insertKnowledgeRetrievalRunSchema>;
export type KnowledgeRetrievalRun = typeof knowledgeRetrievalRuns.$inferSelect;

// ─── retrieval_metrics ────────────────────────────────────────────────────────
// Phase 5F — Retrieval quality telemetry. Append-only per retrieval run.

export const retrievalMetrics = pgTable(
  "retrieval_metrics",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    retrievalRunId: varchar("retrieval_run_id")
      .notNull()
      .references(() => knowledgeRetrievalRuns.id),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    uniqueDocumentCount: integer("unique_document_count").notNull(),
    tokenUsed: integer("token_used").notNull(),
    tokenBudget: integer("token_budget").notNull(),
    dedupRemovedCount: integer("dedup_removed_count").notNull().default(0),
    avgSimilarity: numeric("avg_similarity", { precision: 10, scale: 6 }),
    topSimilarity: numeric("top_similarity", { precision: 10, scale: 6 }),
    lowestSimilarity: numeric("lowest_similarity", { precision: 10, scale: 6 }),
    diversityScore: numeric("diversity_score", { precision: 10, scale: 4 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT rm_chunk_count_check CHECK (${t.chunkCount} >= 0)`,
    sql`CONSTRAINT rm_unique_doc_count_check CHECK (${t.uniqueDocumentCount} >= 0)`,
    sql`CONSTRAINT rm_token_used_check CHECK (${t.tokenUsed} >= 0)`,
    sql`CONSTRAINT rm_token_budget_check CHECK (${t.tokenBudget} > 0)`,
    sql`CONSTRAINT rm_dedup_removed_check CHECK (${t.dedupRemovedCount} >= 0)`,
    index("rm_run_id_idx").on(t.retrievalRunId),
    index("rm_tenant_kb_idx").on(t.tenantId, t.knowledgeBaseId, t.createdAt),
  ],
);

export const insertRetrievalMetricsSchema = createInsertSchema(retrievalMetrics).omit({
  id: true,
  createdAt: true,
});
export type InsertRetrievalMetrics = z.infer<typeof insertRetrievalMetricsSchema>;
export type RetrievalMetric = typeof retrievalMetrics.$inferSelect;

// ─── retrieval_cache_entries ──────────────────────────────────────────────────
// Phase 5F — Retrieval cache. Tenant+KB+query_hash+version-scoped. Append-only.

export const retrievalCacheEntries = pgTable(
  "retrieval_cache_entries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    knowledgeBaseId: varchar("knowledge_base_id").notNull(),
    queryHash: text("query_hash").notNull(),
    queryText: text("query_text").notNull(),
    embeddingVersion: text("embedding_version"),
    retrievalVersion: text("retrieval_version").notNull(),
    cacheStatus: text("cache_status").notNull().default("active"),
    resultChunkIds: jsonb("result_chunk_ids").notNull(),
    resultSummary: jsonb("result_summary"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT rce_cache_status_check CHECK (${t.cacheStatus} IN ('active','expired','invalidated'))`,
    index("rce_tenant_kb_hash_idx").on(t.tenantId, t.knowledgeBaseId, t.queryHash),
    index("rce_status_expires_idx").on(t.cacheStatus, t.expiresAt),
    index("rce_tenant_kb_status_idx").on(t.tenantId, t.knowledgeBaseId, t.cacheStatus),
  ],
);

export const insertRetrievalCacheEntrySchema = createInsertSchema(retrievalCacheEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertRetrievalCacheEntry = z.infer<typeof insertRetrievalCacheEntrySchema>;
export type RetrievalCacheEntry = typeof retrievalCacheEntries.$inferSelect;

// ─── document_trust_signals ───────────────────────────────────────────────────
// Phase 5F — Lightweight probabilistic trust-signal log. Append-only. No definitive claims.

export const documentTrustSignals = pgTable(
  "document_trust_signals",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    documentId: varchar("document_id").notNull(),
    documentVersionId: varchar("document_version_id"),
    signalType: text("signal_type").notNull(),
    signalSource: text("signal_source").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }).notNull(),
    rawEvidence: jsonb("raw_evidence"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("dts_tenant_doc_idx").on(t.tenantId, t.documentId, t.createdAt),
    index("dts_tenant_signal_type_idx").on(t.tenantId, t.signalType, t.createdAt),
  ],
);

export const insertDocumentTrustSignalSchema = createInsertSchema(documentTrustSignals).omit({
  id: true,
  createdAt: true,
});
export type InsertDocumentTrustSignal = z.infer<typeof insertDocumentTrustSignalSchema>;
export type DocumentTrustSignal = typeof documentTrustSignals.$inferSelect;

// ─── document_risk_scores ─────────────────────────────────────────────────────
// Phase 5F — Derived risk score per document (+ version). Append-only.

export const documentRiskScores = pgTable(
  "document_risk_scores",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: varchar("tenant_id").notNull(),
    documentId: varchar("document_id").notNull(),
    documentVersionId: varchar("document_version_id"),
    riskLevel: text("risk_level").notNull(),
    riskScore: numeric("risk_score", { precision: 5, scale: 4 }).notNull(),
    scoringVersion: text("scoring_version").notNull(),
    contributingSignals: jsonb("contributing_signals").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT drs_risk_level_check CHECK (${t.riskLevel} IN ('low_risk','medium_risk','high_risk','unknown'))`,
    index("drs_tenant_doc_idx").on(t.tenantId, t.documentId, t.createdAt),
    index("drs_tenant_risk_idx").on(t.tenantId, t.riskLevel, t.createdAt),
  ],
);

export const insertDocumentRiskScoreSchema = createInsertSchema(documentRiskScores).omit({
  id: true,
  createdAt: true,
});
export type InsertDocumentRiskScore = z.infer<typeof insertDocumentRiskScoreSchema>;
export type DocumentRiskScore = typeof documentRiskScores.$inferSelect;

// ─── Phase 5G — Knowledge Asset Registry & Multimodal Foundation ─────────────

// ─── knowledge_assets ─────────────────────────────────────────────────────────
// Phase 5G — Canonical registry for all knowledge content (documents, images,
// videos, audio, emails, webpages). current_version_id FK added post-migration.

export const knowledgeAssets = pgTable(
  "knowledge_assets",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    knowledgeBaseId: text("knowledge_base_id").notNull(),
    assetType: text("asset_type").notNull(),
    title: text("title"),
    sourceType: text("source_type").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    processingState: text("processing_state").notNull().default("pending"),
    visibilityState: text("visibility_state").notNull().default("private"),
    currentVersionId: varchar("current_version_id"),
    checksumSha256: text("checksum_sha256"),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT ka_asset_type_check CHECK (${t.assetType} IN ('document','image','video','audio','email','webpage'))`,
    sql`CONSTRAINT ka_source_type_check CHECK (${t.sourceType} IN ('upload','url','manual','api','email_ingest'))`,
    sql`CONSTRAINT ka_lifecycle_state_check CHECK (${t.lifecycleState} IN ('active','suspended','archived','deleted'))`,
    sql`CONSTRAINT ka_processing_state_check CHECK (${t.processingState} IN ('pending','processing','ready','failed','reindex_required'))`,
    sql`CONSTRAINT ka_visibility_state_check CHECK (${t.visibilityState} IN ('private','shared','internal'))`,
    index("ka_tenant_kb_created_idx").on(t.tenantId, t.knowledgeBaseId, t.createdAt),
    index("ka_tenant_type_created_idx").on(t.tenantId, t.assetType, t.createdAt),
    index("ka_tenant_lifecycle_idx").on(t.tenantId, t.lifecycleState, t.createdAt),
    index("ka_tenant_processing_idx").on(t.tenantId, t.processingState, t.createdAt),
    index("ka_tenant_kb_type_idx").on(t.tenantId, t.knowledgeBaseId, t.assetType),
    index("ka_tenant_current_version_idx").on(t.tenantId, t.currentVersionId),
  ],
);

export const insertKnowledgeAssetSchema = createInsertSchema(knowledgeAssets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeAsset = z.infer<typeof insertKnowledgeAssetSchema>;
export type KnowledgeAsset = typeof knowledgeAssets.$inferSelect;

// ─── knowledge_asset_versions ─────────────────────────────────────────────────
// Phase 5G — Immutable version log per asset. version_number is per-asset
// monotonically increasing. storage_object_id links to physical file reference.

export const knowledgeAssetVersions = pgTable(
  "knowledge_asset_versions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    assetId: varchar("asset_id")
      .notNull()
      .references(() => knowledgeAssets.id),
    tenantId: text("tenant_id"),
    versionNumber: integer("version_number").notNull(),
    storageObjectId: varchar("storage_object_id"),
    parserVersion: text("parser_version"),
    processingProfile: text("processing_profile"),
    checksumSha256: text("checksum_sha256"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    mimeType: text("mime_type"),
    ingestStatus: text("ingest_status"),
    sourceUploadId: text("source_upload_id"),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Phase 5L — embedding & index lifecycle state
    embeddingStatus: text("embedding_status"),
    indexLifecycleState: text("index_lifecycle_state"),
    indexLifecycleUpdatedAt: timestamp("index_lifecycle_updated_at"),
  },
  (t) => [
    sql`CONSTRAINT kav_version_number_check CHECK (${t.versionNumber} > 0)`,
    sql`CONSTRAINT kav_size_bytes_check CHECK (${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0)`,
    sql`CONSTRAINT kav_ingest_status_check CHECK (${t.ingestStatus} IS NULL OR ${t.ingestStatus} IN ('pending','registered','processing','ready','failed'))`,
    sql`CONSTRAINT kav_embedding_status_check CHECK (${t.embeddingStatus} IS NULL OR ${t.embeddingStatus} IN ('not_ready','pending','indexed','stale','failed'))`,
    sql`CONSTRAINT kav_index_lifecycle_state_check CHECK (${t.indexLifecycleState} IS NULL OR ${t.indexLifecycleState} IN ('not_ready','pending','indexed','stale','failed'))`,
    uniqueIndex("kav_asset_version_uniq").on(t.assetId, t.versionNumber),
    index("kav_asset_created_idx").on(t.assetId, t.createdAt),
    index("kav_storage_object_idx").on(t.storageObjectId),
    index("kav_tenant_lifecycle_idx").on(t.tenantId, t.indexLifecycleState),
    index("kav_tenant_embedding_status_idx").on(t.tenantId, t.embeddingStatus),
  ],
);

export const insertKnowledgeAssetVersionSchema = createInsertSchema(knowledgeAssetVersions).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeAssetVersion = z.infer<typeof insertKnowledgeAssetVersionSchema>;
export type KnowledgeAssetVersion = typeof knowledgeAssetVersions.$inferSelect;

// ─── knowledge_asset_embeddings ──────────────────────────────────────────────
// Phase 5L — multimodal asset-version-level embeddings with full provenance.
// Separate from knowledge_embeddings (document/chunk-centric).
// Each row represents one embedding derived from one multimodal source.
export const knowledgeAssetEmbeddings = pgTable(
  "knowledge_asset_embeddings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    assetId: varchar("asset_id").notNull().references(() => knowledgeAssets.id),
    assetVersionId: varchar("asset_version_id").notNull().references(() => knowledgeAssetVersions.id),
    // source provenance
    sourceType: text("source_type").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceChecksum: text("source_checksum"),
    sourcePriority: integer("source_priority").notNull().default(99),
    textLength: integer("text_length"),
    // embedding metadata
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingVersion: text("embedding_version"),
    embeddingDimensions: integer("embedding_dimensions"),
    embeddingVector: real("embedding_vector").array(),
    // lifecycle
    embeddingStatus: text("embedding_status").notNull().default("pending"),
    indexedAt: timestamp("indexed_at"),
    staleReason: text("stale_reason"),
    failureReason: text("failure_reason"),
    isActive: boolean("is_active").notNull().default(true),
    // metadata / audit
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT kae_source_type_check CHECK (${t.sourceType} IN ('parsed_text','ocr_text','transcript_text','caption_text','video_frame_text','imported_text'))`,
    sql`CONSTRAINT kae_embedding_status_check CHECK (${t.embeddingStatus} IN ('pending','completed','failed','stale'))`,
    sql`CONSTRAINT kae_source_priority_check CHECK (${t.sourcePriority} >= 1 AND ${t.sourcePriority} <= 99)`,
    index("kae_tenant_version_idx").on(t.tenantId, t.assetVersionId),
    index("kae_tenant_asset_idx").on(t.tenantId, t.assetId),
    index("kae_tenant_source_type_idx").on(t.tenantId, t.sourceType, t.embeddingStatus),
    index("kae_tenant_status_active_idx").on(t.tenantId, t.embeddingStatus, t.isActive),
    index("kae_tenant_version_status_idx").on(t.tenantId, t.assetVersionId, t.embeddingStatus),
  ],
);

export const insertKnowledgeAssetEmbeddingSchema = createInsertSchema(knowledgeAssetEmbeddings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeAssetEmbedding = z.infer<typeof insertKnowledgeAssetEmbeddingSchema>;
export type KnowledgeAssetEmbedding = typeof knowledgeAssetEmbeddings.$inferSelect;

// ─── knowledge_retrieval_candidates ──────────────────────────────────────────
// Phase 5M — Per-candidate retrieval explainability records.
// One row per candidate per retrieval run with filter_status + reason codes.
// Append-only. Persisted when persistRun=true in retrieval orchestrator.
export const knowledgeRetrievalCandidates = pgTable(
  "knowledge_retrieval_candidates",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    retrievalRunId: varchar("retrieval_run_id")
      .notNull()
      .references(() => knowledgeRetrievalRuns.id),
    chunkId: varchar("chunk_id").references(() => knowledgeChunks.id),
    knowledgeAssetEmbeddingId: varchar("knowledge_asset_embedding_id").references(
      () => knowledgeAssetEmbeddings.id,
    ),
    knowledgeAssetId: varchar("knowledge_asset_id").references(() => knowledgeAssets.id),
    knowledgeAssetVersionId: varchar("knowledge_asset_version_id").references(
      () => knowledgeAssetVersions.id,
    ),
    sourceType: text("source_type"),
    sourceKey: text("source_key"),
    similarityScore: numeric("similarity_score", { precision: 10, scale: 8 }),
    rankingScore: numeric("ranking_score", { precision: 10, scale: 8 }),
    filterStatus: text("filter_status").notNull().default("candidate"),
    exclusionReason: text("exclusion_reason"),
    inclusionReason: text("inclusion_reason"),
    dedupReason: text("dedup_reason"),
    candidateRank: integer("candidate_rank"),
    finalRank: integer("final_rank"),
    tokenCountEstimate: integer("token_count_estimate"),
    // Phase 5N — Hybrid search channel fields
    channelOrigin: text("channel_origin"),
    vectorScore: numeric("vector_score", { precision: 10, scale: 8 }),
    lexicalScore: numeric("lexical_score", { precision: 10, scale: 8 }),
    fusedScore: numeric("fused_score", { precision: 10, scale: 8 }),
    rerankScore: numeric("rerank_score", { precision: 10, scale: 8 }),
    preFusionRankVector: integer("pre_fusion_rank_vector"),
    preFusionRankLexical: integer("pre_fusion_rank_lexical"),
    preRerankRank: integer("pre_rerank_rank"),
    postRerankRank: integer("post_rerank_rank"),
    // Phase 5O — Advanced reranking fields
    heavyRerankScore: numeric("heavy_rerank_score", { precision: 10, scale: 8 }),
    finalScore: numeric("final_score", { precision: 10, scale: 8 }),
    rerankMode: text("rerank_mode"),
    fallbackUsed: boolean("fallback_used").default(false),
    fallbackReason: text("fallback_reason"),
    shortlistRank: integer("shortlist_rank"),
    advancedRerankRank: integer("advanced_rerank_rank"),
    rerankProviderName: text("rerank_provider_name"),
    rerankProviderVersion: text("rerank_provider_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    sql`CONSTRAINT krc_filter_status_check CHECK (${t.filterStatus} IN ('candidate','excluded','selected'))`,
    sql`CONSTRAINT krc_similarity_check CHECK (${t.similarityScore} IS NULL OR (${t.similarityScore} >= 0 AND ${t.similarityScore} <= 1))`,
    sql`CONSTRAINT krc_token_count_check CHECK (${t.tokenCountEstimate} IS NULL OR ${t.tokenCountEstimate} >= 0)`,
    sql`CONSTRAINT krc_channel_origin_check CHECK (${t.channelOrigin} IS NULL OR ${t.channelOrigin} IN ('vector_only','lexical_only','vector_and_lexical'))`,
    sql`CONSTRAINT krc_rerank_mode_check CHECK (${t.rerankMode} IS NULL OR ${t.rerankMode} IN ('lightweight','advanced','fallback'))`,
    index("krc_tenant_run_idx").on(t.tenantId, t.retrievalRunId),
    index("krc_tenant_chunk_idx").on(t.tenantId, t.chunkId),
    index("krc_tenant_version_idx").on(t.tenantId, t.knowledgeAssetVersionId),
    index("krc_tenant_status_idx").on(t.tenantId, t.filterStatus),
    index("krc_tenant_source_type_idx").on(t.tenantId, t.sourceType),
    index("krc_tenant_channel_idx").on(t.tenantId, t.channelOrigin),
    index("krc_tenant_rerank_mode_idx").on(t.tenantId, t.rerankMode),
    index("krc_tenant_fallback_idx").on(t.tenantId, t.fallbackUsed),
    index("krc_tenant_shortlist_rank_idx").on(t.tenantId, t.shortlistRank),
    index("krc_tenant_adv_rerank_rank_idx").on(t.tenantId, t.advancedRerankRank),
  ],
);

export const insertKnowledgeRetrievalCandidateSchema = createInsertSchema(
  knowledgeRetrievalCandidates,
).omit({ id: true, createdAt: true });
export type InsertKnowledgeRetrievalCandidate = z.infer<
  typeof insertKnowledgeRetrievalCandidateSchema
>;
export type KnowledgeRetrievalCandidate = typeof knowledgeRetrievalCandidates.$inferSelect;

// ─── asset_storage_objects ────────────────────────────────────────────────────
// Phase 5G — Generic provider-agnostic storage registry for multimodal assets.
// Distinct from Phase 5B knowledge_storage_objects (document-version-linked).
// Prepares for checksum-based dedup in a future phase.

export const assetStorageObjects = pgTable(
  "asset_storage_objects",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    storageProvider: text("storage_provider").notNull(),
    bucketName: text("bucket_name").notNull(),
    objectKey: text("object_key").notNull(),
    storageClass: text("storage_class").notNull().default("hot"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type"),
    checksumSha256: text("checksum_sha256"),
    metadata: jsonb("metadata"),
    uploadedAt: timestamp("uploaded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    sql`CONSTRAINT aso_size_bytes_check CHECK (${t.sizeBytes} >= 0)`,
    sql`CONSTRAINT aso_storage_provider_check CHECK (${t.storageProvider} IN ('r2','s3','supabase','local'))`,
    sql`CONSTRAINT aso_storage_class_check CHECK (${t.storageClass} IN ('hot','cold','archive','deleted'))`,
    uniqueIndex("aso_tenant_bucket_key_uniq").on(t.tenantId, t.bucketName, t.objectKey),
    index("aso_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("aso_tenant_checksum_idx").on(t.tenantId, t.checksumSha256),
    index("aso_tenant_class_created_idx").on(t.tenantId, t.storageClass, t.createdAt),
  ],
);

export const insertAssetStorageObjectSchema = createInsertSchema(assetStorageObjects).omit({
  id: true,
  createdAt: true,
});
export type InsertAssetStorageObject = z.infer<typeof insertAssetStorageObjectSchema>;
export type AssetStorageObject = typeof assetStorageObjects.$inferSelect;

// ─── knowledge_asset_processing_jobs ──────────────────────────────────────────
// Phase 5G — Async job queue for multimodal asset processing. One row per
// discrete processing step. Append-only operational log.

export const knowledgeAssetProcessingJobs = pgTable(
  "knowledge_asset_processing_jobs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    assetId: varchar("asset_id")
      .notNull()
      .references(() => knowledgeAssets.id),
    assetVersionId: varchar("asset_version_id")
      .references(() => knowledgeAssetVersions.id),
    jobType: text("job_type").notNull(),
    jobStatus: text("job_status").notNull().default("queued"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    sql`CONSTRAINT kapj_attempt_number_check CHECK (${t.attemptNumber} > 0)`,
    sql`CONSTRAINT kapj_job_type_check CHECK (${t.jobType} IN ('parse_document','ocr_image','caption_image','extract_video_metadata','extract_audio','transcribe_audio','sample_video_frames','segment_video','chunk_text','embed_text','embed_image','index_asset','reindex_asset','delete_index'))`,
    sql`CONSTRAINT kapj_job_status_check CHECK (${t.jobStatus} IN ('queued','started','completed','failed','skipped','cancelled'))`,
    index("kapj_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("kapj_asset_created_idx").on(t.assetId, t.createdAt),
    index("kapj_status_created_idx").on(t.jobStatus, t.createdAt),
    index("kapj_type_created_idx").on(t.jobType, t.createdAt),
    index("kapj_tenant_asset_status_idx").on(t.tenantId, t.assetId, t.jobStatus),
    index("kapj_tenant_version_type_idx").on(t.tenantId, t.assetVersionId, t.jobType),
  ],
);

export const insertKnowledgeAssetProcessingJobSchema = createInsertSchema(knowledgeAssetProcessingJobs).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeAssetProcessingJob = z.infer<typeof insertKnowledgeAssetProcessingJobSchema>;
export type KnowledgeAssetProcessingJob = typeof knowledgeAssetProcessingJobs.$inferSelect;

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
    // ─── Phase 4O: Entitlement classification fields ─────────────────────────
    /** Commercial treatment applied at billing time. Default 'standard' = no plan entitlements applied. */
    entitlementTreatment: text("entitlement_treatment").notNull().default("standard"),
    /** USD amount covered by tenant's included plan allowance. 0 for standard treatment. */
    includedAmountUsd: numeric("included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** USD amount exceeding the included allowance (billed as overage). 0 for standard or fully-included. */
    overageAmountUsd: numeric("overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
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
    check(
      "ai_billing_usage_entitlement_treatment_check",
      sql`${t.entitlementTreatment} IN ('standard','included','partial_included','overage','blocked')`,
    ),
    check("ai_billing_usage_included_amount_check", sql`${t.includedAmountUsd} >= 0`),
    check("ai_billing_usage_overage_amount_check", sql`${t.overageAmountUsd} >= 0`),
    // Composite index for per-tenant billing range queries (billing summary, wallet queries)
    index("ai_billing_usage_tenant_created_idx").on(t.tenantId, t.createdAt),
    // Analytics indexes: per-feature and per-model cost breakdowns
    index("ai_billing_usage_tenant_feature_idx").on(t.tenantId, t.feature),
    index("ai_billing_usage_tenant_model_idx").on(t.tenantId, t.model),
    // Wallet replay queries: find pending/failed rows for a tenant sorted by time
    index("ai_billing_usage_tenant_wallet_status_idx").on(t.tenantId, t.walletStatus, t.createdAt),
    // Entitlement treatment queries
    index("ai_billing_usage_entitlement_treatment_idx").on(t.entitlementTreatment, t.createdAt),
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
    // ─── Phase 4O: Included vs overage breakdown totals ──────────────────────
    /** Sum of ai_billing_usage.included_amount_usd in period */
    aiIncludedAmountUsd: numeric("ai_included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of ai_billing_usage.overage_amount_usd in period */
    aiOverageAmountUsd: numeric("ai_overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of storage_billing_usage.included_amount_usd in period */
    storageIncludedAmountUsd: numeric("storage_included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** Sum of storage_billing_usage.overage_amount_usd in period */
    storageOverageAmountUsd: numeric("storage_overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
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
    // ─── Phase 4O: Entitlement classification fields ─────────────────────────
    /** Commercial treatment applied at billing time. Default 'standard'. */
    entitlementTreatment: text("entitlement_treatment").notNull().default("standard"),
    /** Storage usage amount (GB-hours etc) covered by included plan allowance. Prefixed ent_ to avoid conflict with pricing-based included_usage_amount. */
    entIncludedUsageAmount: numeric("ent_included_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    /** Storage usage amount exceeding included plan allowance. */
    entOverageUsageAmount: numeric("ent_overage_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    /** USD amount covered by included plan allowance. */
    includedAmountUsd: numeric("included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    /** USD amount as overage (exceeding included allowance). */
    overageAmountUsd: numeric("overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("sbu_raw_usage_check", sql`${t.rawUsageAmount} >= 0`),
    check("sbu_included_usage_check", sql`${t.includedUsageAmount} >= 0`),
    check("sbu_billable_usage_check", sql`${t.billableUsageAmount} >= 0`),
    check("sbu_provider_cost_check", sql`${t.providerCostUsd} >= 0`),
    check("sbu_customer_price_check", sql`${t.customerPriceUsd} >= 0`),
    check(
      "sbu_entitlement_treatment_check",
      sql`${t.entitlementTreatment} IN ('standard','included','partial_included','overage','blocked')`,
    ),
    check("sbu_ent_included_usage_check", sql`${t.entIncludedUsageAmount} >= 0`),
    check("sbu_ent_overage_usage_check", sql`${t.entOverageUsageAmount} >= 0`),
    check("sbu_included_amount_usd_check", sql`${t.includedAmountUsd} >= 0`),
    check("sbu_overage_amount_usd_check", sql`${t.overageAmountUsd} >= 0`),
    uniqueIndex("sbu_storage_usage_id_unique").on(t.storageUsageId),
    index("sbu_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("sbu_metric_created_idx").on(t.metricType, t.createdAt),
    index("sbu_tenant_metric_created_idx").on(t.tenantId, t.metricType, t.createdAt),
    index("sbu_entitlement_treatment_idx").on(t.entitlementTreatment, t.createdAt),
  ],
);

export const insertStorageBillingUsageSchema = createInsertSchema(storageBillingUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertStorageBillingUsage = z.infer<typeof insertStorageBillingUsageSchema>;
export type StorageBillingUsage = typeof storageBillingUsage.$inferSelect;

// ─── Phase 4L: Payments & Stripe Sync Foundation ─────────────────────────────

/**
 * invoice_payments — tracks payment attempts for finalized invoices.
 *
 * Design rules:
 *   - FK: invoice_id → invoices.id
 *   - One invoice may have multiple payment attempts
 *   - amount_usd should match invoice total for normal full-payment flow
 *   - Payment state machine: pending → processing → paid | failed | refunded | void
 *   - paid_at / failed_at / refunded_at set by state transitions
 *   - updated_at maintained on every transition
 *   - Only finalized invoices may enter payment flow (enforced at service level)
 */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    tenantId: text("tenant_id").notNull(),
    paymentProvider: text("payment_provider").notNull().default("stripe"),
    paymentStatus: text("payment_status").notNull().default("pending"),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    providerPaymentReference: text("provider_payment_reference"),
    paidAt: timestamp("paid_at"),
    failedAt: timestamp("failed_at"),
    refundedAt: timestamp("refunded_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ip_payment_status_check",
      sql`${t.paymentStatus} IN ('pending','processing','paid','failed','refunded','void')`,
    ),
    check(
      "ip_amount_usd_check",
      sql`${t.amountUsd} >= 0`,
    ),
    index("ip_invoice_id_idx").on(t.invoiceId),
    index("ip_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("ip_status_created_idx").on(t.paymentStatus, t.createdAt),
    uniqueIndex("ip_provider_ref_unique").on(t.providerPaymentReference),
  ],
);

export const insertInvoicePaymentSchema = createInsertSchema(invoicePayments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  paidAt: true,
  failedAt: true,
  refundedAt: true,
});
export type InsertInvoicePayment = z.infer<typeof insertInvoicePaymentSchema>;
export type InvoicePayment = typeof invoicePayments.$inferSelect;

/**
 * stripe_invoice_links — maps internal invoices to downstream Stripe objects.
 *
 * Design rules:
 *   - FK: invoice_id → invoices.id
 *   - Stripe IDs are linkage only — they do not override internal invoice totals
 *   - sync_status lifecycle: not_synced → synced | sync_failed
 *   - Stripe linkage is isolated from invoice logic
 */
export const stripeInvoiceLinks = pgTable(
  "stripe_invoice_links",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    tenantId: text("tenant_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    syncStatus: text("sync_status").notNull().default("not_synced"),
    lastSyncedAt: timestamp("last_synced_at"),
    lastSyncError: text("last_sync_error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "sil_sync_status_check",
      sql`${t.syncStatus} IN ('not_synced','synced','sync_failed')`,
    ),
    uniqueIndex("sil_invoice_id_unique").on(t.invoiceId),
    index("sil_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("sil_sync_status_created_idx").on(t.syncStatus, t.createdAt),
    uniqueIndex("sil_stripe_invoice_id_unique").on(t.stripeInvoiceId),
    uniqueIndex("sil_stripe_pi_unique").on(t.stripePaymentIntentId),
    uniqueIndex("sil_stripe_session_unique").on(t.stripeCheckoutSessionId),
  ],
);

export const insertStripeInvoiceLinkSchema = createInsertSchema(stripeInvoiceLinks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
  lastSyncError: true,
});
export type InsertStripeInvoiceLink = z.infer<typeof insertStripeInvoiceLinkSchema>;
export type StripeInvoiceLink = typeof stripeInvoiceLinks.$inferSelect;

/**
 * payment_events — append-only payment lifecycle timeline.
 *
 * Design rules:
 *   - FK: invoice_payment_id → invoice_payments.id (nullable)
 *   - FK: invoice_id → invoices.id
 *   - Append-only — no update or delete helpers
 *   - event_source: 'internal' | 'stripe_webhook' | 'manual'
 *   - event_status: 'recorded' (only value — for future extensibility)
 *   - provider_event_id: for Stripe webhook dedup (UNIQUE where non-null)
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    invoicePaymentId: text("invoice_payment_id")
      .references(() => invoicePayments.id),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    tenantId: text("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    eventSource: text("event_source").notNull().default("internal"),
    eventStatus: text("event_status").notNull().default("recorded"),
    providerEventId: text("provider_event_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "pe_event_source_check",
      sql`${t.eventSource} IN ('internal','stripe_webhook','manual')`,
    ),
    check(
      "pe_event_status_check",
      sql`${t.eventStatus} IN ('recorded')`,
    ),
    index("pe_invoice_id_created_idx").on(t.invoiceId, t.createdAt),
    index("pe_payment_id_created_idx").on(t.invoicePaymentId, t.createdAt),
    index("pe_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("pe_event_type_created_idx").on(t.eventType, t.createdAt),
    uniqueIndex("pe_provider_event_id_unique").on(t.providerEventId),
  ],
);

export const insertPaymentEventSchema = createInsertSchema(paymentEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertPaymentEvent = z.infer<typeof insertPaymentEventSchema>;
export type PaymentEvent = typeof paymentEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4M — Stripe Checkout & Webhook Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stripe_webhook_events — deduplication and audit table for incoming Stripe webhooks.
 *
 * Every Stripe webhook received is stored here before/during processing.
 * The UNIQUE(stripe_event_id) constraint ensures idempotent processing:
 * processing_status tracks lifecycle from 'received' → 'processed'/'ignored'/'failed'.
 *
 * Source of truth rules:
 *   - payload stores the raw parsed Stripe event body
 *   - internal invoice totals are NOT modified based on Stripe data
 *   - this table is the webhook audit trail, not financial truth
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    invoiceId: text("invoice_id").references(() => invoices.id),
    invoicePaymentId: text("invoice_payment_id").references(() => invoicePayments.id),
    tenantId: text("tenant_id"),
    processingStatus: text("processing_status").notNull().default("received"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    lastError: text("last_error"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "swe_processing_status_check",
      sql`${t.processingStatus} IN ('received','processed','ignored','failed')`,
    ),
    uniqueIndex("swe_stripe_event_id_unique").on(t.stripeEventId),
    index("swe_event_type_received_idx").on(t.eventType, t.receivedAt),
    index("swe_processing_status_received_idx").on(t.processingStatus, t.receivedAt),
    index("swe_invoice_id_idx").on(t.invoiceId),
    index("swe_invoice_payment_id_idx").on(t.invoicePaymentId),
    index("swe_tenant_id_idx").on(t.tenantId),
  ],
);

export const insertStripeWebhookEventSchema = createInsertSchema(stripeWebhookEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertStripeWebhookEvent = z.infer<typeof insertStripeWebhookEventSchema>;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4N — Subscription Plans & Entitlements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * subscription_plans — SaaS plan catalog.
 *
 * Plans are immutable commercial snapshots: never edit a row in place.
 * Archive old plans and create new ones. Historical invoices reference
 * tenant_subscriptions → subscription_plans, preserving historical truth.
 */
export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    planCode: text("plan_code").notNull(),
    planName: text("plan_name").notNull(),
    status: text("status").notNull().default("active"),
    billingInterval: text("billing_interval").notNull(),
    basePriceUsd: numeric("base_price_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("sp_status_check", sql`${t.status} IN ('active','archived')`),
    check("sp_billing_interval_check", sql`${t.billingInterval} IN ('monthly','yearly')`),
    check("sp_base_price_check", sql`${t.basePriceUsd} >= 0`),
    check("sp_effective_dates_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    uniqueIndex("sp_plan_code_effective_from_unique").on(t.planCode, t.effectiveFrom),
    index("sp_status_created_idx").on(t.status, t.createdAt),
    index("sp_plan_code_idx").on(t.planCode),
  ],
);

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans).omit({
  id: true,
  createdAt: true,
});
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;

/**
 * plan_entitlements — structured entitlement definitions per plan.
 *
 * Each entitlement_key is a named capability (e.g. included_ai_usd,
 * allow_overage_ai). Values are typed: numeric, text, or boolean.
 * entitlement_type governs interpretation: limit, included_usage,
 * feature_flag, or overage_rule.
 */
export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    subscriptionPlanId: varchar("subscription_plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    entitlementKey: text("entitlement_key").notNull(),
    entitlementType: text("entitlement_type").notNull(),
    numericValue: numeric("numeric_value", { precision: 18, scale: 8 }),
    textValue: text("text_value"),
    booleanValue: boolean("boolean_value"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "pe2_entitlement_type_check",
      sql`${t.entitlementType} IN ('limit','included_usage','feature_flag','overage_rule')`,
    ),
    index("pe2_subscription_plan_id_idx").on(t.subscriptionPlanId),
    index("pe2_entitlement_key_idx").on(t.entitlementKey),
  ],
);

export const insertPlanEntitlementSchema = createInsertSchema(planEntitlements).omit({
  id: true,
  createdAt: true,
});
export type InsertPlanEntitlement = z.infer<typeof insertPlanEntitlementSchema>;
export type PlanEntitlement = typeof planEntitlements.$inferSelect;

/**
 * tenant_subscriptions — explicit tenant→plan mapping.
 *
 * Exactly one active subscription per tenant at any point in time.
 * Non-overlapping windows enforced at DB level via trigger.
 * Multiple rows may exist for history; effective_to=NULL means current.
 */
export const tenantSubscriptions = pgTable(
  "tenant_subscriptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    subscriptionPlanId: varchar("subscription_plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    status: text("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start").notNull(),
    currentPeriodEnd: timestamp("current_period_end").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ts_status_check",
      sql`${t.status} IN ('trialing','active','past_due','paused','cancelled')`,
    ),
    check("ts_period_check", sql`${t.currentPeriodEnd} > ${t.currentPeriodStart}`),
    check("ts_effective_dates_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    index("ts_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("ts_tenant_status_idx").on(t.tenantId, t.status),
    index("ts_tenant_effective_from_idx").on(t.tenantId, t.effectiveFrom),
  ],
);

export const insertTenantSubscriptionSchema = createInsertSchema(tenantSubscriptions).omit({
  id: true,
  createdAt: true,
});
export type InsertTenantSubscription = z.infer<typeof insertTenantSubscriptionSchema>;
export type TenantSubscription = typeof tenantSubscriptions.$inferSelect;

/**
 * tenant_subscription_events — durable event history for subscription changes.
 *
 * Every major subscription action records an event here.
 * This is the audit trail, not the state source of truth.
 */
export const tenantSubscriptionEvents = pgTable(
  "tenant_subscription_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantSubscriptionId: varchar("tenant_subscription_id")
      .notNull()
      .references(() => tenantSubscriptions.id),
    tenantId: text("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("tse_subscription_created_idx").on(t.tenantSubscriptionId, t.createdAt),
    index("tse_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("tse_event_type_created_idx").on(t.eventType, t.createdAt),
  ],
);

export const insertTenantSubscriptionEventSchema = createInsertSchema(tenantSubscriptionEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertTenantSubscriptionEvent = z.infer<typeof insertTenantSubscriptionEventSchema>;
export type TenantSubscriptionEvent = typeof tenantSubscriptionEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4O — Entitlement Enforcement & Overage Application
// ─────────────────────────────────────────────────────────────────────────────

/**
 * tenant_ai_allowance_usage — canonical AI allowance consumption ledger.
 *
 * One row per ai_billing_usage row (UNIQUE on source_billing_usage_id).
 * Records exactly how much of the AI usage was covered by included plan
 * allowance vs charged as overage. Immutable after insert.
 *
 * Source of truth rules:
 *   - included_amount_usd + overage_amount_usd = customer_price_usd of source row
 *   - Do not recompute from plan entitlements — use ledger for history
 *   - Historical rows must never be updated after creation
 */
export const tenantAiAllowanceUsage = pgTable(
  "tenant_ai_allowance_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    billingPeriodId: text("billing_period_id"),
    sourceBillingUsageId: varchar("source_billing_usage_id").notNull(),
    includedAmountUsd: numeric("included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    overageAmountUsd: numeric("overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    pricingVersion: text("pricing_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("taau_included_check", sql`${t.includedAmountUsd} >= 0`),
    check("taau_overage_check", sql`${t.overageAmountUsd} >= 0`),
    uniqueIndex("taau_source_billing_usage_id_unique").on(t.sourceBillingUsageId),
    index("taau_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("taau_billing_period_idx").on(t.billingPeriodId),
    index("taau_tenant_period_created_idx").on(t.tenantId, t.billingPeriodId, t.createdAt),
  ],
);

export const insertTenantAiAllowanceUsageSchema = createInsertSchema(tenantAiAllowanceUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertTenantAiAllowanceUsage = z.infer<typeof insertTenantAiAllowanceUsageSchema>;
export type TenantAiAllowanceUsage = typeof tenantAiAllowanceUsage.$inferSelect;

/**
 * tenant_storage_allowance_usage — canonical storage allowance consumption ledger.
 *
 * One row per storage_billing_usage row (UNIQUE on source_storage_billing_usage_id).
 * Records exactly how much of the storage billing was covered by included plan
 * allowance vs charged as overage. Immutable after insert.
 */
export const tenantStorageAllowanceUsage = pgTable(
  "tenant_storage_allowance_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    billingPeriodId: text("billing_period_id"),
    sourceStorageBillingUsageId: varchar("source_storage_billing_usage_id").notNull(),
    includedUsageAmount: numeric("included_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    overageUsageAmount: numeric("overage_usage_amount", { precision: 18, scale: 8 }).notNull().default("0"),
    includedAmountUsd: numeric("included_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    overageAmountUsd: numeric("overage_amount_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    pricingVersion: text("pricing_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("tsau_included_usage_check", sql`${t.includedUsageAmount} >= 0`),
    check("tsau_overage_usage_check", sql`${t.overageUsageAmount} >= 0`),
    check("tsau_included_usd_check", sql`${t.includedAmountUsd} >= 0`),
    check("tsau_overage_usd_check", sql`${t.overageAmountUsd} >= 0`),
    uniqueIndex("tsau_source_storage_billing_usage_id_unique").on(t.sourceStorageBillingUsageId),
    index("tsau_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("tsau_billing_period_idx").on(t.billingPeriodId),
    index("tsau_tenant_period_created_idx").on(t.tenantId, t.billingPeriodId, t.createdAt),
  ],
);

export const insertTenantStorageAllowanceUsageSchema = createInsertSchema(tenantStorageAllowanceUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertTenantStorageAllowanceUsage = z.infer<typeof insertTenantStorageAllowanceUsageSchema>;
export type TenantStorageAllowanceUsage = typeof tenantStorageAllowanceUsage.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4P — Admin Pricing & Plan Management System
// ─────────────────────────────────────────────────────────────────────────────

/**
 * admin_change_requests — durable audit log for all admin pricing/plan operations.
 *
 * Every admin operation (preview or apply) in Phase 4P creates a row here.
 * Rows are append-only — never mutate after creation except to update status,
 * applied_result, error_message, and applied_at upon completion.
 *
 * change_type covers all admin-managed commercial operations.
 * status tracks the lifecycle: pending → applied | rejected | failed.
 */
export const adminChangeRequests = pgTable(
  "admin_change_requests",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    changeType: text("change_type").notNull(),
    targetScope: text("target_scope").notNull(),
    targetId: text("target_id"),
    requestedBy: text("requested_by"),
    status: text("status").notNull().default("pending"),
    dryRunSummary: jsonb("dry_run_summary"),
    requestPayload: jsonb("request_payload").notNull(),
    appliedResult: jsonb("applied_result"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    appliedAt: timestamp("applied_at"),
  },
  (t) => [
    check(
      "acr_status_check",
      sql`${t.status} IN ('pending','applied','rejected','failed')`,
    ),
    check(
      "acr_change_type_check",
      sql`${t.changeType} IN (
        'provider_pricing_version_create',
        'customer_pricing_version_create',
        'storage_pricing_version_create',
        'customer_storage_pricing_version_create',
        'subscription_plan_create',
        'plan_entitlement_replace',
        'tenant_subscription_change',
        'tenant_subscription_cancel'
      )`,
    ),
    check(
      "acr_target_scope_check",
      sql`${t.targetScope} IN ('global','tenant','plan')`,
    ),
    index("acr_status_created_idx").on(t.status, t.createdAt),
    index("acr_change_type_created_idx").on(t.changeType, t.createdAt),
    index("acr_target_scope_created_idx").on(t.targetScope, t.createdAt),
    index("acr_target_id_idx").on(t.targetId),
  ],
);

export const insertAdminChangeRequestSchema = createInsertSchema(adminChangeRequests).omit({
  id: true,
  createdAt: true,
});
export type InsertAdminChangeRequest = z.infer<typeof insertAdminChangeRequestSchema>;
export type AdminChangeRequest = typeof adminChangeRequests.$inferSelect;

/**
 * admin_change_events — append-only timeline for admin change request lifecycle.
 *
 * One row per significant state transition or workflow step.
 * Never updated or deleted after creation.
 */
export const adminChangeEvents = pgTable(
  "admin_change_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    adminChangeRequestId: varchar("admin_change_request_id")
      .notNull()
      .references(() => adminChangeRequests.id),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ace_request_created_idx").on(t.adminChangeRequestId, t.createdAt),
    index("ace_event_type_created_idx").on(t.eventType, t.createdAt),
  ],
);

export const insertAdminChangeEventSchema = createInsertSchema(adminChangeEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertAdminChangeEvent = z.infer<typeof insertAdminChangeEventSchema>;
export type AdminChangeEvent = typeof adminChangeEvents.$inferSelect;

// Legacy types kept for compatibility
// ─────────────────────────────────────────────────────────────────────────────
// Phase 4Q — Billing Observability & Monitoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * billing_metrics_snapshots — observability snapshots of billing metrics.
 *
 * These are read-derived summaries of canonical billing tables.
 * They are NOT accounting truth and must never replace canonical tables.
 * snapshot_status='failed' rows are persisted for operational inspection.
 *
 * scope_type determines what the snapshot covers:
 *   'global'         — platform-wide aggregate
 *   'tenant'         — single tenant (scope_id = tenantId)
 *   'billing_period' — single billing period (scope_id = billingPeriodId)
 */
export const billingMetricsSnapshots = pgTable(
  "billing_metrics_snapshots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    metricWindowStart: timestamp("metric_window_start").notNull(),
    metricWindowEnd: timestamp("metric_window_end").notNull(),
    metrics: jsonb("metrics").notNull(),
    snapshotStatus: text("snapshot_status").notNull().default("completed"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "bms_snapshot_status_check",
      sql`${t.snapshotStatus} IN ('started','completed','failed')`,
    ),
    check(
      "bms_window_check",
      sql`${t.metricWindowEnd} > ${t.metricWindowStart}`,
    ),
    check(
      "bms_scope_type_check",
      sql`${t.scopeType} IN ('global','tenant','billing_period')`,
    ),
    index("bms_scope_type_created_idx").on(t.scopeType, t.createdAt),
    index("bms_scope_type_scope_id_created_idx").on(t.scopeType, t.scopeId, t.createdAt),
    index("bms_window_idx").on(t.metricWindowStart, t.metricWindowEnd),
    index("bms_status_created_idx").on(t.snapshotStatus, t.createdAt),
  ],
);

export const insertBillingMetricsSnapshotSchema = createInsertSchema(billingMetricsSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingMetricsSnapshot = z.infer<typeof insertBillingMetricsSnapshotSchema>;
export type BillingMetricsSnapshot = typeof billingMetricsSnapshots.$inferSelect;

/**
 * billing_alerts — operational alert objects for billing anomalies and gaps.
 *
 * These are operational objects — NOT financial truth.
 * alert_key enables deduplication: the same alert class for the same scope
 * is upserted (last_detected_at updated) rather than generating duplicate rows.
 *
 * Status lifecycle:
 *   open → acknowledged (ops aware) → resolved (issue closed) | suppressed (muted)
 *
 * severity:
 *   'critical' — immediate action required
 *   'warning'  — review recommended
 *   'info'     — informational
 */
export const billingAlerts = pgTable(
  "billing_alerts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    alertType: text("alert_type").notNull(),
    severity: text("severity").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    alertKey: text("alert_key").notNull(),
    status: text("status").notNull().default("open"),
    alertMessage: text("alert_message").notNull(),
    details: jsonb("details"),
    firstDetectedAt: timestamp("first_detected_at").notNull().defaultNow(),
    lastDetectedAt: timestamp("last_detected_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "ba_severity_check",
      sql`${t.severity} IN ('info','warning','critical')`,
    ),
    check(
      "ba_status_check",
      sql`${t.status} IN ('open','acknowledged','resolved','suppressed')`,
    ),
    check(
      "ba_scope_type_check",
      sql`${t.scopeType} IN ('global','tenant','billing_period','invoice','payment')`,
    ),
    index("ba_status_severity_created_idx").on(t.status, t.severity, t.createdAt),
    index("ba_scope_type_scope_id_created_idx").on(t.scopeType, t.scopeId, t.createdAt),
    index("ba_alert_type_created_idx").on(t.alertType, t.createdAt),
    index("ba_alert_key_status_idx").on(t.alertKey, t.status),
  ],
);

export const insertBillingAlertSchema = createInsertSchema(billingAlerts).omit({
  id: true,
  createdAt: true,
  firstDetectedAt: true,
  lastDetectedAt: true,
  resolvedAt: true,
});
export type InsertBillingAlert = z.infer<typeof insertBillingAlertSchema>;
export type BillingAlert = typeof billingAlerts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4R — Automated Billing Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * billing_job_definitions — durable catalog of automated billing jobs.
 *
 * Each row defines one logical recurring operation the platform can execute.
 * Definitions are the configuration authority — job_runs records the execution history.
 *
 * Design rules:
 *   - singleton_mode=true → only one active run per job at a time
 *   - schedule_expression is null for manual-only jobs
 *   - archived definitions are preserved for history; their runs are retained
 *   - job_key must be globally unique — it is the stable identity across deploys
 *
 * job_category:
 *   'snapshot'        — billing metrics snapshot jobs
 *   'monitoring'      — health monitoring scans
 *   'anomaly'         — anomaly detection sweeps
 *   'reconciliation'  — provider reconciliation runs
 *   'audit'           — billing audit runs
 *   'payment'         — payment health checks
 *   'maintenance'     — operational maintenance tasks
 *
 * schedule_type:
 *   'manual'   — triggered only via admin/API
 *   'interval' — run every N seconds (schedule_expression = "3600")
 *   'cron'     — run on cron expression (schedule_expression = "0 * * * *")
 */
export const billingJobDefinitions = pgTable(
  "billing_job_definitions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    jobKey: text("job_key").notNull(),
    jobName: text("job_name").notNull(),
    jobCategory: text("job_category").notNull(),
    status: text("status").notNull().default("active"),
    scheduleType: text("schedule_type").notNull().default("manual"),
    scheduleExpression: text("schedule_expression"),
    singletonMode: boolean("singleton_mode").notNull().default(true),
    retryLimit: integer("retry_limit").notNull().default(3),
    timeoutSeconds: integer("timeout_seconds").notNull().default(300),
    /**
     * Phase 4S (4R hardening): scheduling priority for this job.
     * Lower number = higher priority. Default 5 = normal priority.
     * Intended ordering: 1=critical, 3=high, 5=normal, 7=low, 9=background.
     * Not yet enforced by scheduler — recorded for future priority-based queuing.
     */
    priority: integer("priority").notNull().default(5),
    /**
     * Phase 4S (4R hardening): duration warning threshold in milliseconds.
     * If a run's duration_ms exceeds this value, it is flagged as slow.
     * null = no warning threshold configured.
     */
    jobDurationWarningMs: integer("job_duration_warning_ms"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "bjd_job_category_check",
      sql`${t.jobCategory} IN ('snapshot','monitoring','anomaly','reconciliation','audit','payment','maintenance')`,
    ),
    check(
      "bjd_status_check",
      sql`${t.status} IN ('active','paused','archived')`,
    ),
    check(
      "bjd_schedule_type_check",
      sql`${t.scheduleType} IN ('manual','interval','cron')`,
    ),
    check("bjd_retry_limit_check", sql`${t.retryLimit} >= 0`),
    check("bjd_timeout_seconds_check", sql`${t.timeoutSeconds} > 0`),
    check("bjd_priority_check", sql`${t.priority} >= 1 AND ${t.priority} <= 10`),
    check(
      "bjd_job_duration_warning_ms_check",
      sql`${t.jobDurationWarningMs} IS NULL OR ${t.jobDurationWarningMs} > 0`,
    ),
    uniqueIndex("bjd_job_key_unique").on(t.jobKey),
    index("bjd_status_created_idx").on(t.status, t.createdAt),
    index("bjd_category_created_idx").on(t.jobCategory, t.createdAt),
  ],
);

export const insertBillingJobDefinitionSchema = createInsertSchema(billingJobDefinitions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBillingJobDefinition = z.infer<typeof insertBillingJobDefinitionSchema>;
export type BillingJobDefinition = typeof billingJobDefinitions.$inferSelect;

/**
 * billing_job_runs — durable execution log for all automated billing jobs.
 *
 * Every job invocation creates one row here — success, failure, or skip.
 * This is the operational audit trail. NOT accounting truth.
 *
 * Design rules:
 *   - Rows are append-only; completed/failed rows are never mutated
 *   - duration_ms is recorded on completion
 *   - lock_acquired records whether singleton exclusivity was obtained
 *   - result_summary is a structured JSONB (not raw payloads)
 *   - skipped rows indicate a safe no-op (lock contention or already-up-to-date)
 *
 * run_status lifecycle: started → completed | failed | timed_out | skipped
 *
 * trigger_type:
 *   'manual'    — triggered via admin API or CLI
 *   'scheduled' — triggered by scheduler/cron
 *   'retry'     — triggered as a retry of a prior failed run
 *   'system'    — triggered internally by platform logic
 */
export const billingJobRuns = pgTable(
  "billing_job_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    billingJobDefinitionId: varchar("billing_job_definition_id")
      .notNull()
      .references(() => billingJobDefinitions.id),
    jobKey: text("job_key").notNull(),
    triggerType: text("trigger_type").notNull(),
    runStatus: text("run_status").notNull().default("started"),
    scopeType: text("scope_type"),
    scopeId: text("scope_id"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    durationMs: integer("duration_ms"),
    lockAcquired: boolean("lock_acquired").notNull().default(false),
    resultSummary: jsonb("result_summary"),
    errorMessage: text("error_message"),
    /**
     * Phase 4S (4R hardening): identifier of the worker/node that executed this run.
     * Null for runs created before this field was added.
     * Useful for distributed debugging and diagnosing per-instance failure patterns.
     */
    workerId: text("worker_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "bjr_trigger_type_check",
      sql`${t.triggerType} IN ('manual','scheduled','retry','system')`,
    ),
    check(
      "bjr_run_status_check",
      sql`${t.runStatus} IN ('started','completed','failed','timed_out','skipped')`,
    ),
    check("bjr_attempt_number_check", sql`${t.attemptNumber} > 0`),
    check(
      "bjr_duration_ms_check",
      sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`,
    ),
    check(
      "bjr_scope_type_check",
      sql`${t.scopeType} IS NULL OR ${t.scopeType} IN ('global','tenant','billing_period')`,
    ),
    index("bjr_job_key_created_idx").on(t.jobKey, t.createdAt),
    index("bjr_run_status_created_idx").on(t.runStatus, t.createdAt),
    index("bjr_definition_created_idx").on(t.billingJobDefinitionId, t.createdAt),
    index("bjr_scope_created_idx").on(t.scopeType, t.scopeId, t.createdAt),
    index("bjr_started_at_idx").on(t.startedAt),
  ],
);

export const insertBillingJobRunSchema = createInsertSchema(billingJobRuns).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  durationMs: true,
  startedAt: true,
});
export type InsertBillingJobRun = z.infer<typeof insertBillingJobRunSchema>;
export type BillingJobRun = typeof billingJobRuns.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4S — Billing Recovery, Integrity & Disaster Safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * billing_recovery_runs — durable audit log for all billing recovery operations.
 *
 * Every recovery attempt (dry-run or apply) creates one row here.
 * This is the operational audit trail for the recovery layer. NOT accounting truth.
 *
 * Design rules:
 *   - Append-only for core financial values; status/result_summary/error_message updateable
 *   - dry_run=true runs must never modify billing canonical truth
 *   - Every apply run must create billing_recovery_actions rows
 *   - Recovery must be idempotent — repeated runs create new rows, not duplicates in target
 *
 * recovery_type values:
 *   'billing_usage_rebuild'          — rebuild missing ai_billing_usage rows
 *   'storage_billing_rebuild'        — rebuild missing storage_billing_usage rows
 *   'billing_snapshot_rebuild'       — rebuild billing_period_tenant_snapshots
 *   'invoice_line_items_rebuild'     — rebuild invoice line items for non-finalized invoices
 *   'invoice_totals_rebuild'         — recalculate invoice subtotal/total
 *   'payment_linkage_repair'         — repair invoice/payment linkage anomalies
 *   'stripe_linkage_repair'          — repair stripe invoice link anomalies
 *   'allowance_rebuild'              — rebuild allowance rows where deterministic
 *   'monitoring_snapshot_rebuild'    — rebuild billing_metrics_snapshots
 */
export const billingRecoveryRuns = pgTable(
  "billing_recovery_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    recoveryType: text("recovery_type").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    status: text("status").notNull().default("started"),
    triggerType: text("trigger_type").notNull(),
    reason: text("reason").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    resultSummary: jsonb("result_summary"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "brr_recovery_type_check",
      sql`${t.recoveryType} IN ('billing_usage_rebuild','storage_billing_rebuild','billing_snapshot_rebuild','invoice_line_items_rebuild','invoice_totals_rebuild','payment_linkage_repair','stripe_linkage_repair','allowance_rebuild','monitoring_snapshot_rebuild')`,
    ),
    check(
      "brr_scope_type_check",
      sql`${t.scopeType} IN ('global','tenant','billing_period','invoice','payment','usage_row')`,
    ),
    check(
      "brr_status_check",
      sql`${t.status} IN ('started','completed','failed','skipped')`,
    ),
    check(
      "brr_trigger_type_check",
      sql`${t.triggerType} IN ('manual','job','system')`,
    ),
    index("brr_recovery_type_created_idx").on(t.recoveryType, t.createdAt),
    index("brr_scope_created_idx").on(t.scopeType, t.scopeId, t.createdAt),
    index("brr_status_created_idx").on(t.status, t.createdAt),
    index("brr_started_at_idx").on(t.startedAt),
  ],
);

export const insertBillingRecoveryRunSchema = createInsertSchema(billingRecoveryRuns).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  startedAt: true,
});
export type InsertBillingRecoveryRun = z.infer<typeof insertBillingRecoveryRunSchema>;
export type BillingRecoveryRun = typeof billingRecoveryRuns.$inferSelect;

/**
 * billing_recovery_actions — detailed action log for each recovery operation step.
 *
 * Each billing_recovery_runs row may produce 0..N action rows — one per planned/executed action.
 * Append-only: never mutate after creation.
 *
 * Design rules:
 *   - before_state and after_state are concise structured diffs, not raw row dumps
 *   - action_status tracks planned → executed | skipped | failed
 *   - For dry_run=true runs, all actions should be 'planned' (never 'executed')
 *
 * action_status lifecycle:
 *   'planned'  — would be executed (dry-run or pre-apply preview)
 *   'executed' — was applied to the database
 *   'skipped'  — safe no-op (already in correct state, or unsafe to apply)
 *   'failed'   — attempted but failed (error recorded in details)
 */
export const billingRecoveryActions = pgTable(
  "billing_recovery_actions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    billingRecoveryRunId: varchar("billing_recovery_run_id")
      .notNull()
      .references(() => billingRecoveryRuns.id),
    actionType: text("action_type").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: text("target_id"),
    actionStatus: text("action_status").notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "bra_action_status_check",
      sql`${t.actionStatus} IN ('planned','executed','skipped','failed')`,
    ),
    index("bra_run_created_idx").on(t.billingRecoveryRunId, t.createdAt),
    index("bra_target_table_created_idx").on(t.targetTable, t.createdAt),
    index("bra_action_status_created_idx").on(t.actionStatus, t.createdAt),
  ],
);

export const insertBillingRecoveryActionSchema = createInsertSchema(billingRecoveryActions).omit({
  id: true,
  createdAt: true,
});
export type InsertBillingRecoveryAction = z.infer<typeof insertBillingRecoveryActionSchema>;
export type BillingRecoveryAction = typeof billingRecoveryActions.$inferSelect;

// ── Phase 5P — Answer Grounding & Citations ───────────────────────────────────

export const knowledgeAnswerRuns = pgTable(
  "knowledge_answer_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    retrievalRunId: varchar("retrieval_run_id"),
    answerText: text("answer_text").notNull(),
    generationModel: text("generation_model").notNull(),
    generationLatencyMs: integer("generation_latency_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    contextChunkCount: integer("context_chunk_count"),
    fallbackUsed: boolean("fallback_used").default(false),
    fallbackReason: text("fallback_reason"),
    rerankLatencyMs: integer("rerank_latency_ms"),
    shortlistSize: integer("shortlist_size"),
    rerankProviderLatencyMs: integer("rerank_provider_latency_ms"),
    rerankProviderCostUsd: numeric("rerank_provider_cost_usd", { precision: 10, scale: 8 }),
    advancedRerankUsed: boolean("advanced_rerank_used").default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // ── Phase 5Q — Quality & safety context ─────────────────────────────────
    retrievalConfidenceBand: text("retrieval_confidence_band"),
    retrievalSafetyStatus: text("retrieval_safety_status"),
    rewriteStrategyUsed: text("rewrite_strategy_used"),
    safetyFlagCount: integer("safety_flag_count"),
    // ── Phase 5R — Answer verification ───────────────────────────────────────
    groundingConfidenceScore: numeric("grounding_confidence_score", { precision: 10, scale: 6 }),
    groundingConfidenceBand: text("grounding_confidence_band"),
    citationCoverageRatio: numeric("citation_coverage_ratio", { precision: 10, scale: 6 }),
    supportedClaimCount: integer("supported_claim_count"),
    partiallySupportedClaimCount: integer("partially_supported_claim_count"),
    unsupportedClaimCount: integer("unsupported_claim_count"),
    unverifiableClaimCount: integer("unverifiable_claim_count"),
    answerSafetyStatus: text("answer_safety_status"),
    answerPolicyResult: text("answer_policy_result"),
    answerVerificationLatencyMs: integer("answer_verification_latency_ms"),
  },
  (t) => [
    index("kar_tenant_run_idx").on(t.tenantId, t.retrievalRunId),
    index("kar_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertKnowledgeAnswerRunSchema = createInsertSchema(knowledgeAnswerRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeAnswerRun = z.infer<typeof insertKnowledgeAnswerRunSchema>;
export type KnowledgeAnswerRun = typeof knowledgeAnswerRuns.$inferSelect;

export const knowledgeAnswerCitations = pgTable(
  "knowledge_answer_citations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    answerRunId: varchar("answer_run_id").notNull().references(() => knowledgeAnswerRuns.id),
    tenantId: text("tenant_id").notNull(),
    chunkId: varchar("chunk_id"),
    documentId: varchar("document_id"),
    assetId: varchar("asset_id"),
    citationIndex: integer("citation_index").notNull(),
    contextPosition: integer("context_position"),
    chunkTextPreview: text("chunk_text_preview"),
    sourceUri: text("source_uri"),
    finalScore: numeric("final_score", { precision: 10, scale: 8 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("kac_answer_run_idx").on(t.answerRunId),
    index("kac_tenant_idx").on(t.tenantId),
    index("kac_chunk_idx").on(t.chunkId),
  ],
);

export const insertKnowledgeAnswerCitationSchema = createInsertSchema(knowledgeAnswerCitations).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeAnswerCitation = z.infer<typeof insertKnowledgeAnswerCitationSchema>;
export type KnowledgeAnswerCitation = typeof knowledgeAnswerCitations.$inferSelect;

// ── Phase 5Q — Retrieval Quality Signals ─────────────────────────────────────

export const knowledgeRetrievalQualitySignals = pgTable(
  "knowledge_retrieval_quality_signals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    retrievalRunId: varchar("retrieval_run_id"),
    confidenceBand: text("confidence_band"),
    sourceDiversityScore: numeric("source_diversity_score", { precision: 6, scale: 4 }),
    documentDiversityScore: numeric("document_diversity_score", { precision: 6, scale: 4 }),
    contextRedundancyScore: numeric("context_redundancy_score", { precision: 6, scale: 4 }),
    safetyStatus: text("safety_status"),
    flaggedChunkCount: integer("flagged_chunk_count"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("krqs_tenant_run_idx").on(t.tenantId, t.retrievalRunId),
    index("krqs_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertKnowledgeRetrievalQualitySignalSchema = createInsertSchema(knowledgeRetrievalQualitySignals).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeRetrievalQualitySignal = z.infer<typeof insertKnowledgeRetrievalQualitySignalSchema>;
export type KnowledgeRetrievalQualitySignal = typeof knowledgeRetrievalQualitySignals.$inferSelect;

// ── Phase 5S — Retrieval Feedback Loop ────────────────────────────────────────

export const knowledgeRetrievalFeedback = pgTable(
  "knowledge_retrieval_feedback",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    retrievalRunId: varchar("retrieval_run_id").notNull(),
    answerRunId: varchar("answer_run_id"),
    feedbackStatus: text("feedback_status").notNull(),
    retrievalQualityBand: text("retrieval_quality_band").notNull(),
    rerankEffectivenessBand: text("rerank_effectiveness_band").notNull(),
    citationQualityBand: text("citation_quality_band").notNull(),
    rewriteEffectivenessBand: text("rewrite_effectiveness_band").notNull(),
    answerSafetyBand: text("answer_safety_band").notNull(),
    dominantFailureMode: text("dominant_failure_mode"),
    tuningSignals: jsonb("tuning_signals").notNull().default(sql`'[]'::jsonb`),
    notes: jsonb("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("krf_tenant_run_idx").on(t.tenantId, t.retrievalRunId),
    index("krf_tenant_answer_idx").on(t.tenantId, t.answerRunId),
    index("krf_tenant_status_idx").on(t.tenantId, t.feedbackStatus),
    index("krf_tenant_quality_idx").on(t.tenantId, t.retrievalQualityBand),
    index("krf_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertKnowledgeRetrievalFeedbackSchema = createInsertSchema(knowledgeRetrievalFeedback).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeRetrievalFeedback = z.infer<typeof insertKnowledgeRetrievalFeedbackSchema>;
export type KnowledgeRetrievalFeedback = typeof knowledgeRetrievalFeedback.$inferSelect;

// Legacy types kept for compatibility
export const users = profiles;
export const insertUserSchema = createInsertSchema(profiles).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof profiles.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Identity, RBAC & Actor Governance Foundation
// ─────────────────────────────────────────────────────────────────────────────

// ─── 6.1 app_user_profiles ───────────────────────────────────────────────────
// Canonical application-level user profile (auth identity metadata, not auth.users).
export const appUserProfiles = pgTable(
  "app_user_profiles",
  {
    id: varchar("id").primaryKey(), // corresponds to Supabase auth.users.id
    email: text("email"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata"),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("aup_status_created_idx").on(t.status, t.createdAt),
    index("aup_email_idx").on(t.email),
    check("aup_status_check", sql`status IN ('active','suspended','disabled')`),
  ],
);
export const insertAppUserProfileSchema = createInsertSchema(appUserProfiles).omit({ createdAt: true, updatedAt: true });
export type InsertAppUserProfile = z.infer<typeof insertAppUserProfileSchema>;
export type AppUserProfile = typeof appUserProfiles.$inferSelect;

// ─── 6.2 tenant_memberships ──────────────────────────────────────────────────
export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    userId: varchar("user_id").notNull().references(() => appUserProfiles.id),
    membershipStatus: text("membership_status").notNull().default("active"),
    joinedAt: timestamp("joined_at"),
    invitedAt: timestamp("invited_at"),
    invitedBy: varchar("invited_by").references(() => appUserProfiles.id),
    suspendedAt: timestamp("suspended_at"),
    removedAt: timestamp("removed_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tm_tenant_user_idx").on(t.tenantId, t.userId),
    index("tm_tenant_status_created_idx").on(t.tenantId, t.membershipStatus, t.createdAt),
    index("tm_user_status_created_idx").on(t.userId, t.membershipStatus, t.createdAt),
    check("tm_status_check", sql`membership_status IN ('invited','active','suspended','removed')`),
  ],
);
export const insertTenantMembershipSchema = createInsertSchema(tenantMemberships).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenantMembership = z.infer<typeof insertTenantMembershipSchema>;
export type TenantMembership = typeof tenantMemberships.$inferSelect;

// ─── 6.3 roles ───────────────────────────────────────────────────────────────
export const roles = pgTable(
  "roles",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id"),
    roleCode: text("role_code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystemRole: boolean("is_system_role").notNull().default(false),
    roleScope: text("role_scope").notNull().default("tenant"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    metadata: jsonb("metadata"),
    createdBy: varchar("created_by").references(() => appUserProfiles.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roles_scope_tenant_code_idx").on(t.roleScope, t.tenantId, t.roleCode),
    index("roles_tenant_lifecycle_created_idx").on(t.tenantId, t.lifecycleState, t.createdAt),
    index("roles_scope_code_idx").on(t.roleScope, t.roleCode),
    check("roles_scope_check", sql`role_scope IN ('system','tenant')`),
    check("roles_lifecycle_check", sql`lifecycle_state IN ('active','archived','disabled')`),
  ],
);
export const insertRoleSchema = createInsertSchema(roles).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof roles.$inferSelect;

// ─── 6.4 permissions ─────────────────────────────────────────────────────────
export const permissions = pgTable(
  "permissions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    permissionCode: text("permission_code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    permissionDomain: text("permission_domain").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("permissions_code_idx").on(t.permissionCode),
    index("permissions_domain_created_idx").on(t.permissionDomain, t.createdAt),
    index("permissions_lifecycle_created_idx").on(t.lifecycleState, t.createdAt),
    check("permissions_lifecycle_check", sql`lifecycle_state IN ('active','archived')`),
  ],
);
export const insertPermissionSchema = createInsertSchema(permissions).omit({ id: true, createdAt: true });
export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissions.$inferSelect;

// ─── 6.5 role_permissions ────────────────────────────────────────────────────
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    roleId: varchar("role_id").notNull().references(() => roles.id),
    permissionId: varchar("permission_id").notNull().references(() => permissions.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rp_role_perm_idx").on(t.roleId, t.permissionId),
    index("rp_role_created_idx").on(t.roleId, t.createdAt),
    index("rp_perm_created_idx").on(t.permissionId, t.createdAt),
  ],
);
export const insertRolePermissionSchema = createInsertSchema(rolePermissions).omit({ id: true, createdAt: true });
export type InsertRolePermission = z.infer<typeof insertRolePermissionSchema>;
export type RolePermission = typeof rolePermissions.$inferSelect;

// ─── 6.6 membership_roles ────────────────────────────────────────────────────
export const membershipRoles = pgTable(
  "membership_roles",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantMembershipId: varchar("tenant_membership_id").notNull().references(() => tenantMemberships.id),
    roleId: varchar("role_id").notNull().references(() => roles.id),
    assignedBy: varchar("assigned_by").references(() => appUserProfiles.id),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
    metadata: jsonb("metadata"),
  },
  (t) => [
    uniqueIndex("mr_membership_role_idx").on(t.tenantMembershipId, t.roleId),
    index("mr_membership_assigned_idx").on(t.tenantMembershipId, t.assignedAt),
    index("mr_role_assigned_idx").on(t.roleId, t.assignedAt),
  ],
);
export const insertMembershipRoleSchema = createInsertSchema(membershipRoles).omit({ id: true, assignedAt: true });
export type InsertMembershipRole = z.infer<typeof insertMembershipRoleSchema>;
export type MembershipRole = typeof membershipRoles.$inferSelect;

// ─── 6.7 service_accounts ────────────────────────────────────────────────────
export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    serviceAccountStatus: text("service_account_status").notNull().default("active"),
    createdBy: varchar("created_by").references(() => appUserProfiles.id),
    revokedAt: timestamp("revoked_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("sa_tenant_status_created_idx").on(t.tenantId, t.serviceAccountStatus, t.createdAt),
    check("sa_status_check", sql`service_account_status IN ('active','revoked','disabled')`),
  ],
);
export const insertServiceAccountSchema = createInsertSchema(serviceAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertServiceAccount = z.infer<typeof insertServiceAccountSchema>;
export type ServiceAccount = typeof serviceAccounts.$inferSelect;

// ─── 6.8 service_account_keys ────────────────────────────────────────────────
export const serviceAccountKeys = pgTable(
  "service_account_keys",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    serviceAccountId: varchar("service_account_id").notNull().references(() => serviceAccounts.id),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    keyStatus: text("key_status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    createdBy: varchar("created_by").references(() => appUserProfiles.id),
    revokedAt: timestamp("revoked_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sak_prefix_idx").on(t.keyPrefix),
    uniqueIndex("sak_hash_idx").on(t.keyHash),
    index("sak_sa_status_created_idx").on(t.serviceAccountId, t.keyStatus, t.createdAt),
    index("sak_expires_idx").on(t.expiresAt),
    check("sak_status_check", sql`key_status IN ('active','revoked','expired')`),
  ],
);
export const insertServiceAccountKeySchema = createInsertSchema(serviceAccountKeys).omit({ id: true, createdAt: true });
export type InsertServiceAccountKey = z.infer<typeof insertServiceAccountKeySchema>;
export type ServiceAccountKey = typeof serviceAccountKeys.$inferSelect;

// ─── 6.9 api_keys ────────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    apiKeyStatus: text("api_key_status").notNull().default("active"),
    createdBy: varchar("created_by").references(() => appUserProfiles.id),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ak_prefix_idx").on(t.keyPrefix),
    uniqueIndex("ak_hash_idx").on(t.keyHash),
    index("ak_tenant_status_created_idx").on(t.tenantId, t.apiKeyStatus, t.createdAt),
    index("ak_expires_idx").on(t.expiresAt),
    check("ak_status_check", sql`api_key_status IN ('active','revoked','expired')`),
  ],
);
export const insertApiKeySchema = createInsertSchema(apiKeys).omit({ id: true, createdAt: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

// ─── 6.10 api_key_scopes ─────────────────────────────────────────────────────
export const apiKeyScopes = pgTable(
  "api_key_scopes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    apiKeyId: varchar("api_key_id").notNull().references(() => apiKeys.id),
    permissionId: varchar("permission_id").notNull().references(() => permissions.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("aks_key_perm_idx").on(t.apiKeyId, t.permissionId),
    index("aks_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("aks_perm_created_idx").on(t.permissionId, t.createdAt),
  ],
);
export const insertApiKeyScopeSchema = createInsertSchema(apiKeyScopes).omit({ id: true, createdAt: true });
export type InsertApiKeyScope = z.infer<typeof insertApiKeyScopeSchema>;
export type ApiKeyScope = typeof apiKeyScopes.$inferSelect;

// ─── 6.11 identity_providers ─────────────────────────────────────────────────
export const identityProviders = pgTable(
  "identity_providers",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    providerType: text("provider_type").notNull(),
    providerStatus: text("provider_status").notNull().default("draft"),
    displayName: text("display_name").notNull(),
    issuer: text("issuer"),
    audience: text("audience"),
    metadata: jsonb("metadata"),
    createdBy: varchar("created_by").references(() => appUserProfiles.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("idp_tenant_status_created_idx").on(t.tenantId, t.providerStatus, t.createdAt),
    index("idp_tenant_type_created_idx").on(t.tenantId, t.providerType, t.createdAt),
    check("idp_type_check", sql`provider_type IN ('oidc','saml','google_workspace','azure_ad')`),
    check("idp_status_check", sql`provider_status IN ('draft','active','disabled')`),
  ],
);
export const insertIdentityProviderSchema = createInsertSchema(identityProviders).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIdentityProvider = z.infer<typeof insertIdentityProviderSchema>;
export type IdentityProvider = typeof identityProviders.$inferSelect;

// ─── 6.12 tenant_invitations ─────────────────────────────────────────────────
export const tenantInvitations = pgTable(
  "tenant_invitations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    invitationStatus: text("invitation_status").notNull().default("pending"),
    invitedBy: varchar("invited_by").references(() => appUserProfiles.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ti_token_hash_idx").on(t.tokenHash),
    index("ti_tenant_status_created_idx").on(t.tenantId, t.invitationStatus, t.createdAt),
    index("ti_email_created_idx").on(t.email, t.createdAt),
    index("ti_expires_idx").on(t.expiresAt),
    check("ti_status_check", sql`invitation_status IN ('pending','accepted','expired','revoked')`),
  ],
);
export const insertTenantInvitationSchema = createInsertSchema(tenantInvitations).omit({ id: true, createdAt: true });
export type InsertTenantInvitation = z.infer<typeof insertTenantInvitationSchema>;
export type TenantInvitation = typeof tenantInvitations.$inferSelect;

// ─── 13.2 security_events (extends Phase 7 table) ───────────────────────────
// The security_events table already exists from Phase 7 (session_created,
// session_revoked, login_failed, login_success). Phase 13.2 adds operational
// security signals (rate limiting, tenant violations, payload abuse, etc.)
// while preserving full backward compatibility with Phase 7 event types.

export const securityEvents = pgTable(
  "security_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id"),
    // Phase 7 legacy: user_id; Phase 13.2: actor_id (both kept for compat)
    userId: text("user_id"),
    actorId: text("actor_id"),
    eventType: text("event_type").notNull(),
    // Phase 7 legacy: ip_address; Phase 13.2: ip (both kept for compat)
    ipAddress: text("ip_address"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("se_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("se_event_type_created_idx").on(t.eventType, t.createdAt),
    index("se_request_id_idx").on(t.requestId),
  ],
);
export const insertSecurityEventSchema = createInsertSchema(securityEvents).omit({ id: true, createdAt: true });
export type InsertSecurityEvent = z.infer<typeof insertSecurityEventSchema>;
export type SecurityEvent = typeof securityEvents.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 15 — OBSERVABILITY & TELEMETRY PLATFORM
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 15.1 obs_system_metrics ─────────────────────────────────────────────────
// Platform-wide health signals. Append-only, non-tenant-scoped.

export const obsSystemMetrics = pgTable(
  "obs_system_metrics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    metricType: text("metric_type").notNull(),
    value: numeric("value", { precision: 20, scale: 6 }).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("osm_type_created_idx").on(t.metricType, t.createdAt),
  ],
);
export const insertObsSystemMetricsSchema = createInsertSchema(obsSystemMetrics).omit({ id: true, createdAt: true });
export type InsertObsSystemMetric = z.infer<typeof insertObsSystemMetricsSchema>;
export type ObsSystemMetric = typeof obsSystemMetrics.$inferSelect;

// ─── 15.2 obs_ai_latency_metrics ─────────────────────────────────────────────
// Per-LLM-call latency, token, and cost telemetry. Append-only, tenant-scoped.

export const obsAiLatencyMetrics = pgTable(
  "obs_ai_latency_metrics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd", { precision: 20, scale: 10 }),
    requestId: text("request_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("oalm_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("oalm_provider_model_idx").on(t.provider, t.model, t.createdAt),
    index("oalm_request_id_idx").on(t.requestId),
  ],
);
export const insertObsAiLatencyMetricsSchema = createInsertSchema(obsAiLatencyMetrics).omit({ id: true, createdAt: true });
export type InsertObsAiLatencyMetric = z.infer<typeof insertObsAiLatencyMetricsSchema>;
export type ObsAiLatencyMetric = typeof obsAiLatencyMetrics.$inferSelect;

// ─── 15.3 obs_retrieval_metrics ──────────────────────────────────────────────
// Phase 15 observability-layer retrieval signals. Append-only, tenant-scoped.
// (Separate from Phase 5F retrieval_metrics which tracks full retrieval runs.)

export const obsRetrievalMetrics = pgTable(
  "obs_retrieval_metrics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id"),
    queryLength: integer("query_length"),
    chunksRetrieved: integer("chunks_retrieved"),
    rerankUsed: boolean("rerank_used").default(false),
    latencyMs: integer("latency_ms"),
    resultCount: integer("result_count"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("orm_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);
export const insertObsRetrievalMetricsSchema = createInsertSchema(obsRetrievalMetrics).omit({ id: true, createdAt: true });
export type InsertObsRetrievalMetric = z.infer<typeof insertObsRetrievalMetricsSchema>;
export type ObsRetrievalMetric = typeof obsRetrievalMetrics.$inferSelect;

// ─── 15.4 obs_agent_runtime_metrics ──────────────────────────────────────────
// Per-run agent execution telemetry. Append-only, tenant-scoped.

export const obsAgentRuntimeMetrics = pgTable(
  "obs_agent_runtime_metrics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    steps: integer("steps"),
    iterations: integer("iterations"),
    durationMs: integer("duration_ms"),
    status: text("status"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("oarm_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("oarm_run_id_idx").on(t.runId),
  ],
);
export const insertObsAgentRuntimeMetricsSchema = createInsertSchema(obsAgentRuntimeMetrics).omit({ id: true, createdAt: true });
export type InsertObsAgentRuntimeMetric = z.infer<typeof insertObsAgentRuntimeMetricsSchema>;
export type ObsAgentRuntimeMetric = typeof obsAgentRuntimeMetrics.$inferSelect;

// ─── 15.5 obs_tenant_usage_metrics ───────────────────────────────────────────
// Tenant-level usage aggregation by metric type and period. Append-only.

export const obsTenantUsageMetrics = pgTable(
  "obs_tenant_usage_metrics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    metricType: text("metric_type").notNull(),
    value: numeric("value", { precision: 20, scale: 6 }).notNull(),
    period: text("period").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("otum_tenant_type_period_idx").on(t.tenantId, t.metricType, t.period),
    index("otum_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);
export const insertObsTenantUsageMetricsSchema = createInsertSchema(obsTenantUsageMetrics).omit({ id: true, createdAt: true });
export type InsertObsTenantUsageMetric = z.infer<typeof insertObsTenantUsageMetricsSchema>;
export type ObsTenantUsageMetric = typeof obsTenantUsageMetrics.$inferSelect;
