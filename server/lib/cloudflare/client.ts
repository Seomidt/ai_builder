const CF_BASE = "https://api.cloudflare.com/client/v4";

type AuthMode = "token" | "global_key";

interface Credentials {
  mode: AuthMode;
  zoneId: string;
  token?: string;
  email?: string;
  apiKey?: string;
}

function getCredentials(): Credentials {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) throw new Error("CLOUDFLARE_ZONE_ID is not set");

  const email = process.env.CLOUDFLARE_EMAIL ?? process.env.CF_EMAIL;
  const apiKey =
    process.env.CLOUDFLARE_ZONE_API_TOKEN ??
    process.env.CF_API_KEY ??
    process.env.CLOUDFLARE_API_KEY;

  const token =
    process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;

  // Global API Key requires both email and key
  if (email && apiKey) {
    return { mode: "global_key", zoneId, email, apiKey };
  }

  // Bearer token
  if (token) {
    return { mode: "token", zoneId, token };
  }

  throw new Error(
    "Cloudflare auth not configured. Set CLOUDFLARE_EMAIL + CLOUDFLARE_ZONE_API_TOKEN " +
    "(Global API Key mode) or CF_API_TOKEN (Bearer token mode)."
  );
}

function buildHeaders(creds: Credentials): Record<string, string> {
  if (creds.mode === "global_key") {
    return {
      "X-Auth-Email": creds.email!,
      "X-Auth-Key": creds.apiKey!,
      "Content-Type": "application/json",
    };
  }
  return {
    Authorization: `Bearer ${creds.token}`,
    "Content-Type": "application/json",
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function cfFetch<T = unknown>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  attempt = 0
): Promise<T> {
  const creds = getCredentials();
  const url = endpoint.startsWith("http") ? endpoint : `${CF_BASE}${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: buildHeaders(creds),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && attempt < 3) {
    const wait = 1000 * 2 ** attempt;
    console.warn(`[CF] Rate limited — retry in ${wait}ms`);
    await sleep(wait);
    return cfFetch(endpoint, method, body, attempt + 1);
  }

  if (res.status >= 500 && attempt < 3) {
    const wait = 500 * 2 ** attempt;
    console.warn(`[CF] Server error ${res.status} — retry in ${wait}ms`);
    await sleep(wait);
    return cfFetch(endpoint, method, body, attempt + 1);
  }

  const json = (await res.json()) as {
    success: boolean;
    result?: T;
    errors?: { message: string }[];
  };

  if (!json.success) {
    const msg =
      json.errors?.map((e) => e.message).join(", ") ?? `HTTP ${res.status}`;
    throw new Error(`[CF] ${method} ${endpoint} failed: ${msg} (status: ${res.status})`);
  }

  return json.result as T;
}

export function zoneUrl(path: string): string {
  const { zoneId } = getCredentials();
  return `/zones/${zoneId}${path}`;
}

export interface ZoneSetting {
  id: string;
  value: unknown;
  modified_on?: string;
  editable?: boolean;
}

export async function getZoneSettings(): Promise<ZoneSetting[]> {
  return cfFetch<ZoneSetting[]>(zoneUrl("/settings"), "GET");
}

export async function getZoneSetting(key: string): Promise<ZoneSetting> {
  return cfFetch<ZoneSetting>(zoneUrl(`/settings/${key}`), "GET");
}

export async function updateZoneSetting(
  key: string,
  value: unknown
): Promise<ZoneSetting> {
  return cfFetch<ZoneSetting>(zoneUrl(`/settings/${key}`), "PATCH", { value });
}

export interface RulesetRule {
  id?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  enabled?: boolean;
}

export interface Ruleset {
  id?: string;
  phase?: string;
  rules?: RulesetRule[];
}

export async function getRuleset(phase: string): Promise<Ruleset | null> {
  try {
    return await cfFetch<Ruleset>(
      zoneUrl(`/rulesets/phases/${phase}/entrypoint`),
      "GET"
    );
  } catch {
    return null;
  }
}

export async function putRuleset(
  phase: string,
  rules: RulesetRule[]
): Promise<Ruleset> {
  return cfFetch<Ruleset>(
    zoneUrl(`/rulesets/phases/${phase}/entrypoint`),
    "PUT",
    { rules }
  );
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export async function listDnsRecords(): Promise<DnsRecord[]> {
  return cfFetch<DnsRecord[]>(zoneUrl("/dns_records?per_page=100"), "GET");
}

export async function updateDnsRecord(
  id: string,
  patch: Partial<DnsRecord>
): Promise<DnsRecord> {
  return cfFetch<DnsRecord>(zoneUrl(`/dns_records/${id}`), "PATCH", patch);
}

export interface WafPackage {
  id: string;
  name: string;
  status?: string;
  action_mode?: string;
}

export async function listWafPackages(): Promise<WafPackage[]> {
  try {
    return await cfFetch<WafPackage[]>(
      zoneUrl("/firewall/waf/packages"),
      "GET"
    );
  } catch {
    return [];
  }
}

export async function updateWafPackage(
  packageId: string,
  patch: Partial<WafPackage>
): Promise<WafPackage> {
  return cfFetch<WafPackage>(
    zoneUrl(`/firewall/waf/packages/${packageId}`),
    "PATCH",
    patch
  );
}
