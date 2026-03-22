import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

// Trim all secrets — Vercel/env editors sometimes add trailing newlines/spaces
const SUPABASE_JWT_SECRET   = (process.env.SUPABASE_JWT_SECRET   ?? "").trim();
const SUPABASE_URL          = (process.env.SUPABASE_URL           ?? "").trim();
const SUPABASE_SERVICE_KEY  = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
// Anon key: always available (used by frontend too), safe to use as `apikey`
const SUPABASE_ANON_KEY     = (process.env.SUPABASE_ANON_KEY     ?? "").trim();
const INTERNAL_API_SECRET   = (process.env.INTERNAL_API_SECRET   ?? "").trim();

const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.PLATFORM_ADMIN_EMAILS ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const LOCKDOWN_ENABLED   = process.env.LOCKDOWN_ENABLED === "true";
const LOCKDOWN_ALLOWLIST = new Set(
  (process.env.LOCKDOWN_ALLOWLIST ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);

// ── JWT verification (fast path — local HMAC, no network) ────────────────────

function b64UrlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyLocalJwt(token: string): { id: string; email?: string } | null {
  if (!SUPABASE_JWT_SECRET) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expected = createHmac("sha256", SUPABASE_JWT_SECRET)
      .update(`${h}.${p}`).digest("base64url");
    const expBuf = Buffer.from(expected, "utf8");
    const actBuf = Buffer.from(sig,      "utf8");
    if (expBuf.length !== actBuf.length || !timingSafeEqual(expBuf, actBuf)) return null;
    const payload = JSON.parse(b64UrlToBuffer(p).toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;
    return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
  } catch { return null; }
}

// ── Supabase API fallback (slow path — network call to Supabase Auth API) ────
// Uses SUPABASE_ANON_KEY as apikey (always available, identifies the project).
// Falls back to SUPABASE_SERVICE_KEY if anon key is missing.

interface SupabaseUserResponse {
  id?: string;
  email?: string;
  error?: string;
  message?: string;
}

const supabaseUserCache = new Map<string, { id: string; email?: string; exp: number }>();

async function verifyViaSupabaseApi(token: string): Promise<{ id: string; email?: string } | null> {
  const cached = supabaseUserCache.get(token);
  if (cached && cached.exp > Date.now()) return { id: cached.id, email: cached.email };

  // Prefer anon key as apikey — always available, sufficient to identify project.
  // Service key works too but may not be configured in all environments.
  const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !apikey) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SupabaseUserResponse;
    if (!data.id) return null;
    supabaseUserCache.set(token, { id: data.id, email: data.email, exp: Date.now() + 30_000 });
    return { id: data.id, email: data.email };
  } catch {
    return null;
  }
}

// ── Membership cache (30 s TTL per process instance) ─────────────────────────

const memberCache = new Map<string, { orgId: string; role: string; exp: number }>();

async function lookupMembership(userId: string): Promise<{ orgId: string; role: string }> {
  const hit = memberCache.get(userId);
  if (hit && hit.exp > Date.now()) return { orgId: hit.orgId, role: hit.role };

  const apikey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !apikey) return { orgId: "blissops-main", role: "member" };

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(userId)}&select=organization_id,role&limit=1`,
      { headers: { apikey, Authorization: `Bearer ${apikey}` } },
    );
    const rows = (await res.json()) as Array<{ organization_id: string; role: string }>;
    const orgId = rows[0]?.organization_id ?? "blissops-main";
    const role  = rows[0]?.role             ?? "member";
    memberCache.set(userId, { orgId, role, exp: Date.now() + 30_000 });
    return { orgId, role };
  } catch {
    return { orgId: "blissops-main", role: "member" };
  }
}

// ── AuthUser ─────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:             string;
  email?:         string;
  organizationId: string;
  role:           string;
}

// ── authenticate() — main entry for handlers ─────────────────────────────────

export async function authenticate(req: IncomingMessage): Promise<
  | { user: AuthUser; status: "ok" }
  | { user: null; status: "unauthenticated" | "lockdown" }
> {
  // Internal tooling bypass
  if (INTERNAL_API_SECRET && req.headers["x-internal-token"] === INTERNAL_API_SECRET) {
    return {
      user: { id: "internal-script", email: "internal@blissops.com", organizationId: "blissops-main", role: "platform_admin" },
      status: "ok",
    };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return { user: null, status: "unauthenticated" };
  const token = authHeader.slice(7).trim();
  if (!token) return { user: null, status: "unauthenticated" };

  // Fast path: local JWT verification (< 1 ms, no network)
  let jwt = verifyLocalJwt(token);

  // Slow path: call Supabase Auth API when local verification fails
  if (!jwt) jwt = await verifyViaSupabaseApi(token);

  if (!jwt) return { user: null, status: "unauthenticated" };

  // Lockdown guard
  if (LOCKDOWN_ENABLED && jwt.email && !LOCKDOWN_ALLOWLIST.has(jwt.email.toLowerCase())) {
    return { user: null, status: "lockdown" };
  }

  // Platform admin — always gets full access
  if (jwt.email && PLATFORM_ADMIN_EMAILS.has(jwt.email.toLowerCase())) {
    const { orgId } = await lookupMembership(jwt.id);
    return {
      user: { id: jwt.id, email: jwt.email, organizationId: orgId, role: "platform_admin" },
      status: "ok",
    };
  }

  const { orgId, role } = await lookupMembership(jwt.id);
  return {
    user: { id: jwt.id, email: jwt.email, organizationId: orgId, role },
    status: "ok",
  };
}
