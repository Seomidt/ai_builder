import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, readBody } from "./_lib/response";
import { dbList, dbGet, dbUpsert } from "./_lib/db";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;
  const orgId    = user.organizationId;
  const token    = (req.headers.authorization ?? "").slice(7);
  const method   = req.method ?? "GET";
  const segs     = pathSegments(req, "/api/integrations");

  try {
    // ── GET /api/integrations ──────────────────────────────────────────────────
    if (segs.length === 0 && method === "GET") {
      const rows = await dbList("integrations", token, { organization_id: `eq.${orgId}` });
      return json(res, rows);
    }

    // ── POST /api/integrations ─────────────────────────────────────────────────
    if (segs.length === 0 && method === "POST") {
      const body = await readBody<Record<string, unknown>>(req);
      const row  = await dbUpsert("integrations",
        { ...body, organizationId: orgId },
        "organization_id,provider",
      );
      return json(res, row);
    }

    // ── GET /api/integrations/:provider ───────────────────────────────────────
    if (segs.length === 1 && method === "GET") {
      const provider = segs[0];
      const row = await dbGet("integrations", token, {
        organization_id: `eq.${orgId}`, provider: `eq.${provider}`,
      });
      if (!row) return err(res, 404, "NOT_FOUND", `Integration not found: ${provider}`);
      return json(res, row);
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
