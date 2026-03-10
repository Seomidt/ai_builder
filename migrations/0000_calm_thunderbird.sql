CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."arch_profile_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('github', 'openai', 'vercel', 'supabase', 'cloudflare');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('manual', 'github', 'url');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."org_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "ai_approvals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"step_id" varchar,
	"requested_by" varchar NOT NULL,
	"approved_by" varchar,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ai_artifacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"step_id" varchar,
	"artifact_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"content" text,
	"path" text,
	"version" text,
	"tags" text[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"project_id" varchar NOT NULL,
	"architecture_profile_id" varchar NOT NULL,
	"architecture_version_id" varchar NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"goal" text,
	"pipeline_version" text,
	"created_by" varchar NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_steps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"step_key" text NOT NULL,
	"title" text,
	"description" text,
	"tags" text[],
	"agent_key" text NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"step_id" varchar,
	"tool_name" text NOT NULL,
	"tool_version" text,
	"input" jsonb,
	"output" jsonb,
	"status" "tool_call_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"executed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "architecture_agent_configs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" varchar NOT NULL,
	"agent_key" text NOT NULL,
	"execution_order" integer DEFAULT 0 NOT NULL,
	"model_key" text,
	"prompt_version" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb
);
--> statement-breakpoint
CREATE TABLE "architecture_capability_configs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" varchar NOT NULL,
	"capability_key" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "architecture_policy_bindings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" varchar NOT NULL,
	"policy_key" text NOT NULL,
	"policy_config" jsonb
);
--> statement-breakpoint
CREATE TABLE "architecture_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text,
	"status" "arch_profile_status" DEFAULT 'active' NOT NULL,
	"current_version_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "architecture_template_bindings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" varchar NOT NULL,
	"template_key" text NOT NULL,
	"template_ref" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "architecture_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"architecture_profile_id" varchar NOT NULL,
	"version_number" text NOT NULL,
	"workflow_key" text,
	"config" jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'inactive' NOT NULL,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"project_id" varchar,
	"title" text NOT NULL,
	"source_type" "knowledge_source_type" DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"content_hash" text,
	"status" "knowledge_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"role" "org_member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_secrets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" varchar PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_by" varchar NOT NULL,
	"github_owner" text,
	"github_repo" text,
	"github_default_branch" text DEFAULT 'main',
	"github_repo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_step_id_ai_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."ai_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_step_id_ai_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."ai_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_architecture_profile_id_architecture_profiles_id_fk" FOREIGN KEY ("architecture_profile_id") REFERENCES "public"."architecture_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_architecture_version_id_architecture_versions_id_fk" FOREIGN KEY ("architecture_version_id") REFERENCES "public"."architecture_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_steps" ADD CONSTRAINT "ai_steps_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_step_id_ai_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."ai_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_agent_configs" ADD CONSTRAINT "architecture_agent_configs_version_id_architecture_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."architecture_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_capability_configs" ADD CONSTRAINT "architecture_capability_configs_version_id_architecture_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."architecture_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_policy_bindings" ADD CONSTRAINT "architecture_policy_bindings_version_id_architecture_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."architecture_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_profiles" ADD CONSTRAINT "architecture_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_template_bindings" ADD CONSTRAINT "architecture_template_bindings_version_id_architecture_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."architecture_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_versions" ADD CONSTRAINT "architecture_versions_architecture_profile_id_architecture_profiles_id_fk" FOREIGN KEY ("architecture_profile_id") REFERENCES "public"."architecture_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_secrets" ADD CONSTRAINT "organization_secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_approvals_run_idx" ON "ai_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_approvals_status_idx" ON "ai_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_artifacts_run_idx" ON "ai_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_artifacts_type_idx" ON "ai_artifacts" USING btree ("artifact_type");--> statement-breakpoint
CREATE INDEX "ai_runs_org_idx" ON "ai_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_runs_project_idx" ON "ai_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_runs_status_idx" ON "ai_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_runs_arch_profile_idx" ON "ai_runs" USING btree ("architecture_profile_id");--> statement-breakpoint
CREATE INDEX "ai_steps_run_idx" ON "ai_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_run_idx" ON "ai_tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_tool_idx" ON "ai_tool_calls" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "agent_configs_version_idx" ON "architecture_agent_configs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_version_key_idx" ON "architecture_agent_configs" USING btree ("version_id","agent_key");--> statement-breakpoint
CREATE INDEX "cap_configs_version_idx" ON "architecture_capability_configs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cap_configs_version_key_idx" ON "architecture_capability_configs" USING btree ("version_id","capability_key");--> statement-breakpoint
CREATE INDEX "policy_bindings_version_idx" ON "architecture_policy_bindings" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "arch_profiles_org_idx" ON "architecture_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "arch_profiles_status_idx" ON "architecture_profiles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "arch_profiles_org_slug_idx" ON "architecture_profiles" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "template_bindings_version_idx" ON "architecture_template_bindings" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "arch_versions_profile_idx" ON "architecture_versions" USING btree ("architecture_profile_id");--> statement-breakpoint
CREATE INDEX "arch_versions_published_idx" ON "architecture_versions" USING btree ("is_published");--> statement-breakpoint
CREATE UNIQUE INDEX "arch_versions_profile_number_idx" ON "architecture_versions" USING btree ("architecture_profile_id","version_number");--> statement-breakpoint
CREATE INDEX "integrations_org_idx" ON "integrations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider_idx" ON "integrations" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "knowledge_docs_org_idx" ON "knowledge_documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_docs_project_idx" ON "knowledge_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_docs_status_idx" ON "knowledge_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "org_members_org_idx" ON "organization_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_unique_idx" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_secrets_org_idx" ON "organization_secrets" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_secrets_org_key_idx" ON "organization_secrets" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_idx" ON "projects" USING btree ("organization_id","slug");