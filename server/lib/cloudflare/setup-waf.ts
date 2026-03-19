import { listWafPackages, updateWafPackage, getRuleset, putRuleset, cfFetch, zoneUrl, RulesetRule } from "./client";

// ── Managed Ruleset IDs (fetched live once, stored as constants for idempotency) ──
// These are account-level rulesets available on this zone. IDs are stable.
const MANAGED_RULESETS: Array<{ id: string; description: string }> = [
  {
    id: "efb7b8c949ac4650a09736fc376e9aee",
    description: "Execute Cloudflare Managed Ruleset",
  },
  {
    id: "4814384a9e5d4991b9815dcfc25d2f1f",
    description: "Execute Cloudflare OWASP Core Ruleset",
  },
];

// ── Custom WAF Rules ──
// These remain because managed rules do NOT cover app-specific path-targeting.
// - AUTH PROTECTION: managed_challenge on /api/auth — extra layer beyond OWASP
// - AI PROTECTION: managed_challenge on /api/ai — expensive endpoint, explicit challenge
// - GEO FILTER: challenge non-DK/US/DE — business model constraint, not covered by managed rules
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
    expression: '(ip.geoip.country ne "DK" and ip.geoip.country ne "US" and ip.geoip.country ne "DE")',
    action: "managed_challenge",
  },
];

const FIREWALL_CUSTOM_PHASE = "http_request_firewall_custom";
const FIREWALL_MANAGED_PHASE = "http_request_firewall_managed";

export interface ManagedRulesResult {
  cloudflareManaged: boolean;
  owaspCore: boolean;
  rulesDeployed: number;
}

export interface WafSetupResult {
  managedRules: ManagedRulesResult;
  customRulesApplied: number;
}

// ── TASK 2: Enable Cloudflare Managed Rules + OWASP ──────────────────────────
export async function setupWAFManagedRules(): Promise<ManagedRulesResult> {
  console.log("[CF:WAF] Enabling managed rules (Cloudflare Managed + OWASP)...");

  // 1. Fetch current entrypoint state
  let existingRules: RulesetRule[] = [];
  try {
    const existing = await getRuleset(FIREWALL_MANAGED_PHASE);
    existingRules = existing?.rules ?? [];
  } catch {
    existingRules = [];
  }

  // 2. Build merged rule list — idempotent: skip if already present
  const merged: RulesetRule[] = [...existingRules];

  for (const rs of MANAGED_RULESETS) {
    const alreadyDeployed = merged.some(
      (r) => (r.action_parameters as Record<string, unknown> | undefined)?.id === rs.id
    );
    if (alreadyDeployed) {
      console.log(`[CF:WAF] Managed ruleset already deployed: ${rs.description}`);
      continue;
    }
    merged.push({
      action: "execute",
      action_parameters: { id: rs.id },
      expression: "true",
      description: rs.description,
      enabled: true,
    });
    console.log(`[CF:WAF] Deploying managed ruleset: ${rs.description}`);
  }

  // 3. PUT entrypoint
  try {
    await putRuleset(FIREWALL_MANAGED_PHASE, merged);
    console.log("[CF:WAF] Managed rules phase written ✔");
  } catch (err) {
    // Also attempt legacy WAF packages API as fallback
    console.warn(`[CF:WAF] Managed phase PUT failed: ${(err as Error).message}`);
    console.log("[CF:WAF] Attempting legacy WAF packages fallback...");
    await enableLegacyWafPackages();
  }

  // 4. Verify
  const result = await verifyManagedRules();
  return result;
}

async function enableLegacyWafPackages(): Promise<void> {
  const packages = await listWafPackages();
  for (const pkg of packages) {
    const name = pkg.name.toLowerCase();
    if (name.includes("cloudflare managed") || name.includes("owasp") || name.includes("cloudflare specials")) {
      try {
        await updateWafPackage(pkg.id, { action_mode: "block" });
        console.log(`[CF:WAF] Legacy package "${pkg.name}" → block ✔`);
      } catch (err) {
        console.warn(`[CF:WAF] Legacy package "${pkg.name}" failed: ${(err as Error).message}`);
      }
    }
  }
}

export async function verifyManagedRules(): Promise<ManagedRulesResult> {
  let cloudflareManaged = false;
  let owaspCore = false;
  let rulesDeployed = 0;

  try {
    const ruleset = await getRuleset(FIREWALL_MANAGED_PHASE);
    const rules = ruleset?.rules ?? [];
    rulesDeployed = rules.length;

    for (const r of rules) {
      const id = (r.action_parameters as Record<string, unknown> | undefined)?.id as string | undefined;
      if (id === "efb7b8c949ac4650a09736fc376e9aee") cloudflareManaged = true;
      if (id === "4814384a9e5d4991b9815dcfc25d2f1f") owaspCore = true;
    }
  } catch {
    // Phase not available — check legacy
    const packages = await listWafPackages();
    for (const pkg of packages) {
      const name = pkg.name.toLowerCase();
      if (name.includes("cloudflare managed") && pkg.status === "active") cloudflareManaged = true;
      if (name.includes("owasp") && pkg.status === "active") owaspCore = true;
    }
  }

  const icon = (v: boolean) => v ? "✔" : "✗";
  console.log(`[CF:WAF] Cloudflare Managed Rules: ${icon(cloudflareManaged)}`);
  console.log(`[CF:WAF] OWASP Core Ruleset: ${icon(owaspCore)}`);

  return { cloudflareManaged, owaspCore, rulesDeployed };
}

// ── TASK 5: Custom WAF Rules — kept because managed rules don't target these paths ──
export async function setupCustomWAFRules(): Promise<number> {
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
        console.log(`[CF:WAF] Updated: ${desired.description}`);
      } else {
        console.log(`[CF:WAF] Unchanged: ${desired.description}`);
      }
    } else {
      merged.push(rule);
      console.log(`[CF:WAF] Added: ${desired.description}`);
    }
  }

  await putRuleset(FIREWALL_CUSTOM_PHASE, merged);
  console.log(`[CF:WAF] ${CUSTOM_RULES.length} custom rules applied ✔`);
  return CUSTOM_RULES.length;
}

// Legacy unified export — kept for backwards compat
export async function setupWAF(): Promise<WafSetupResult> {
  const managedRules = await setupWAFManagedRules();
  const customRulesApplied = await setupCustomWAFRules();
  return { managedRules, customRulesApplied };
}
