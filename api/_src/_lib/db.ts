const SUPABASE_URL     = process.env.SUPABASE_URL           ?? "";
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY      ?? "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Case converters ───────────────────────────────────────────────────────────

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] =
      v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
        ? rowToCamel(v as Record<string, unknown>)
        : Array.isArray(v)
        ? (v as unknown[]).map((el) =>
            el !== null && typeof el === "object" && !(el instanceof Date)
              ? rowToCamel(el as Record<string, unknown>)
              : el,
          )
        : v;
  }
  return out;
}

export function objToSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] = v;
  }
  return out;
}

// ── Header factories ──────────────────────────────────────────────────────────

function rlsHeaders(userJwt: string): Record<string, string> {
  return {
    apikey:        SUPABASE_ANON,
    Authorization: `Bearer ${userJwt}`,
    "Content-Type": "application/json",
  };
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey:        SUPABASE_SERVICE,
    Authorization: `Bearer ${SUPABASE_SERVICE}`,
    "Content-Type": "application/json",
    Prefer:        "return=representation",
    ...extra,
  };
}

// ── URL builder ───────────────────────────────────────────────────────────────

function rest(table: string, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams(params).toString();
  return `${SUPABASE_URL}/rest/v1/${table}${qs ? "?" + qs : ""}`;
}

// ── Error handler ─────────────────────────────────────────────────────────────

async function checkOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[db:${ctx}] ${res.status}: ${text}`);
  }
}

// ── Read helpers (RLS — user JWT) ─────────────────────────────────────────────

export async function dbList(
  table: string,
  userJwt: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const res = await fetch(rest(table, params), { headers: rlsHeaders(userJwt) });
  await checkOk(res, `list:${table}`);
  const data = (await res.json()) as Record<string, unknown>[];
  return data.map(rowToCamel);
}

export async function dbGet(
  table: string,
  userJwt: string,
  params: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const rows = await dbList(table, userJwt, params);
  return rows[0] ?? null;
}

// ── Write helpers (service role — admin) ──────────────────────────────────────

export async function dbInsert(
  table: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(rest(table), {
    method:  "POST",
    headers: adminHeaders(),
    body:    JSON.stringify(objToSnake(body)),
  });
  await checkOk(res, `insert:${table}`);
  const data = await res.json();
  const row  = Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data as Record<string, unknown>;
  return rowToCamel(row);
}

export async function dbUpdate(
  table: string,
  params: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(rest(table, params), {
    method:  "PATCH",
    headers: adminHeaders(),
    body:    JSON.stringify(objToSnake(body)),
  });
  await checkOk(res, `update:${table}`);
  const data = await res.json();
  const row  = Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data as Record<string, unknown>;
  return rowToCamel(row);
}

export async function dbUpsert(
  table: string,
  body: Record<string, unknown>,
  onConflict: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(rest(table), {
    method:  "POST",
    headers: adminHeaders({ Prefer: `resolution=merge-duplicates,return=representation`, "on-conflict": onConflict }),
    body:    JSON.stringify(objToSnake(body)),
  });
  await checkOk(res, `upsert:${table}`);
  const data = await res.json();
  const row  = Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data as Record<string, unknown>;
  return rowToCamel(row);
}

export async function dbRpc(
  fn: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method:  "POST",
    headers: adminHeaders({ Prefer: "return=representation" }),
    body:    JSON.stringify(params),
  });
  await checkOk(res, `rpc:${fn}`);
  return res.json();
}

export async function dbCount(
  table: string,
  params: Record<string, string>,
): Promise<number> {
  const res = await fetch(rest(table, { ...params, select: "id" }), {
    headers: { ...adminHeaders(), Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
  });
  const header = res.headers.get("content-range");
  if (header) {
    const m = header.match(/\/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  const data = (await res.json()) as unknown[];
  return data.length;
}
