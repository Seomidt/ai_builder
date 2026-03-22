/**
 * auth-edge — Vercel Edge Runtime handler for /api/auth/*
 *
 * Edge runtime: no cold start, global CDN distribution, sub-100ms worldwide.
 * Uses Web Crypto API (crypto.subtle) — no Node.js built-ins.
 * Org membership fetched from Supabase REST — ~20-50ms from edge PoP.
 *
 * Target: <200ms p99 globally (including Supabase org lookup).
 */

export const config = { runtime: "edge" };

// ── Types ─────────────────────────────────────────────────────────────────────

interface JwtPayload {
  sub:  string;
  email?: string;
  exp:  number;
  iat?: number;
}

// ── Web Crypto JWT verify (HMAC-SHA256) ───────────────────────────────────────

function b64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(pad));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64url(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64url(p))) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;
    return payload;
  } catch { return null; }
}

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonOk(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function jsonErr(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error_code: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Org membership lookup ─────────────────────────────────────────────────────

async function lookupOrg(
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<{ orgId: string; role: string }> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(userId)}&select=organization_id,role&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const rows = (await res.json()) as Array<{ organization_id: string; role: string }>;
    return {
      orgId: rows[0]?.organization_id ?? "blissops-main",
      role:  rows[0]?.role             ?? "member",
    };
  } catch {
    return { orgId: "blissops-main", role: "member" };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  const url     = new URL(req.url);
  const path    = url.pathname.replace(/^\/api\/auth/, "") || "/";
  const method  = req.method;

  const SUPABASE_URL    = process.env.SUPABASE_URL              ?? "";
  const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY         ?? "";
  const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const JWT_SECRET      = process.env.SUPABASE_JWT_SECRET       ?? "";
  const LOCKDOWN        = process.env.LOCKDOWN_ENABLED === "true";
  const ALLOWLIST       = (process.env.LOCKDOWN_ALLOWLIST ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const ADMIN_EMAILS    = (process.env.PLATFORM_ADMIN_EMAILS ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

  // ── GET /api/auth/config (public — no auth) ────────────────────────────────
  if ((path === "/config" || path === "/config/") && method === "GET") {
    return jsonOk(
      { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON },
      200,
      { "Cache-Control": "public, max-age=3600" },
    );
  }

  // ── POST /api/auth/logout (public — client-side only) ─────────────────────
  if ((path === "/logout" || path === "/logout/") && method === "POST") {
    return jsonOk({ ok: true });
  }

  // ── All remaining routes require Bearer token ──────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonErr(401, "UNAUTHENTICATED", "Authentication required");
  }
  const token = authHeader.slice(7).trim();

  const payload = await verifyJwt(token, JWT_SECRET);
  if (!payload) return jsonErr(401, "UNAUTHENTICATED", "Invalid or expired token");

  const email = payload.email?.toLowerCase() ?? "";

  // Lockdown guard
  if (LOCKDOWN && email && !ALLOWLIST.includes(email)) {
    return jsonErr(403, "LOCKDOWN", "Platform is in lockdown");
  }

  // ── GET /api/auth/session ──────────────────────────────────────────────────
  if ((path === "" || path === "/" || path === "/session" || path === "/session/") && method === "GET") {
    const isAdmin = email ? ADMIN_EMAILS.includes(email) : false;
    const { orgId, role: rawRole } = await lookupOrg(payload.sub, SUPABASE_URL, SERVICE_KEY);
    const role = isAdmin ? "platform_admin" : rawRole;

    return jsonOk(
      { user: { id: payload.sub, email: payload.email, organizationId: orgId, role } },
      200,
      { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" },
    );
  }

  // ── GET /api/auth/mfa/status ───────────────────────────────────────────────
  if (path === "/mfa/status" && method === "GET") {
    return jsonOk({ mfaEnabled: false, factors: [] });
  }

  return jsonErr(404, "NOT_FOUND", "Route not found");
}
