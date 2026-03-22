import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

const SUPABASE_JWT_SECRET   = process.env.SUPABASE_JWT_SECRET   ?? "";
const SUPABASE_URL          = process.env.SUPABASE_URL           ?? "";
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const INTERNAL_API_SECRET   = process.env.INTERNAL_API_SECRET   ?? "";
const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.PLATFORM_ADMIN_EMAILS ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const LOCKDOWN_ENABLED   = process.env.LOCKDOWN_ENABLED === "true";
const LOCKDOWN_ALLOWLIST = new Set(
  (process.env.LOCKDOWN_ALLOWLIST ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
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
// Used when SUPABASE_JWT_SECRET is not set or local verification fails.
// Matches behaviour of Express server/middleware/auth.ts.

interface SupabaseUserResponse {
  id?: string;
  email?: string;
  error?: string;
  message?: string;
}

const supabaseUserCache = new Map<string, { id: string; email?: string; exp: number }>();

async function verifyViaSupabaseApi(token: string): Promise<{ id: string; email?: string } | null> {
  // Cache result for 30 s to avoid hammering the Supabase Auth API
  const cached = supabaseUserCache.get(token);
  if (cached && cached.exp > Date.now()) return { id: cached.id, email: cached.email };

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
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

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(userId)}&select=organization_id,role&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
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
    const user: AuthUser = {
      id: "internal-script", email: "internal@blissops.com",
      organizationId: "blissops-main", role: "platform_admin",
    };
    return { user, status: "ok" };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return { user: null, status: "unauthenticated" };
  const token = authHeader.slice(7).trim();
  if (!token) return { user: null, status: "unauthenticated" };

  // Fast path: local JWT verification (< 1 ms, no network)
  let jwt = verifyLocalJwt(token);

  // Slow path fallback: call Supabase Auth API when:
  //   - SUPABASE_JWT_SECRET is not set in this environment
  //   - local verification failed (e.g. secret mismatch)
  // This mirrors the Express server/middleware/auth.ts behaviour so the
  // serverless functions work even without the JWT secret configured.
  if (!jwt) {
    jwt = await verifyViaSupabaseApi(token);
  }

  if (!jwt) return { user: null, status: "unauthenticated" };

  // Lockdown guard
  if (LOCKDOWN_ENABLED && jwt.email && !LOCKDOWN_ALLOWLIST.has(jwt.email.toLowerCase())) {
    return { user: null, status: "lockdown" };
  }

  // Platform admin
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
