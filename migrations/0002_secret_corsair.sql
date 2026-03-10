CREATE TYPE "public"."ai_usage_status" AS ENUM('success', 'error');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar,
	"user_id" varchar,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"input_preview" text,
	"status" "ai_usage_status" DEFAULT 'success' NOT NULL,
	"error_message" text,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_dependencies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"from_artifact_id" varchar NOT NULL,
	"to_artifact_id" varchar NOT NULL,
	"dependency_type" text DEFAULT 'uses' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_dependencies" ADD CONSTRAINT "artifact_dependencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_dependencies" ADD CONSTRAINT "artifact_dependencies_from_artifact_id_ai_artifacts_id_fk" FOREIGN KEY ("from_artifact_id") REFERENCES "public"."ai_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_dependencies" ADD CONSTRAINT "artifact_dependencies_to_artifact_id_ai_artifacts_id_fk" FOREIGN KEY ("to_artifact_id") REFERENCES "public"."ai_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_tenant_id_idx" ON "ai_usage" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ai_usage_user_id_idx" ON "ai_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_feature_idx" ON "ai_usage" USING btree ("feature");--> statement-breakpoint
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "artifact_deps_from_idx" ON "artifact_dependencies" USING btree ("from_artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_deps_to_idx" ON "artifact_dependencies" USING btree ("to_artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_deps_org_idx" ON "artifact_dependencies" USING btree ("organization_id");