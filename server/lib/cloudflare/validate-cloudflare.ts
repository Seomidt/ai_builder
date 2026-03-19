import { getZoneSetting, listDnsRecords, getRuleset } from "./client";

export interface ManagedRulesReport {
  cloudflareManaged: "ok" | "missing";
  owaspCore: "ok" | "missing";
}

export interface RateLimitsReport {
  auth: "ok" | "missing";
  ai: "ok" | "missing";
  total: number;
}

export interface CustomWafRule {
  description: string;
  expression: string;
  action: string;
}

export interface SkipRule {
  description: string;
  expression: string;
}

export interface CloudflareValidationReport {
  ssl: boolean;
  https: boolean;
  hsts: boolean;
  dns: boolean;
  managedRules: ManagedRulesReport;
  customWafRules: CustomWafRule[];
  rateLimits: RateLimitsReport;
  cache: boolean;
  skips: SkipRule[];
  allPassed: boolean;
  criticalPassed: boolean;
  details: Record<string, unknown>;
}

// Critical checks — failure = exit 1
const CRITICAL = ["ssl", "https", "hsts", "dns", "managedCloudflare", "managedOwasp", "rlAuth", "rlAi"];

interface CheckResult { ok: boolean; detail: unknown }
type Check = { name: string; critical: boolean; fn: () => Promise<CheckResult> };

