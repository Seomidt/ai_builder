import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, readBody } from "./_lib/response";
import { dbList, dbGet, dbInsert, dbUpdate, dbUpsert, dbRpc } from "./_lib/db";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;
  const orgId    = user.organizationId;
  const token    = (req.headers.authorization ?? "").slice(7);
  const method   = req.method ?? "GET";
  const segs     = pathSegments(req, "/api/architectures");

  try {
    // ── GET /api/architectures ─────────────────────────────────────────────────
    if (segs.length === 0 && method === "GET") {
      const rows = await dbList("architecture_profiles", token, {
        organization_id: `eq.${orgId}`, status: "eq.active", order: "created_at.desc",
      });
      res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=20");
      return json(res, rows);
    }

    // ── POST /api/architectures ────────────────────────────────────────────────
    if (segs.length === 0 && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("architecture_profiles", {
        ...body, organizationId: orgId, createdBy: user.id, status: "active",
      });
      return json(res, row, 201);
    }

    const id = segs[0];

    // ── GET /api/architectures/:id ─────────────────────────────────────────────
    if (segs.length === 1 && method === "GET") {
      const row = await dbGet("architecture_profiles", token, {
        id: `eq.${id}`, organization_id: `eq.${orgId}`,
        select: "*,architecture_versions(*)",
      });
      if (!row) return err(res, 404, "NOT_FOUND", `Architecture not found: ${id}`);
      const typed = row as Record<string, unknown> & { architectureVersions?: unknown[] };
      return json(res, { ...row, versions: typed.architectureVersions ?? [] });
    }

    // ── PATCH /api/architectures/:id ───────────────────────────────────────────
    if (segs.length === 1 && method === "PATCH") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbUpdate("architecture_profiles",
        { id: `eq.${id}`, organization_id: `eq.${orgId}` },
        { ...body, updatedAt: new Date().toISOString() },
      );
      return json(res, row);
    }

    // ── POST /api/architectures/:id/archive ────────────────────────────────────
    if (segs.length === 2 && segs[1] === "archive" && method === "POST") {
      const row = await dbUpdate("architecture_profiles",
        { id: `eq.${id}`, organization_id: `eq.${orgId}` },
        { status: "archived", updatedAt: new Date().toISOString() },
      );
      return json(res, row);
    }

    // ── POST /api/architectures/:id/versions ───────────────────────────────────
    if (segs.length === 2 && segs[1] === "versions" && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("architecture_versions", {
        ...body, architectureProfileId: id,
      });
      return json(res, row, 201);
    }

    const versionId = segs[2];

    // ── POST /api/architectures/:id/versions/:versionId/publish ───────────────
    if (segs.length === 4 && segs[1] === "versions" && segs[3] === "publish" && method === "POST") {
      const now = new Date().toISOString();
      const [vRow] = await Promise.all([
        dbUpdate("architecture_versions",
          { id: `eq.${versionId}`, architecture_profile_id: `eq.${id}` },
          { isPublished: true, publishedAt: now },
        ),
        dbUpdate("architecture_profiles",
          { id: `eq.${id}`, organization_id: `eq.${orgId}` },
          { currentVersionId: versionId, updatedAt: now },
        ),
      ]);
      return json(res, vRow);
    }

    // ── PUT /api/architectures/:id/versions/:versionId/agents ─────────────────
    if (segs.length === 4 && segs[1] === "versions" && segs[3] === "agents" && method === "PUT") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbUpsert("architecture_agent_configs",
        { ...body, versionId },
        "version_id,agent_key",
      );
      return json(res, row);
    }

    // ── PUT /api/architectures/:id/versions/:versionId/capabilities ───────────
    if (segs.length === 4 && segs[1] === "versions" && segs[3] === "capabilities" && method === "PUT") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbUpsert("architecture_capability_configs",
        { ...body, versionId },
        "version_id,capability_key",
      );
      return json(res, row);
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
