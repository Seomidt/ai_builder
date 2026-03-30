import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { json, err } from "./_lib/response.ts";
import { dbList } from "./_lib/db.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return err(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user }     = auth;
  const orgId        = user.organizationId;
  const token        = (req.headers.authorization ?? "").slice(7);

  try {
    const [projects, architectures, runs, integrations] = await Promise.all([
      dbList("projects",              token, { organization_id: `eq.${orgId}`, status: "eq.active", select: "id,name,status,updated_at", order: "updated_at.desc" }),
      dbList("architecture_profiles", token, { organization_id: `eq.${orgId}`, status: "eq.active",   select: "id" }),
      dbList("ai_runs",               token, { organization_id: `eq.${orgId}`, select: "id,status,created_at", order: "created_at.desc" }),
      dbList("integrations",          token, { organization_id: `eq.${orgId}`, select: "id,status" }),
    ]);

    const recentProjects = projects.slice(0, 5).map((p) => ({
      id: p.id, name: p.name, status: p.status, updatedAt: p.updatedAt,
    }));
    const recentRuns = runs.slice(0, 5).map((r) => ({
      id: r.id, status: r.status, createdAt: r.createdAt,
    }));

    res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    return json(res, {
      orgName:                    "AI Builder Platform",
      projectCount:               projects.length,
      activeRunCount:             runs.filter((r) => r.status === "running").length,
      architectureCount:          architectures.length,
      configuredIntegrationCount: integrations.filter((i) => i.status === "active").length,
      recentProjects,
      recentRuns,
    });
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
