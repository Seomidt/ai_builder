import { Request, Response, NextFunction } from "express";
import helmet from "helmet";

const IS_PROD = process.env.NODE_ENV === "production";

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", "data:", "https:"],
      connectSrc:     ["'self'", "https://*.supabase.co", "wss://*.supabase.co"],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      mediaSrc:       ["'self'"],
      frameSrc:       ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: IS_PROD
    ? {
        maxAge:            31536000,
        includeSubDomains: true,
        preload:           true,
      }
    : false,
  frameguard:            { action: "deny" },
  noSniff:               true,
  referrerPolicy:        { policy: "strict-origin-when-cross-origin" },
  xssFilter:             true,
  hidePoweredBy:         true,
  permittedCrossDomainPolicies: { permittedPolicies: "none" },
});

export function reportingEndpointsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  if (IS_PROD) {
    res.setHeader(
      "Report-To",
      JSON.stringify({
        group:     "default",
        max_age:   86400,
        endpoints: [{ url: "/api/security/csp-report" }],
      }),
    );
    res.setHeader("Reporting-Endpoints", `default="/api/security/csp-report"`);
  }
  next();
}
