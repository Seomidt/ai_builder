ALTER TABLE "ai_runs" ADD COLUMN "run_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "finished_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "github_branch" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "github_commit_sha" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "github_pr_number" integer;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "github_tags" text[];--> statement-breakpoint
ALTER TABLE "architecture_versions" ADD COLUMN "version_label" text;--> statement-breakpoint
ALTER TABLE "architecture_versions" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "architecture_versions" ADD COLUMN "changelog" text;--> statement-breakpoint
CREATE INDEX "ai_runs_run_number_idx" ON "ai_runs" USING btree ("organization_id","run_number");