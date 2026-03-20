/**
 * SupabaseRuntimeStorage — connectionless runtime data layer.
 *
 * Architecture rules:
 *   - READS  : user-scoped Supabase client (anon key + JWT) → RLS enforces
 *              tenant isolation at the DB level. No pg.Pool, no TCP.
 *   - WRITES : admin client (service_role) + org always comes from
 *              req.user.organizationId (server-validated by auth middleware,
 *              never from user-provided body). Service_role is server-side
 *              only and never exposed to the browser.
 *   - DASHBOARD: Supabase RPC `get_dashboard_summary` — single HTTP round-trip,
 *               seven aggregations executed inside Postgres. ~50-200ms vs
 *               previous 15-30s pg.Pool cold-start latency.
 *
 * No pg.Pool, no Pool(), no client.connect(), no warmupPool(). Ever.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient, getSupabaseAdmin } from "./supabase";
import type {
  Project, AiRun, AiStep, AiArtifact, AiToolCall, AiApproval,
  ArchitectureProfile, ArchitectureVersion, Integration, ArtifactDependency,
} from "@shared/schema";
import type { IStorage } from "../storage";
import type {
  CreateProjectInput, UpdateProjectInput,
} from "../services/projects.service";
import type {
  CreateProfileInput, UpdateProfileInput, CreateVersionInput,
  UpsertAgentConfigInput, UpsertCapabilityConfigInput,
} from "../services/architectures.service";
import type {
  CreateRunInput, UpdateRunStatusInput, AppendStepInput, AppendArtifactInput,
  AppendToolCallInput, AppendApprovalInput, ResolveApprovalInput,
} from "../services/runs.service";
import type { UpsertIntegrationInput } from "../services/integrations.service";

// ── Column name conversion ────────────────────────────────────────────────────
// Supabase / PostgREST returns snake_case column names from Postgres.
// TypeScript types (from Drizzle) use camelCase. This helper converts.

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] =
      v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
        ? rowToCamel(v as Record<string, unknown>)
        : Array.isArray(v)
        ? v.map((el) =>
            el !== null && typeof el === "object" && !(el instanceof Date)
              ? rowToCamel(el as Record<string, unknown>)
              : el,
          )
        : v;
  }
  return out;
}

function toSnakeKey(s: string): string {
  return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

function objToSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[toSnakeKey(k)] = v;
  }
  return out;
}

// ── Error helper ──────────────────────────────────────────────────────────────

function assertNoError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`[supabase-runtime] ${context}: ${error.message}`);
}

// ── SupabaseStorage class ─────────────────────────────────────────────────────

export class SupabaseStorage implements IStorage {
  private readonly rls: SupabaseClient;   // user JWT — RLS enforced reads
  private readonly admin: SupabaseClient; // service_role — server-validated writes

  constructor(accessToken: string) {
    this.rls  = createServerSupabaseClient(accessToken);
    this.admin = getSupabaseAdmin();
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(organizationId: string): Promise<Project[]> {
    const { data, error } = await this.rls
      .from("projects")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    assertNoError(error, "listProjects");
    return (data ?? []).map((r) => rowToCamel(r) as unknown as Project);
  }

  async getProject(id: string, organizationId: string): Promise<Project> {
    const { data, error } = await this.rls
      .from("projects")
      .select("*")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    assertNoError(error, "getProject");
    if (!data) throw new Error(`Project not found: ${id}`);
    return rowToCamel(data) as unknown as Project;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { data, error } = await this.admin
      .from("projects")
      .insert(objToSnake({ ...input, status: "active" }))
      .select()
      .single();
    assertNoError(error, "createProject");
    return rowToCamel(data as Record<string, unknown>) as unknown as Project;
  }

  async updateProject(id: string, organizationId: string, input: UpdateProjectInput): Promise<Project> {
    const { data, error } = await this.admin
      .from("projects")
      .update(objToSnake({ ...input, updatedAt: new Date().toISOString() }))
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select()
      .single();
    assertNoError(error, "updateProject");
    if (!data) throw new Error(`Project not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as Project;
  }

  async archiveProject(id: string, organizationId: string): Promise<Project> {
    const { data, error } = await this.admin
      .from("projects")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select()
      .single();
    assertNoError(error, "archiveProject");
    if (!data) throw new Error(`Project not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as Project;
  }

  // ── Architecture Profiles ─────────────────────────────────────────────────

  async listArchitectureProfiles(organizationId: string): Promise<ArchitectureProfile[]> {
    const { data, error } = await this.rls
      .from("architecture_profiles")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    assertNoError(error, "listArchitectureProfiles");
    return (data ?? []).map((r) => rowToCamel(r) as unknown as ArchitectureProfile);
  }

  async getArchitectureProfile(
    id: string,
    organizationId: string,
  ): Promise<ArchitectureProfile & { versions: ArchitectureVersion[] }> {
    const { data, error } = await this.rls
      .from("architecture_profiles")
      .select("*, architecture_versions(*)")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    assertNoError(error, "getArchitectureProfile");
    if (!data) throw new Error(`Architecture profile not found: ${id}`);
    const row = rowToCamel(data as Record<string, unknown>) as unknown as ArchitectureProfile & { architectureVersions: ArchitectureVersion[] };
    return { ...row, versions: row.architectureVersions ?? [] };
  }

  async createArchitectureProfile(input: CreateProfileInput): Promise<ArchitectureProfile> {
    const { data, error } = await this.admin
      .from("architecture_profiles")
      .insert(objToSnake({ ...input, status: "active" }))
      .select()
      .single();
    assertNoError(error, "createArchitectureProfile");
    return rowToCamel(data as Record<string, unknown>) as unknown as ArchitectureProfile;
  }

  async updateArchitectureProfile(
    id: string, organizationId: string, input: UpdateProfileInput,
  ): Promise<ArchitectureProfile> {
    const { data, error } = await this.admin
      .from("architecture_profiles")
      .update(objToSnake({ ...input, updatedAt: new Date().toISOString() }))
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select()
      .single();
    assertNoError(error, "updateArchitectureProfile");
    if (!data) throw new Error(`Architecture profile not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as ArchitectureProfile;
  }

  async archiveArchitectureProfile(id: string, organizationId: string): Promise<ArchitectureProfile> {
    const { data, error } = await this.admin
      .from("architecture_profiles")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select()
      .single();
    assertNoError(error, "archiveArchitectureProfile");
    if (!data) throw new Error(`Architecture profile not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as ArchitectureProfile;
  }

  async createArchitectureVersion(input: CreateVersionInput): Promise<ArchitectureVersion> {
    const { data, error } = await this.admin
      .from("architecture_versions")
      .insert(objToSnake(input))
      .select()
      .single();
    assertNoError(error, "createArchitectureVersion");
    return rowToCamel(data as Record<string, unknown>) as unknown as ArchitectureVersion;
  }

  async publishArchitectureVersion(
    versionId: string, profileId: string, organizationId: string,
  ): Promise<ArchitectureVersion> {
    const [publishResult, _setCurrentResult] = await Promise.all([
      this.admin
        .from("architecture_versions")
        .update({ is_published: true, published_at: new Date().toISOString() })
        .eq("id", versionId)
        .eq("architecture_profile_id", profileId)
        .select()
        .single(),
      this.admin
        .from("architecture_profiles")
        .update({ current_version_id: versionId, updated_at: new Date().toISOString() })
        .eq("id", profileId)
        .eq("organization_id", organizationId),
    ]);
    assertNoError(publishResult.error, "publishArchitectureVersion");
    if (!publishResult.data) throw new Error(`Architecture version not found: ${versionId}`);
    return rowToCamel(publishResult.data as Record<string, unknown>) as unknown as ArchitectureVersion;
  }

  async upsertAgentConfig(input: UpsertAgentConfigInput): Promise<unknown> {
    const { data, error } = await this.admin
      .from("architecture_agent_configs")
      .upsert(objToSnake(input as Record<string, unknown>), {
        onConflict: "version_id,agent_key",
      })
      .select()
      .single();
    assertNoError(error, "upsertAgentConfig");
    return rowToCamel(data as Record<string, unknown>);
  }

  async upsertCapabilityConfig(input: UpsertCapabilityConfigInput): Promise<unknown> {
    const { data, error } = await this.admin
      .from("architecture_capability_configs")
      .upsert(objToSnake(input as Record<string, unknown>), {
        onConflict: "version_id,capability_key",
      })
      .select()
      .single();
    assertNoError(error, "upsertCapabilityConfig");
    return rowToCamel(data as Record<string, unknown>);
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async listRuns(
    organizationId: string,
    filters?: { status?: AiRun["status"]; projectId?: string },
  ): Promise<AiRun[]> {
    let query = this.rls
      .from("ai_runs")
      .select("*")
      .eq("organization_id", organizationId)
      .order("run_number", { ascending: false });

    if (filters?.status)    query = query.eq("status", filters.status);
    if (filters?.projectId) query = query.eq("project_id", filters.projectId);

    const { data, error } = await query;
    assertNoError(error, "listRuns");
    return (data ?? []).map((r) => rowToCamel(r) as unknown as AiRun);
  }

  async getRun(
    id: string,
    organizationId: string,
  ): Promise<AiRun & { steps: AiStep[]; artifacts: AiArtifact[]; toolCalls: AiToolCall[]; approvals: AiApproval[] }> {
    const { data, error } = await this.rls
      .from("ai_runs")
      .select("*, ai_steps(*), ai_artifacts(*), ai_tool_calls(*), ai_approvals(*)")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    assertNoError(error, "getRun");
    if (!data) throw new Error(`Run not found: ${id}`);

    const row = rowToCamel(data as Record<string, unknown>) as unknown as AiRun & {
      aiSteps: AiStep[];
      aiArtifacts: AiArtifact[];
      aiToolCalls: AiToolCall[];
      aiApprovals: AiApproval[];
    };

    return {
      ...row,
      steps:     row.aiSteps     ?? [],
      artifacts: row.aiArtifacts ?? [],
      toolCalls: row.aiToolCalls ?? [],
      approvals: row.aiApprovals ?? [],
    };
  }

  async createRun(input: CreateRunInput): Promise<AiRun> {
    // Atomic sequential run_number via Supabase RPC.
    // The PG function uses SECURITY DEFINER + FOR UPDATE to prevent race conditions.
    const { data, error } = await this.admin.rpc("create_ai_run", {
      p_org_id:                  input.organizationId,
      p_project_id:              input.projectId,
      p_architecture_profile_id: input.architectureProfileId,
      p_architecture_version_id: input.architectureVersionId,
      p_created_by:              input.createdBy,
      p_title:                   input.title ?? null,
      p_description:             (input as Record<string, unknown>).description ?? null,
      p_goal:                    input.goal ?? null,
      p_tags:                    input.tags ?? null,
      p_pipeline_version:        input.pipelineVersion ?? null,
    });
    assertNoError(error, "createRun");
    return rowToCamel(data as Record<string, unknown>) as unknown as AiRun;
  }

  async updateRunStatus(
    id: string, organizationId: string, input: UpdateRunStatusInput,
  ): Promise<AiRun> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: input.status, updated_at: now };
    if (input.status === "running")                           patch.started_at    = now;
    if (input.status === "completed")                        { patch.completed_at = now; patch.finished_at = now; }
    if (input.status === "failed" || input.status === "cancelled") patch.finished_at = now;

    const { data, error } = await this.admin
      .from("ai_runs")
      .update(patch)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select()
      .single();
    assertNoError(error, "updateRunStatus");
    if (!data) throw new Error(`Run not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as AiRun;
  }

  async appendStep(input: AppendStepInput): Promise<AiStep> {
    const { data, error } = await this.admin
      .from("ai_steps")
      .insert(objToSnake(input as Record<string, unknown>))
      .select()
      .single();
    assertNoError(error, "appendStep");
    return rowToCamel(data as Record<string, unknown>) as unknown as AiStep;
  }

  async appendArtifact(input: AppendArtifactInput): Promise<AiArtifact> {
    const { data, error } = await this.admin
      .from("ai_artifacts")
      .insert(objToSnake(input as Record<string, unknown>))
      .select()
      .single();
    assertNoError(error, "appendArtifact");
    return rowToCamel(data as Record<string, unknown>) as unknown as AiArtifact;
  }

  async appendToolCall(input: AppendToolCallInput): Promise<AiToolCall> {
    const { data, error } = await this.admin
      .from("ai_tool_calls")
      .insert(objToSnake(input as Record<string, unknown>))
      .select()
      .single();
    assertNoError(error, "appendToolCall");
    return rowToCamel(data as Record<string, unknown>) as unknown as AiToolCall;
  }

  async appendApproval(input: AppendApprovalInput): Promise<AiApproval> {
    const { data, error } = await this.admin
      .from("ai_approvals")
      .insert(objToSnake(input as Record<string, unknown>))
      .select()
      .single();
    assertNoError(error, "appendApproval");
    return rowToCamel(data as Record<string, unknown>) as unknown as AiApproval;
  }

  async resolveApproval(id: string, input: ResolveApprovalInput): Promise<AiApproval> {
    const { data, error } = await this.admin
      .from("ai_approvals")
      .update({
        status:      input.status,
        approved_by: input.approvedBy,
        notes:       input.notes ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    assertNoError(error, "resolveApproval");
    if (!data) throw new Error(`Approval not found: ${id}`);
    return rowToCamel(data as Record<string, unknown>) as unknown as AiApproval;
  }

  // ── Artifact Dependencies ─────────────────────────────────────────────────

  async listArtifactDependencies(runId: string): Promise<ArtifactDependency[]> {
    const { data: artifacts, error: aErr } = await this.rls
      .from("ai_artifacts")
      .select("id")
      .eq("run_id", runId);
    assertNoError(aErr, "listArtifactDependencies:artifacts");

    if (!artifacts || artifacts.length === 0) return [];

    const ids = artifacts.map((a: { id: string }) => a.id);
    const { data, error } = await this.rls
      .from("artifact_dependencies")
      .select("*")
      .in("from_artifact_id", ids)
      .order("created_at", { ascending: true });
    assertNoError(error, "listArtifactDependencies");
    return (data ?? []).map((r) => rowToCamel(r) as unknown as ArtifactDependency);
  }

  // ── Integrations ──────────────────────────────────────────────────────────

  async listIntegrations(organizationId: string): Promise<Integration[]> {
    const { data, error } = await this.rls
      .from("integrations")
      .select("*")
      .eq("organization_id", organizationId);
    assertNoError(error, "listIntegrations");
    return (data ?? []).map((r) => rowToCamel(r) as unknown as Integration);
  }

  async upsertIntegration(input: UpsertIntegrationInput): Promise<Integration> {
    const { data, error } = await this.admin
      .from("integrations")
      .upsert(objToSnake(input as Record<string, unknown>), {
        onConflict: "organization_id,provider",
      })
      .select()
      .single();
    assertNoError(error, "upsertIntegration");
    return rowToCamel(data as Record<string, unknown>) as unknown as Integration;
  }
}
