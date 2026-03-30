import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { json, err, pathSegments } from "./_lib/response.ts";

const SUPABASE_URL     = process.env.SUPABASE_URL     ?? "";
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY ?? "";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const segs   = pathSegments(req, "/api/auth");
  const method = req.method ?? "GET";

  // ── GET /api/auth/config (public) ────────────────────────────────────────────
  if (segs[0] === "config" && method === "GET") {
    return json(res, { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON });
  }

  // ── POST /api/auth/logout (public) ───────────────────────────────────────────
  if (segs[0] === "logout" && method === "POST") {
    return json(res, { ok: true });
  }

  // All remaining routes require auth
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");
  const { user } = auth;

  // ── GET /api/auth/session ─────────────────────────────────────────────────────
  if (segs.length === 0 && method === "GET" ||
      segs[0] === "session" && method === "GET") {
    return json(res, { user });
  }

  // ── GET /api/auth/mfa/status ──────────────────────────────────────────────────
  if (segs[0] === "mfa" && segs[1] === "status" && method === "GET") {
    return json(res, { mfaEnabled: false, factors: [] });
  }

  return err(res, 404, "NOT_FOUND", "Route not found");
}
