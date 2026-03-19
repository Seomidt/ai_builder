import { getRuleset, putRuleset, RulesetRule } from "./client";

const CACHE_PHASE = "http_request_cache_settings";

const CACHE_RULES: Array<{
  description: string;
  expression: string;
  action: "set_cache_settings";
  action_parameters: Record<string, unknown>;
}> = [
  {
    description: "STATIC ASSETS — cache everything for 1 month",
    expression:
      '(http.request.uri.path.extension in {"js" "css" "png" "jpg" "jpeg" "svg" "webp" "ico" "woff" "woff2" "ttf" "gif"})',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin",
        default: 2592000, // 30 days
      },
      browser_ttl: {
        mode: "override_origin",
        default: 86400, // 1 day
      },
    },
  },
  {
    description: "API BYPASS — never cache /api/* responses",
    expression: '(http.request.uri.path starts_with "/api/")',
    action: "set_cache_settings",
    action_parameters: {
      cache: false,
    },
  },
];

export interface CacheSetupResult {
  rulesApplied: number;
  phaseAvailable: boolean;
}

export async function setupCache(): Promise<CacheSetupResult> {
  console.log("[CF:Cache] Configuring cache rules...");

  const existing = await getRuleset(CACHE_PHASE);
  const existingRules: RulesetRule[] = existing?.rules ?? [];
  const merged: RulesetRule[] = [...existingRules];

  for (const cfg of CACHE_RULES) {
    const idx = merged.findIndex((r) => r.description === cfg.description);
    const rule: RulesetRule = {
      description: cfg.description,
      expression: cfg.expression,
      action: cfg.action,
      action_parameters: cfg.action_parameters,
      enabled: true,
    };

    if (idx >= 0) {
      const old = merged[idx];
      if (
        old.expression !== cfg.expression ||
        JSON.stringify(old.action_parameters) !== JSON.stringify(cfg.action_parameters)
      ) {
        merged[idx] = { ...old, ...rule };
        console.log(`[CF:Cache] Updated: ${cfg.description}`);
      } else {
        console.log(`[CF:Cache] Unchanged: ${cfg.description}`);
      }
    } else {
      merged.push(rule);
      console.log(`[CF:Cache] Added: ${cfg.description}`);
    }
  }

  try {
    await putRuleset(CACHE_PHASE, merged);
    console.log(`[CF:Cache] ${CACHE_RULES.length} cache rules applied ✔`);
    return { rulesApplied: CACHE_RULES.length, phaseAvailable: true };
  } catch (err) {
    console.warn(`[CF:Cache] Cache phase unavailable: ${(err as Error).message}`);
    return { rulesApplied: 0, phaseAvailable: false };
  }
}
