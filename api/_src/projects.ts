import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, readBody } from "./_lib/response";
import { dbList, dbGet, dbInsert, dbUpdate } from "./_lib/db";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;
  const orgId    = user.organizationId;
  const token    = (req.headers.authorization ?? "").slice(7);
  const method   = req.method ?? "GET";
  const segs     = pathSegments(req, "/api/projects");

  try {
    // ── GET /api/projects ──────────────────────────────────────────────────────
    if (segs.length === 0 && method === "GET") {
      const rows = await dbList("projects", token, {
        organization_id: `eq.${orgId}`, status: "eq.active", order: "created_at.desc",
      });
      res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=20");
      return json(res, rows);
    }

    // ── POST /api/projects ─────────────────────────────────────────────────────
    if (segs.length === 0 && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbInsert("projects", {
        ...body,
        organizationId: orgId,
        createdBy:      user.id,
        status:         "active",
      });
      return json(res, row, 201);
    }

    const id = segs[0];

    // ── GET /api/projects/:id ──────────────────────────────────────────────────
    if (segs.length === 1 && method === "GET") {
      const row = await dbGet("projects", token, { id: `eq.${id}`, organization_id: `eq.${orgId}` });
      if (!row) return err(res, 404, "NOT_FOUND", `Project not found: ${id}`);
      return json(res, row);
    }

    // ── PATCH /api/projects/:id ────────────────────────────────────────────────
    if (segs.length === 1 && method === "PATCH") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbUpdate("projects",
        { id: `eq.${id}`, organization_id: `eq.${orgId}` },
        { ...body, updatedAt: new Date().toISOString() },
      );
      if (!row) return err(res, 404, "NOT_FOUND", `Project not found: ${id}`);
      return json(res, row);
    }

    // ── POST /api/projects/:id/archive ─────────────────────────────────────────
    if (segs.length === 2 && segs[1] === "archive" && method === "POST") {
      const row = await dbUpdate("projects",
        { id: `eq.${id}`, organization_id: `eq.${orgId}` },
        { status: "archived", updatedAt: new Date().toISOString() },
      );
      if (!row) return err(res, 404, "NOT_FOUND", `Project not found: ${id}`);
      return json(res, row);
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
