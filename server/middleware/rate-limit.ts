import rateLimit from "express-rate-limit";

export const globalApiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             1000,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (_req, res) => {
    res.status(429).json({
      error_code: "RATE_LIMIT_EXCEEDED",
      message:    "Too many requests — please retry after 15 minutes",
    });
  },
});

export interface RateLimitConfig {
  windowMs:    number;
  max:         number;
  groupLimits: Record<string, { windowMs: number; max: number }>;
}

export function getRateLimitConfig(): RateLimitConfig {
  return {
    windowMs: 15 * 60 * 1000,
    max:      1000,
    groupLimits: {
      auth:     { windowMs: 15 * 60 * 1000, max: 30 },
      ai:       { windowMs: 60 * 1000,       max: 20 },
      admin:    { windowMs: 15 * 60 * 1000, max: 200 },
      security: { windowMs: 60 * 1000,       max: 50 },
    },
  };
}
