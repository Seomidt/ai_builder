import { getRuleset, putRuleset, RulesetRule } from "./client";

/**
 * SKIP RULES — paths exempted from WAF challenge/block
 *
 * Skip rules are placed FIRST in http_request_firewall_custom so they
 * take precedence over challenge rules. They use action="skip" to bypass
 * the current ruleset's challenge actions.
 *
 * Only paths where challenge is genuinely impossible or harmful are skipped.
 * Sensitive admin routes are intentionally NOT skipped.
 */

const SKIP_RULES: Array<{
  description: string;
  expression: string;
  reason: string;
}> = [
  {
    description: "SKIP: CSP report endpoint — browser POST, no user interaction possible",
    expression: '(http.request.uri.path eq "/api/security/csp-report" and http.request.method eq "POST")',
    // Browsers send CSP violation reports automatically (no user action).
    // A managed_challenge response would reject all reports silently.
    reason: "Browser-automated POST — challenge cannot be completed",
  },
  {
    description: "SKIP: Stripe webhook — signed POST from Stripe servers",
    expression: '(http.request.uri.path eq "/api/admin/stripe/webhook" and http.request.method eq "POST")',
    // Stripe sends signed webhook events from their IP ranges.
    // Stripe cannot complete a challenge — this would break all billing events.
    reason: "Stripe-signed machine POST — challenge would break billing webhooks",
  },
];

const FIREWALL_CUSTOM_PHASE = "http_request_firewall_custom";

export interface SkipSetupResult {
  skipsApplied: number;
  skips: Array<{ description: string; expression: string; reason: string }>;
}

export async function setupSkipRules(): Promise<SkipSetupResult> {
  console.log("[CF:Skip] Configuring WAF skip rules for automated endpoints...");

  const existing = await getRuleset(FIREWALL_CUSTOM_PHASE);
  const existingRules: RulesetRule[] = existing?.rules ?? [];

  // Separate existing skip rules from challenge rules
  const existingSkips = existingRules.filter((r) => r.action === "skip");
  const nonSkipRules = existingRules.filter((r) => r.action !== "skip");

  const mergedSkips: RulesetRule[] = [...existingSkips];

  for (const desired of SKIP_RULES) {
    const idx = mergedSkips.findIndex((r) => r.description === desired.description);
    const rule: RulesetRule = {
      description: desired.description,
      expression: desired.expression,
      action: "skip",
      action_parameters: {
        // Skip all rules in current ruleset (WAF challenge rules)
        ruleset: "current",
      },
      enabled: true,
    };

    if (idx >= 0) {
      const old = mergedSkips[idx];
      if (old.expression !== desired.expression) {
        mergedSkips[idx] = { ...old, ...rule };
        console.log(`[CF:Skip] Updated skip: ${desired.description}`);
      } else {
        console.log(`[CF:Skip] Skip unchanged: ${desired.description}`);
      }
    } else {
      mergedSkips.push(rule);
      console.log(`[CF:Skip] Added skip: ${desired.description}`);
      console.log(`[CF:Skip]   Reason: ${desired.reason}`);
    }
  }

  // Skip rules MUST be first — they must execute before challenge rules
  const finalRules = [...mergedSkips, ...nonSkipRules];

  await putRuleset(FIREWALL_CUSTOM_PHASE, finalRules);
  console.log(`[CF:Skip] ${SKIP_RULES.length} skip rules applied (placed first) ✔`);

  return {
    skipsApplied: SKIP_RULES.length,
    skips: SKIP_RULES,
  };
}

export async function verifySkipRules(): Promise<SkipSetupResult> {
  const existing = await getRuleset(FIREWALL_CUSTOM_PHASE);
  const rules = existing?.rules ?? [];
  const skips = rules.filter((r) => r.action === "skip");
  return {
    skipsApplied: skips.length,
    skips: SKIP_RULES.filter((s) => skips.some((r) => r.description === s.description)),
  };
}