const checks: Check[] = [
  {
    name: "ssl",
    critical: true,
    fn: async () => {
      const s = await getZoneSetting("ssl");
      return { ok: s.value === "strict", detail: s.value };
    },
  },
  {
    name: "https",
    critical: true,
    fn: async () => {
      const s = await getZoneSetting("always_use_https");
      return { ok: s.value === "on", detail: s.value };
    },
  },
  {
    name: "hsts",
    critical: true,
    fn: async () => {
      const s = await getZoneSetting("security_header");
      const hsts = (s.value as Record<string, unknown>)?.strict_transport_security as
        | Record<string, unknown>
        | undefined;
      return { ok: hsts?.enabled === true, detail: hsts };
    },
  },
  {
    name: "dns",
    critical: true,
    fn: async () => {
      const records = await listDnsRecords();
      const candidates = records.filter(
        (r) => (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") &&
          r.name.split(".").length <= 3
      );
      const allProxied = candidates.length > 0 && candidates.every((r) => r.proxied);
      return {
        ok: allProxied,
        detail: candidates.map((r) => ({ name: r.name, type: r.type, proxied: r.proxied })),
      };
    },
  },
  {
    name: "managedCloudflare",
    critical: true,
    fn: async () => {
      const ruleset = await getRuleset("http_request_firewall_managed");
      const rules = ruleset?.rules ?? [];
      const ok = rules.some(
        (r) => (r.action_parameters as Record<string, unknown> | undefined)?.id === "efb7b8c949ac4650a09736fc376e9aee"
      );
      return { ok, detail: { ruleCount: rules.length, found: ok } };
    },
  },
  {
    name: "managedOwasp",
    critical: true,
    fn: async () => {
      const ruleset = await getRuleset("http_request_firewall_managed");
      const rules = ruleset?.rules ?? [];
      const ok = rules.some(
        (r) => (r.action_parameters as Record<string, unknown> | undefined)?.id === "4814384a9e5d4991b9815dcfc25d2f1f"
      );
      return { ok, detail: { found: ok } };
    },
  },
  {
    name: "rlAuth",
    critical: true,
    fn: async () => {
      const ruleset = await getRuleset("http_ratelimit");
      const rules = ruleset?.rules ?? [];
      const ok = rules.some((r) => r.description?.includes("AUTH rate limit"));
      return { ok, detail: { ruleCount: rules.length, hasAuth: ok } };
    },
  },
  {
    name: "rlAi",
    critical: true,
    fn: async () => {
      const ruleset = await getRuleset("http_ratelimit");
      const rules = ruleset?.rules ?? [];
      const ok = rules.some((r) => r.description?.includes("AI rate limit"));
      return { ok, detail: { hasAi: ok } };
    },
  },
  {
    name: "cache",
    critical: false,
    fn: async () => {
      const ruleset = await getRuleset("http_request_cache_settings");
      const rules = ruleset?.rules ?? [];
      const hasStatic = rules.some((r) => r.description?.includes("STATIC ASSETS"));
      const hasApiBypass = rules.some((r) => r.description?.includes("API BYPASS"));
      return { ok: hasStatic && hasApiBypass, detail: { ruleCount: rules.length, hasStatic, hasApiBypass } };
    },
  },
  {
    name: "customWaf",
    critical: false,
    fn: async () => {
      const ruleset = await getRuleset("http_request_firewall_custom");
      const rules = ruleset?.rules ?? [];
      const challenge = rules.filter((r) => r.action !== "skip");
      return {
        ok: challenge.length > 0,
        detail: challenge.map((r) => ({ description: r.description, action: r.action })),
      };
    },
  },
  {
    name: "skips",
    critical: false,
    fn: async () => {
      const ruleset = await getRuleset("http_request_firewall_custom");
      const rules = ruleset?.rules ?? [];
      const skips = rules.filter((r) => r.action === "skip");
      return {
        ok: true, // skips are optional
        detail: skips.map((r) => ({ description: r.description, expression: r.expression })),
      };
    },
  },
];

export async function validateCloudflare(): Promise<CloudflareValidationReport> {
  console.log("\n[CF:Validate] Running Cloudflare Pro validation...\n");

  const results: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};

  for (const check of checks) {
    try {
      const { ok, detail } = await check.fn();
      results[check.name] = ok;
      details[check.name] = detail;
      const icon = ok ? "✔" : "✗";
      const tag = check.critical ? "" : " (non-critical)";
      console.log(`  [${icon}] ${check.name}${tag}: ${JSON.stringify(detail)}`);
    } catch (err) {
      results[check.name] = false;
      details[check.name] = { error: (err as Error).message };
      console.error(`  [✗] ${check.name}: ERROR — ${(err as Error).message}`);
    }
  }

  const criticalPassed = CRITICAL.every((k) => results[k] !== false);
  const allPassed = Object.values(results).every(Boolean);

  console.log(`\n[CF:Validate] Critical: ${criticalPassed ? "ALL PASSED ✔" : "FAILED ✗"}`);
  console.log(`[CF:Validate] Overall:  ${allPassed ? "ALL PASSED ✔" : "SOME NON-CRITICAL FAILED"}\n`);

  const rlRuleset = await getRuleset("http_ratelimit").catch(() => null);
  const rlRules = rlRuleset?.rules ?? [];
  const customRuleset = await getRuleset("http_request_firewall_custom").catch(() => null);
  const customRules = customRuleset?.rules ?? [];

  return {
    ssl: results.ssl ?? false,
    https: results.https ?? false,
    hsts: results.hsts ?? false,
    dns: results.dns ?? false,
    managedRules: {
      cloudflareManaged: results.managedCloudflare ? "ok" : "missing",
      owaspCore: results.managedOwasp ? "ok" : "missing",
    },
    customWafRules: (customRules.filter((r) => r.action !== "skip") as CustomWafRule[]).map((r) => ({
      description: r.description ?? "",
      expression: r.expression,
      action: r.action,
    })),
    rateLimits: {
      auth: results.rlAuth ? "ok" : "missing",
      ai: results.rlAi ? "ok" : "missing",
      total: rlRules.length,
    },
    cache: results.cache ?? false,
    skips: (customRules.filter((r) => r.action === "skip") as SkipRule[]).map((r) => ({
      description: r.description ?? "",
      expression: r.expression,
    })),
    allPassed,
    criticalPassed,
    details,
  };
}
