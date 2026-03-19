import { getRuleset, putRuleset, RulesetRule } from "./client";

const RATE_LIMIT_PHASE = "http_ratelimit";

interface RateLimitConfig {
  description: string;
  expression: string;
  threshold: number;
  period: number;
  action: string;
}

const RATE_LIMIT_RULES: RateLimitConfig[] = [
  {
    description: "AUTH rate limit — 10 req / 60s → block",
    expression: '(http.request.uri.path wildcard "/api/auth/*")',
    threshold: 10,
    period: 60,
    action: "block",
  },
  {
    description: "AI rate limit — 20 req / 60s → block",
    expression: '(http.request.uri.path wildcard "/api/ai/*")',
    threshold: 20,
    period: 60,
    action: "block",
  },
  {
    description: "GLOBAL API rate limit — 100 req / 60s → managed_challenge",
    expression: '(http.request.uri.path wildcard "/api/*")',
    threshold: 100,
    period: 60,
    action: "managed_challenge",
  },
];

function buildRateLimitRule(cfg: RateLimitConfig): RulesetRule {
  return {
    description: cfg.description,
    expression: cfg.expression,
    action: "block",
    action_parameters:
      cfg.action === "managed_challenge"
        ? { response: { status_code: 429 } }
        : undefined,
    enabled: true,
  };
}

export interface RateLimitSetupResult {
  rulesApplied: number;
  phaseAvailable: boolean;
}

export async function setupRateLimits(): Promise<RateLimitSetupResult> {
  console.log("[CF:RL] Configuring edge rate limits...");

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
        old.action !== rule.action
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
    // Rate limiting may not be available on free plans
    console.warn(`[CF:RL] Rate limit phase unavailable: ${(err as Error).message}`);
    return { rulesApplied: 0, phaseAvailable: false };
  }
}
