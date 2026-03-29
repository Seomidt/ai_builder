import { createHmac, timingSafeEqual } from "crypto";
import { webcrypto } from "crypto";
import type { IncomingMessage } from "http";

// Public fallbacks — same values embedded in the frontend JS bundle.
// Safe to hardcode: SUPABASE_URL is the project endpoint (not secret),
// and the anon key is a publishable API key by design.
const _FALLBACK_URL  = "https://jneoimqidmkhikvusxak.supabase.co";
const _FALLBACK_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

const SUPABASE_JWT_SECRET  = (process.env.SUPABASE_JWT_SECRET   ?? "").trim();
const SUPABASE_URL         = (process.env.SUPABASE_URL          ?? process.env.VITE_SUPABASE_URL          ?? _FALLBACK_URL).trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const SUPABASE_ANON_KEY    = (process.env.SUPABASE_ANON_KEY     ?? process.env.VITE_SUPABASE_ANON_KEY     ?? _FALLBACK_ANON).trim();
const INTERNAL_API_SECRET  = (process.env.INTERNAL_API_SECRET   ?? "").trim();

const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.PLATFORM_ADMIN_EMAILS ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const LOCKDOWN_ENABLED   = process.env.LOCKDOWN_ENABLED === "true";
const LOCKDOWN_ALLOWLIST = new Set(
  (process.env.LOCKDOWN_ALLOWLIST ?? "seomidt@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ── Path 1: HMAC-SHA256 local verify (HS256 tokens) ──────────────────────────

function verifyLocalJwt(token: string): { id: string; email?: string } | null {
  if (!SUPABASE_JWT_SECRET) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;

    // Only attempt HS256 verification
    const header = JSON.parse(b64UrlDecode(h).toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "HS256") return null;

    const expected = createHmac("sha256", SUPABASE_JWT_SECRET)
      .update(`${h}.${p}`).digest("base64url");
    const expBuf = Buffer.from(expected, "utf8");
    const actBuf = Buffer.from(sig, "utf8");
    if (expBuf.length !== actBuf.length || !timingSafeEqual(expBuf, actBuf)) return null;

    const payload = JSON.parse(b64UrlDecode(p).toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;
    return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
  } catch { return null; }
}

// ── Path 2: JWKS verify (ES256 tokens — Supabase default) ────────────────────
// Fetches Supabase's public JWKS once and caches for 1 hour.
// Only requires SUPABASE_URL — no API key needed (JWKS is a public endpoint).

interface JWK { kty: string; alg?: string; kid?: string; crv?: string; x?: string; y?: string; n?: string; e?: string; use?: string; }
let _jwksCache: { keys: JWK[]; exp: number } | null = null;

async function getJWKS(): Promise<JWK[]> {
  if (_jwksCache && _jwksCache.exp > Date.now()) return _jwksCache.keys;
  if (!SUPABASE_URL) return [];
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/jwks`);
    if (!res.ok) return [];
    const data = (await res.json()) as { keys?: JWK[] };
    _jwksCache = { keys: data.keys ?? [], exp: Date.now() + 3_600_000 };
    return _jwksCache.keys;
  } catch { return []; }
}

async function verifyES256(token: string): Promise<{ id: string; email?: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;

    const header = JSON.parse(b64UrlDecode(h).toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "ES256") return null;

    const keys = await getJWKS();
    if (!keys.length) return null;

    const jwk = keys.find((k) => !header.kid || k.kid === header.kid) ?? keys[0];
    if (!jwk) return null;

    const cryptoKey = await webcrypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const sigInput = new TextEncoder().encode(`${h}.${p}`);
    const sigBytes = b64UrlDecode(sig);

    const valid = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      sigBytes,
      sigInput,
    );
    if (!valid) return null;

    const payload = JSON.parse(b64UrlDecode(p).toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;
    return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
  } catch { return null; }
}

// ── Path 3: Supabase API fallback (network call) ──────────────────────────────

interface SupabaseUserResponse { id?: string; email?: string; error?: string; message?: string; }
const _userCache = new Map<string, { id: string; email?: string; exp: number }>();

async function verifyViaSupabaseApi(token: string): Promise<{ id: string; email?: string } | null> {
  const cached = _userCache.get(token);
  if (cached && cached.exp > Date.now()) return { id: cached.id, email: cached.email };

  const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !apikey) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SupabaseUserResponse;
    if (!data.id) return null;
    _userCache.set(token, { id: data.id, email: data.email, exp: Date.now() + 30_000 });
    return { id: data.id, email: data.email };
  } catch { return null; }
}

// ── Membership lookup ─────────────────────────────────────────────────────────

const _memberCache = new Map<string, { orgId: string; role: string; exp: number }>();

/** UUID v4 pattern — must pass before we use a value as a DB UUID column. */
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _isUuid(s: string): boolean { return _UUID_RE.test(s); }

/**
 * Resolve a tenant slug (e.g. "blissops-main") to the org's real UUID via
 * the Supabase REST API.  Returns null when not found or on network error.
 */
async function _resolveSlugToUuid(
  slug: string,
  supabaseUrl: string,
  apikey: string,
): Promise<string | null> {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/organizations?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: { apikey, Authorization: `Bearer ${apikey}` } },
    );
    const rows = (await r.json()) as Array<{ id: string }>;
    const id = rows[0]?.id ?? null;
    return id && _isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

async function lookupMembership(userId: string): Promise<{ orgId: string; role: string }> {
  const hit = _memberCache.get(userId);
  if (hit && hit.exp > Date.now()) return { orgId: hit.orgId, role: hit.role };

  const apikey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !apikey) {
    throw new Error("lookupMembership: SUPABASE_URL eller apikey er ikke konfigureret");
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(userId)}&select=organization_id,role&limit=1`,
      { headers: { apikey, Authorization: `Bearer ${apikey}` } },
    );
    const rows = (await res.json()) as Array<{ organization_id: string; role: string }>;

    // Happy path: membership row exists and contains a real UUID.
    if (rows[0]?.organization_id && _isUuid(rows[0].organization_id)) {
      const orgId = rows[0].organization_id;
      const role  = rows[0].role ?? "member";
      _memberCache.set(userId, { orgId, role, exp: Date.now() + 30_000 });
      return { orgId, role };
    }

    // No membership row (or the stored value is not a UUID).
    // Attempt to resolve the default tenant slug to its real UUID.
    const DEFAULT_SLUG = "blissops-main";
    const resolvedId = await _resolveSlugToUuid(DEFAULT_SLUG, SUPABASE_URL, apikey);
    if (resolvedId) {
      const role = rows[0]?.role ?? "member";
      console.warn(
        `[auth] lookupMembership: ingen membership-række for ${userId}; ` +
        `bruger slug-opslag → org UUID ${resolvedId}`,
      );
      _memberCache.set(userId, { orgId: resolvedId, role, exp: Date.now() + 30_000 });
      return { orgId: resolvedId, role };
    }

    throw new Error(
      `lookupMembership: bruger ${userId} har ingen organization_members-række, ` +
      `og slug '${DEFAULT_SLUG}' kunne ikke resolves til en UUID`,
    );
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ── AuthUser ──────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:             string;
  email?:         string;
  organizationId: string;
  role:           string;
}

// ── authenticate() ────────────────────────────────────────────────────────────

export async function authenticate(req: IncomingMessage): Promise<
  | { user: AuthUser; status: "ok" }
  | { user: null; status: "unauthenticated" | "lockdown" }
> {
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

  // Try all three verification paths in order of speed/reliability
  let jwt =
    verifyLocalJwt(token) ??           // HS256: <1ms, no network
    (await verifyES256(token)) ??      // ES256: JWKS cached after first call
    (await verifyViaSupabaseApi(token)); // Fallback: direct API call

  if (!jwt) return { user: null, status: "unauthenticated" };

  if (LOCKDOWN_ENABLED && jwt.email && !LOCKDOWN_ALLOWLIST.has(jwt.email.toLowerCase())) {
    return { user: null, status: "lockdown" };
  }

  if (jwt.email && PLATFORM_ADMIN_EMAILS.has(jwt.email.toLowerCase())) {
    try {
      const { orgId } = await lookupMembership(jwt.id);
      return {
        user: { id: jwt.id, email: jwt.email, organizationId: orgId, role: "platform_admin" },
        status: "ok",
      };
    } catch (err) {
      console.error("[auth] platform_admin lookupMembership fejlede:", err);
      return { user: null, status: "unauthenticated" };
    }
  }

  try {
    const { orgId, role } = await lookupMembership(jwt.id);
    return {
      user: { id: jwt.id, email: jwt.email, organizationId: orgId, role },
      status: "ok",
    };
  } catch (err) {
    console.error("[auth] lookupMembership fejlede:", err);
    return { user: null, status: "unauthenticated" };
  }
}
