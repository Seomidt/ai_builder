import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, parseUrl, readBody } from "./_lib/response";
import { dbList, dbGet, dbInsert, dbUpdate, dbRpc } from "./_lib/db";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;
  const orgId    = user.organizationId;
  const token    = (req.headers.authorization ?? "").slice(7);
  const method   = req.method ?? "GET";
  const segs     = pathSegments(req, "/api/runs");
  const u        = parseUrl(req);

  try {
    // ── GET /api/runs ──────────────────────────────────────────────────────────
    if (segs.length === 0 && method === "GET") {
      const params: Record<string, string> = {
        organization_id: `eq.${orgId}`, order: "run_number.desc",
      };
      const status    = u.searchParams.get("status");
      const projectId = u.searchParams.get("projectId");
      if (status)    params.status     = `eq.${status}`;
      if (projectId) params.project_id = `eq.${projectId}`;
      const rows = await dbList("ai_runs", token, params);
      res.setHeader("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
      return json(res, rows);
    }

    // ── POST /api/runs ─────────────────────────────────────────────────────────
    if (segs.length === 0 && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbRpc("create_ai_run", {
        p_org_id:                  orgId,
        p_project_id:              body.projectId,
        p_architecture_profile_id: body.architectureProfileId,
        p_architecture_version_id: body.architectureVersionId,
        p_created_by:              user.id,
        p_title:                   body.title   ?? null,
        p_description:             body.description ?? null,
        p_goal:                    body.goal    ?? null,
        p_tags:                    body.tags    ?? null,
        p_pipeline_version:        body.pipelineVersion ?? null,
      });
      return json(res, row, 201);
    }

    const id = segs[0];

    // ── GET /api/runs/:id ──────────────────────────────────────────────────────
    if (segs.length === 1 && method === "GET") {
      const row = await dbGet("ai_runs", token, {
        id:              `eq.${id}`,
        organization_id: `eq.${orgId}`,
        select:          "*,ai_steps(*),ai_artifacts(*),ai_tool_calls(*),ai_approvals(*)",
      });
      if (!row) return err(res, 404, "NOT_FOUND", `Run not found: ${id}`);
      const r = row as Record<string, unknown> & {
        aiSteps?: unknown[]; aiArtifacts?: unknown[];
        aiToolCalls?: unknown[]; aiApprovals?: unknown[];
      };
      return json(res, {
        ...row,
        steps:     r.aiSteps     ?? [],
        artifacts: r.aiArtifacts ?? [],
        toolCalls: r.aiToolCalls ?? [],
        approvals: r.aiApprovals ?? [],
      });
    }

    // ── PATCH /api/runs/:id/status ─────────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "status" && method === "PATCH") {
      const body  = await readBody<{ status: string }>(req);
      const now   = new Date().toISOString();
      const patch: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.status === "running")                             patch.startedAt   = now;
      if (body.status === "completed")                          { patch.completedAt = now; patch.finishedAt = now; }
      if (body.status === "failed" || body.status === "cancelled") patch.finishedAt = now;
      const row = await dbUpdate("ai_runs",
        { id: `eq.${id}`, organization_id: `eq.${orgId}` },
        patch,
      );
      return json(res, row);
    }

    // ── POST /api/runs/:id/steps ───────────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "steps" && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("ai_steps", { ...body, runId: id });
      return json(res, row, 201);
    }

    // ── POST /api/runs/:id/artifacts ───────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "artifacts" && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("ai_artifacts", { ...body, runId: id });
      return json(res, row, 201);
    }

    // ── POST /api/runs/:id/tool-calls ──────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "tool-calls" && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("ai_tool_calls", { ...body, runId: id });
      return json(res, row, 201);
    }

    // ── POST /api/runs/:id/approvals ───────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "approvals" && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("ai_approvals", { ...body, runId: id, status: "pending" });
      return json(res, row, 201);
    }

    // ── PATCH /api/runs/:id/approvals/:approvalId ──────────────────────────────
    if (segs.length === 3 && segs[1] === "approvals" && method === "PATCH") {
      const approvalId = segs[2];
      const body       = await readBody<Record<string, unknown>>(req);
      const row        = await dbUpdate("ai_approvals",
        { id: `eq.${approvalId}` },
        { ...body, resolvedAt: new Date().toISOString() },
      );
      return json(res, row);
    }

    // ── GET /api/runs/:id/artifact-dependencies ────────────────────────────────
    if (segs.length === 2 && segs[1] === "artifact-dependencies" && method === "GET") {
      const artifacts = await dbList("ai_artifacts", token, { run_id: `eq.${id}`, select: "id" });
      if (!artifacts.length) return json(res, []);
      const ids  = artifacts.map((a) => (a as { id: string }).id).join(",");
      const deps = await dbList("artifact_dependencies", token, {
        from_artifact_id: `in.(${ids})`, order: "created_at.asc",
      });
      return json(res, deps);
    }

    // ── POST /api/runs/:id/execute ─────────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "execute" && method === "POST") {
      return json(res, { ok: true, message: "Run execution queued" });
    }

    // ── GET /api/runs/:id/commit-preview ──────────────────────────────────────
    if (segs.length === 2 && segs[1] === "commit-preview" && method === "GET") {
      return json(res, { preview: null, message: "No commit preview available" });
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
