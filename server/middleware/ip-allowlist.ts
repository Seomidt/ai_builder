/**
 * Phase 7 — IP Allowlist Middleware
 * INV-SEC4: IP allowlists must be enforced before request execution.
 * Empty allowlist = unrestricted. IPv4 + IPv6 CIDR supported.
 */

import type { Request, Response, NextFunction } from "express";
import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "0.0.0.0";
}

// ─── CIDR matching ────────────────────────────────────────────────────────────

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function isIpv4(ip: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip);
}

function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    if (ip === cidr) return true;
    if (cidr === "0.0.0.0/0" || cidr === "::/0") return true;

    if (isIpv4(ip) && cidr.includes(".")) {
      const [range, bits] = cidr.split("/");
      const prefixLen = parseInt(bits, 10);
      if (isNaN(prefixLen)) return false;
      const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
      return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
    }

    // IPv6: simple equality or prefix match (basic)
    if (!isIpv4(ip) && !cidr.includes(".")) {
      if (!cidr.includes("/")) return ip === cidr;
      const [range, bits] = cidr.split("/");
      const prefixLen = parseInt(bits, 10);
      const ipNorm = ip.split(":").slice(0, Math.ceil(prefixLen / 16)).join(":");
      const rangeNorm = range.split(":").slice(0, Math.ceil(prefixLen / 16)).join(":");
      return ipNorm === rangeNorm;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── verifyIpAllowed ─────────────────────────────────────────────────────────

export async function verifyIpAllowed(params: {
  tenantId: string;
  ip: string;
}): Promise<{ allowed: boolean; matchedRange?: string; reason: string }> {
  const { tenantId, ip } = params;
  const client = getClient();
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT ip_range FROM public.tenant_ip_allowlists WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );

    if (rows.rows.length === 0) {
      return { allowed: true, reason: "No allowlist configured — unrestricted" };
    }

    for (const row of rows.rows) {
      if (isIpInCidr(ip, row.ip_range)) {
        return { allowed: true, matchedRange: row.ip_range, reason: `IP matched allowlist entry: ${row.ip_range}` };
      }
    }

    return { allowed: false, reason: `IP ${ip} not in tenant allowlist (${rows.rows.length} entries)` };
  } finally {
    await client.end();
  }
}

// ─── ipAllowlistMiddleware ────────────────────────────────────────────────────
// INV-SEC4: Enforced before request execution.
// Skips check if no tenant context (internal/admin without tenant).

export function ipAllowlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenantId = (req as any).user?.organizationId ?? (req as any).resolvedActor?.tenantId;
  if (!tenantId || tenantId === "demo-org") return next();

  const ip = getClientIp(req);

  verifyIpAllowed({ tenantId, ip })
    .then(({ allowed, reason }) => {
      if (!allowed) {
        res.status(403).json({
          error: "Access denied: IP not in allowlist",
          ip,
          reasonCode: "IP_BLOCKED",
          note: "INV-SEC4: IP allowlist enforced before request execution.",
        });
        return;
      }
      next();
    })
    .catch(() => next());
}

// ─── Allowlist management helpers ─────────────────────────────────────────────

export async function addIpAllowlistEntry(params: {
  tenantId: string;
  ipRange: string;
  description?: string;
}): Promise<{ id: string; tenantId: string; ipRange: string }> {
  const { tenantId, ipRange, description } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_ip_allowlists (id, tenant_id, ip_range, description)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (tenant_id, ip_range) DO UPDATE SET description = EXCLUDED.description
       RETURNING id`,
      [tenantId, ipRange, description ?? null],
    );
    return { id: row.rows[0].id, tenantId, ipRange };
  } finally {
    await client.end();
  }
}

export async function removeIpAllowlistEntry(params: {
  tenantId: string;
  ipRange: string;
}): Promise<{ removed: boolean }> {
  const { tenantId, ipRange } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `DELETE FROM public.tenant_ip_allowlists WHERE tenant_id = $1 AND ip_range = $2 RETURNING id`,
      [tenantId, ipRange],
    );
    return { removed: row.rows.length > 0 };
  } finally {
    await client.end();
  }
}

export async function listTenantIpAllowlist(tenantId: string): Promise<Array<{
  id: string;
  ipRange: string;
  description: string | null;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, ip_range, description, created_at FROM public.tenant_ip_allowlists WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      ipRange: r.ip_range,
      description: r.description,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}
