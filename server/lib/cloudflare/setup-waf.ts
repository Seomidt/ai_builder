import { listWafPackages, updateWafPackage, getRuleset, putRuleset, RulesetRule } from "./client";

const CUSTOM_RULES: Array<{ description: string; expression: string; action: string }> = [
  {
    description: "AUTH PROTECTION — challenge all /api/auth traffic",
    expression: '(http.request.uri.path contains "/api/auth")',
    action: "managed_challenge",
  },
  {
    description: "AI PROTECTION — challenge all /api/ai traffic",
    expression: '(http.request.uri.path contains "/api/ai")',
    action: "managed_challenge",
  },
  {
    description: "GEO FILTER — challenge non-DK/US/DE requests",
    expression:
      '(ip.geoip.country ne "DK" and ip.geoip.country ne "US" and ip.geoip.country ne "DE")',
    action: "managed_challenge",
  },
];

const FIREWALL_CUSTOM_PHASE = "http_request_firewall_custom";
const FIREWALL_MANAGED_PHASE = "http_request_firewall_managed";

export interface WafSetupResult {
  managedRulesEnabled: boolean;
  customRulesApplied: number;
  packagesFound: number;
}

async function setupManagedWafRules(): Promise<{ enabled: boolean; packagesFound: number }> {
  console.log("[CF:WAF] Checking managed WAF packages...");
  const packages = await listWafPackages();

  if (packages.length === 0) {
    console.warn("[CF:WAF] No WAF packages found — plan may not include managed WAF");
    return { enabled: false, packagesFound: 0 };
  }

  let anyEnabled = false;

  for (const pkg of packages) {
    const nameNorm = pkg.name.toLowerCase();
    if (
      nameNorm.includes("cloudflare managed") ||
      nameNorm.includes("owasp") ||
      nameNorm.includes("cloudflare specials")
    ) {
      try {
        if (pkg.action_mode !== "simulate" && pkg.status === "active") {
          console.log(`[CF:WAF] Package "${pkg.name}" already active ✔`);
          anyEnabled = true;
          continue;
        }
        await updateWafPackage(pkg.id, { action_mode: "block" });
        console.log(`[CF:WAF] Package "${pkg.name}" set to block ✔`);
        anyEnabled = true;
      } catch (err) {
        console.warn(`[CF:WAF] Could not update package "${pkg.name}": ${(err as Error).message}`);
      }
    }
  }

  // Attempt to enable via rulesets API (newer plans)
  try {
    const existing = await getRuleset(FIREWALL_MANAGED_PHASE);
    if (existing?.id) {
      console.log("[CF:WAF] Managed rules phase ruleset found ✔");
      anyEnabled = true;
    }
  } catch {
    // not available on this plan
  }

  return { enabled: anyEnabled, packagesFound: packages.length };
}

async function setupCustomWafRules(): Promise<number> {
  console.log("[CF:WAF] Applying custom WAF rules...");

  const existing = await getRuleset(FIREWALL_CUSTOM_PHASE);
  const existingRules: RulesetRule[] = existing?.rules ?? [];

  const merged: RulesetRule[] = [...existingRules];

  for (const desired of CUSTOM_RULES) {
    const idx = merged.findIndex((r) => r.description === desired.description);
    const rule: RulesetRule = {
      description: desired.description,
      expression: desired.expression,
      action: desired.action,
      enabled: true,
    };

    if (idx >= 0) {
      const old = merged[idx];
      if (old.expression !== desired.expression || old.action !== desired.action) {
        merged[idx] = { ...old, ...rule };
        console.log(`[CF:WAF] Updated rule: ${desired.description}`);
      } else {
        console.log(`[CF:WAF] Rule unchanged: ${desired.description}`);
      }
    } else {
      merged.push(rule);
      console.log(`[CF:WAF] Added rule: ${desired.description}`);
    }
  }

  await putRuleset(FIREWALL_CUSTOM_PHASE, merged);
  console.log(`[CF:WAF] ${CUSTOM_RULES.length} custom rules applied ✔`);
  return CUSTOM_RULES.length;
}

export async function setupWAF(): Promise<WafSetupResult> {
  const { enabled, packagesFound } = await setupManagedWafRules();
  const customRulesApplied = await setupCustomWafRules();

  return { managedRulesEnabled: enabled, customRulesApplied, packagesFound };
}
