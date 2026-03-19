import { getRuleset, putRuleset, RulesetRule } from "./client";

const RATE_LIMIT_PHASE = "http_ratelimit";

interface RateLimitConfig {
  description: string;
  expression: string;
  threshold: number;
  period: number;
  action: "block" | "managed_challenge";
}

// Pro plan: max 2 rules in http_ratelimit phase.
// AUTH + AI are highest priority. Global API is covered by server-side Phase 44 rate limiting.
const RATE_LIMIT_RULES: RateLimitConfig[] = [
  {
    description: "AUTH rate limit — 10 req / 60s → block",
    expression: '(http.request.uri.path contains "/api/auth")',
    threshold: 10,
    period: 60,
    action: "block",
  },
  {
    description: "AI rate limit — 20 req / 60s → block",
    expression: '(http.request.uri.path contains "/api/ai")',
    threshold: 20,
    period: 60,
    action: "block",
  },
];

function buildRateLimitRule(cfg: RateLimitConfig): RulesetRule {
  return {
    description: cfg.description,
    expression: cfg.expression,
    // Cloudflare new rate limiting API:
    // - action is "block" or "managed_challenge" (NOT "ratelimit")
    // - ratelimit config is a TOP-LEVEL field on the rule, not in action_parameters
    action: cfg.action,
    ratelimit: {
      characteristics: ["ip.src", "cf.colo.id"],
      period: cfg.period,
      requests_per_period: cfg.threshold,
      mitigation_timeout: cfg.period,
      counting_expression: "",
      requests_to_origin: false,
    },
    enabled: true,
  };
}

export interface RateLimitSetupResult {
  rulesApplied: number;
  phaseAvailable: boolean;
}

export async function setupRateLimits(): Promise<RateLimitSetupResult> {
  console.log("[CF:RL] Configuring edge rate limits (new Rulesets API)...");

  const existing = await getRuleset(RATE_LIMIT_PHASE);
  const existingRules: RulesetRule[] = existing?.rules ?? [];
  const merged: RulesetRule[] = [...existingRules];

  for (const cfg of RATE_LIMIT_RULES) {
    const idx = merged.findIndex((r) => r.description === cfg.description);
    const rule = buildRateLimitRule(cfg);

    if (idx >= 0) {
      const old = merged[idx];
      if (
        old.expression !== cfg.expression ||
        old.action !== cfg.action ||
        old.ratelimit?.requests_per_period !== cfg.threshold
      ) {
        merged[idx] = { ...old, ...rule };
        console.log(`[CF:RL] Updated: ${cfg.description}`);
      } else {
        console.log(`[CF:RL] Unchanged: ${cfg.description}`);
      }
    } else {
      merged.push(rule);
      console.log(`[CF:RL] Added: ${cfg.description}`);
    }
  }

  try {
    await putRuleset(RATE_LIMIT_PHASE, merged);
    console.log(`[CF:RL] ${RATE_LIMIT_RULES.length} rate limit rules applied ✔`);
    return { rulesApplied: RATE_LIMIT_RULES.length, phaseAvailable: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[CF:RL] Rate limit setup failed: ${msg}`);
    return { rulesApplied: 0, phaseAvailable: false };
  }
}
