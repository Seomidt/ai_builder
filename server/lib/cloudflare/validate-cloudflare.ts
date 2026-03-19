import { getZoneSetting, listDnsRecords, listWafPackages, getRuleset } from "./client";

export interface CloudflareValidationReport {
  ssl: boolean;
  https: boolean;
  hsts: boolean;
  dns: boolean;
  waf: boolean;
  rateLimits: boolean;
  cache: boolean;
  allPassed: boolean;
  details: Record<string, unknown>;
}

type Check = { name: string; fn: () => Promise<{ ok: boolean; detail: unknown }> };

const checks: Check[] = [
  {
    name: "ssl",
    fn: async () => {
      const s = await getZoneSetting("ssl");
      return { ok: s.value === "strict", detail: s.value };
    },
  },
  {
    name: "https",
    fn: async () => {
      const s = await getZoneSetting("always_use_https");
      return { ok: s.value === "on", detail: s.value };
    },
  },
  {
    name: "hsts",
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
    fn: async () => {
      const records = await listDnsRecords();
      const candidates = records.filter(
        (r) =>
          (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") &&
          (r.name === "@" || r.name.startsWith("www.") || r.name.split(".").length <= 3)
      );
      const allProxied = candidates.length > 0 && candidates.every((r) => r.proxied);
      return {
        ok: allProxied,
        detail: candidates.map((r) => ({ name: r.name, type: r.type, proxied: r.proxied })),
      };
    },
  },
  {
    name: "waf",
    fn: async () => {
      const packages = await listWafPackages();
      const customRuleset = await getRuleset("http_request_firewall_custom");
      const customRules = customRuleset?.rules ?? [];
      const hasAuthRule = customRules.some((r) => r.expression?.includes("/api/auth"));
      const hasAiRule = customRules.some((r) => r.expression?.includes("/api/ai"));
      const hasGeoRule = customRules.some((r) => r.expression?.includes("ip.geoip.country"));
      return {
        ok: hasAuthRule && hasAiRule && hasGeoRule,
        detail: {
          packagesFound: packages.length,
          customRuleCount: customRules.length,
          hasAuthRule,
          hasAiRule,
          hasGeoRule,
        },
      };
    },
  },
  {
    name: "rateLimits",
    fn: async () => {
      const ruleset = await getRuleset("http_ratelimit");
      const rules = ruleset?.rules ?? [];
      const hasAuth = rules.some((r) => r.description?.includes("AUTH rate limit"));
      const hasAi = rules.some((r) => r.description?.includes("AI rate limit"));
      // Pro plan: 2 rules max — AUTH + AI. Global covered by server-side Phase 44 limiter.
      return {
        ok: hasAuth && hasAi,
        detail: { ruleCount: rules.length, hasAuth, hasAi },
      };
    },
  },
  {
    name: "cache",
    fn: async () => {
      const ruleset = await getRuleset("http_request_cache_settings");
      const rules = ruleset?.rules ?? [];
      const hasStatic = rules.some((r) => r.description?.includes("STATIC ASSETS"));
      const hasApiBypass = rules.some((r) => r.description?.includes("API BYPASS"));
      return {
        ok: hasStatic && hasApiBypass,
        detail: { ruleCount: rules.length, hasStatic, hasApiBypass },
      };
    },
  },
];

export async function validateCloudflare(): Promise<CloudflareValidationReport> {
  console.log("\n[CF:Validate] Running Cloudflare validation...\n");

  const results: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};

  for (const check of checks) {
    try {
      const { ok, detail } = await check.fn();
      results[check.name] = ok;
      details[check.name] = detail;
      const icon = ok ? "✔" : "✗";
      console.log(`  [${icon}] ${check.name}: ${JSON.stringify(detail)}`);
    } catch (err) {
      results[check.name] = false;
      details[check.name] = { error: (err as Error).message };
      console.error(`  [✗] ${check.name}: ERROR — ${(err as Error).message}`);
    }
  }

  const allPassed = Object.values(results).every(Boolean);

  console.log(
    `\n[CF:Validate] Result: ${allPassed ? "ALL PASSED ✔" : "SOME CHECKS FAILED ✗"}\n`
  );

  return {
    ssl: results.ssl ?? false,
    https: results.https ?? false,
    hsts: results.hsts ?? false,
    dns: results.dns ?? false,
    waf: results.waf ?? false,
    rateLimits: results.rateLimits ?? false,
    cache: results.cache ?? false,
    allPassed,
    details,
  };
}
