import { getRuleset, putRuleset, RulesetRule, cfFetch, zoneUrl } from "./client";

interface RateLimitConfig {
  description: string;
  expression: string;
  threshold: number;
  period: number;
  action: "block" | "managed_challenge" | "js_challenge" | "log";
}

const RATE_LIMIT_RULES: RateLimitConfig[] = [
  {
    description: "AUTH rate limit — 10 req / 60s → block",
    expression: '(http.request.uri.path matches "^/api/auth")',
    threshold: 10,
    period: 60,
    action: "block",
  },
  {
    description: "AI rate limit — 20 req / 60s → block",
    expression: '(http.request.uri.path matches "^/api/ai")',
    threshold: 20,
    period: 60,
    action: "block",
  },
  {
    description: "GLOBAL API rate limit — 100 req / 60s → managed_challenge",
    expression: '(http.request.uri.path matches "^/api")',
    threshold: 100,
    period: 60,
    action: "managed_challenge",
  },
];

function buildRateLimitRule(cfg: RateLimitConfig): RulesetRule {
  return {
    description: cfg.description,
    expression: cfg.expression,
    // http_ratelimit phase requires action = "ratelimit" with ratelimit action_parameters
    action: "ratelimit",
    action_parameters: {
      ratelimit: {
        characteristics: ["cf.colo.id", "ip.src"],
        period: cfg.period,
        requests_per_period: cfg.threshold,
        mitigation_timeout: cfg.period,
        counting_expression: "",
        requests_to_origin: false,
      },
      response: {
        status_code: cfg.action === "block" ? 429 : undefined,
      },
    },
    enabled: true,
  };
}

export interface RateLimitSetupResult {
  rulesApplied: number;
  phaseAvailable: boolean;
}

export async function setupRateLimits(): Promise<RateLimitSetupResult> {
  console.log("[CF:RL] Configuring edge rate limits...");

  const RATE_LIMIT_PHASE = "http_ratelimit";
  const existing = await getRuleset(RATE_LIMIT_PHASE);
  const existingRules: RulesetRule[] = existing?.rules ?? [];
  const merged: RulesetRule[] = [...existingRules];

  for (const cfg of RATE_LIMIT_RULES) {
    const idx = merged.findIndex((r) => r.description === cfg.description);
    const rule = buildRateLimitRule(cfg);

    if (idx >= 0) {
      const old = merged[idx];
      if (old.expression !== cfg.expression) {
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
    // Fallback: try legacy rate limiting API for older/free zone plans
    if (msg.includes("ratelimit") || msg.includes("not a valid") || msg.includes("cannot be empty")) {
      console.warn(`[CF:RL] Rulesets API unavailable — trying legacy rate limits API...`);
      return setupRateLimitsLegacy();
    }
    console.warn(`[CF:RL] Rate limit phase unavailable: ${msg}`);
    return { rulesApplied: 0, phaseAvailable: false };
  }
}

interface LegacyRateLimitRule {
  id?: string;
  description: string;
  match: { request: { url_pattern: string; methods: string[] } };
  threshold: number;
  period: number;
  action: { mode: string; timeout: number };
  enabled: boolean;
  disabled?: boolean;
}

async function setupRateLimitsLegacy(): Promise<RateLimitSetupResult> {
  const legacyRules: Array<{
    description: string;
    urlPattern: string;
    threshold: number;
    period: number;
    mode: "ban" | "challenge" | "js_challenge" | "simulate";
  }> = [
    { description: "AUTH rate limit — 10 req / 60s", urlPattern: "*/api/auth*", threshold: 10, period: 60, mode: "ban" },
    { description: "AI rate limit — 20 req / 60s", urlPattern: "*/api/ai*", threshold: 20, period: 60, mode: "ban" },
    { description: "GLOBAL API rate limit — 100 req / 60s", urlPattern: "*/api/*", threshold: 100, period: 60, mode: "challenge" },
  ];

  // List existing
  let existing: LegacyRateLimitRule[] = [];
  try {
    const res = await cfFetch<LegacyRateLimitRule[]>(zoneUrl("/rate_limits?per_page=100"), "GET");
    existing = res ?? [];
  } catch {
    existing = [];
  }

  let applied = 0;

  for (const cfg of legacyRules) {
    const existingRule = existing.find((r) => r.description === cfg.description);
    const payload: Omit<LegacyRateLimitRule, "id"> = {
      description: cfg.description,
      match: { request: { url_pattern: cfg.urlPattern, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] } },
      threshold: cfg.threshold,
      period: cfg.period,
      action: { mode: cfg.mode, timeout: cfg.period },
      enabled: true,
    };

    try {
      if (existingRule?.id) {
        await cfFetch(zoneUrl(`/rate_limits/${existingRule.id}`), "PUT", payload);
        console.log(`[CF:RL] Legacy updated: ${cfg.description}`);
      } else {
        await cfFetch(zoneUrl("/rate_limits"), "POST", payload);
        console.log(`[CF:RL] Legacy added: ${cfg.description}`);
      }
      applied++;
    } catch (err) {
      console.warn(`[CF:RL] Legacy rule failed for "${cfg.description}": ${(err as Error).message}`);
    }
  }

  return { rulesApplied: applied, phaseAvailable: applied > 0 };
}
