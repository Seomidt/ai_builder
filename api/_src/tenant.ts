import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, parseUrl } from "./_lib/response";
import { dbList, dbGet } from "./_lib/db";

const SUPABASE_URL    = process.env.SUPABASE_URL            ?? "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;
  const orgId    = user.organizationId;
  const token    = (req.headers.authorization ?? "").slice(7);
  const method   = req.method ?? "GET";
  const segs     = pathSegments(req, "/api/tenant");
  const u        = parseUrl(req);

  try {
    // ── GET /api/tenant/org ────────────────────────────────────────────────────
    if (segs[0] === "org" && method === "GET") {
      const row = await dbGet("organizations", token, { id: `eq.${orgId}` });
      return json(res, row ?? { id: orgId, name: "BlissOps" });
    }

    // ── GET /api/tenant/members ────────────────────────────────────────────────
    if (segs[0] === "members" && method === "GET") {
      const rows = await dbList("organization_members", token, { organization_id: `eq.${orgId}` });
      return json(res, rows);
    }

    // ── GET /api/tenant/usage ──────────────────────────────────────────────────
    if (segs[0] === "usage" && method === "GET") {
      const period = u.searchParams.get("period") ?? "monthly";
      const rows   = await dbList("tenant_ai_usage_snapshots", token, {
        organization_id: `eq.${orgId}`, period_type: `eq.${period}`,
        order: "snapshot_at.desc", limit: "1",
      });
      return json(res, { data: rows[0] ?? null });
    }

    // ── GET /api/tenant/budget ─────────────────────────────────────────────────
    if (segs[0] === "budget" && method === "GET") {
      const period = u.searchParams.get("period") ?? "monthly";
      const rows   = await dbList("tenant_budgets", token, {
        organization_id: `eq.${orgId}`, period_type: `eq.${period}`, status: "eq.active",
        order: "created_at.desc", limit: "1",
      });
      return json(res, { data: rows[0] ?? null });
    }

    // ── GET /api/tenant/settings ───────────────────────────────────────────────
    if (segs[0] === "settings" && method === "GET") {
      const row = await dbGet("organization_settings", token, { organization_id: `eq.${orgId}` });
      return json(res, { data: row ?? {} });
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
