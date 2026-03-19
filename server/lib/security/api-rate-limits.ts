import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Router } from "express";

interface RouteGroupConfig {
  windowMs: number;
  max:      number;
  prefix:   string;
}

const ROUTE_GROUPS: RouteGroupConfig[] = [
  { prefix: "/auth",     windowMs: 15 * 60 * 1000, max: 30   },
  { prefix: "/ai",       windowMs: 60 * 1000,       max: 20   },
  { prefix: "/admin",    windowMs: 15 * 60 * 1000, max: 200  },
  { prefix: "/security", windowMs: 60 * 1000,       max: 50   },
];

function makeGroupLimiter(config: RouteGroupConfig): RateLimitRequestHandler {
  return rateLimit({
    windowMs:        config.windowMs,
    max:             config.max,
    standardHeaders: true,
    legacyHeaders:   false,
    handler: (_req, res) => {
      res.status(429).json({
        error_code: "ROUTE_RATE_LIMIT_EXCEEDED",
        message:    "Too many requests for this endpoint",
      });
    },
  });
}

export function createRouteGroupRateLimiter(): Router {
  const router = Router();
  for (const group of ROUTE_GROUPS) {
    router.use(group.prefix, makeGroupLimiter(group));
  }
  return router;
}
