/**
 * server/app.ts — Shared Express app factory
 *
 * Used by:
 *  server/index.ts  → Replit dev (adds Vite dev server + httpServer.listen)
 *  api/index.ts     → Vercel serverless (exported as default handler)
 *
 * Does NOT call listen() and does NOT set up static file serving.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { requestIdMiddleware, structuredLoggingMiddleware } from "./middleware/request-id.ts";
import { securityHeaders, reportingEndpointsMiddleware } from "./middleware/security-headers.ts";
import { responseSecurityMiddleware } from "./middleware/response-security.ts";
import { globalApiLimiter } from "./middleware/rate-limit.ts";
import { nonceMiddleware } from "./middleware/nonce.ts";
import { cspReportRouter } from "./routes/security-report.ts";
import { createRouteGroupRateLimiter } from "./lib/security/api-rate-limits.ts";
import { robotsRouter } from "./routes/robots.ts";
import { adminDomainGuard, adminNoindexHeader } from "./middleware/admin-domain.ts";
import { adminGuardMiddleware } from "./middleware/ai-guards.ts";
import { lockdownGuard } from "./middleware/lockdown.ts";

// Vercel handles www-redirects and host-allowlisting at the platform level.
const ON_VERCEL = !!process.env.VERCEL;

// Railway: running as standalone Express API server
const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PUBLIC_DOMAIN;

// Singleton: routes are registered once per process lifetime.
let _ready: Promise<express.Express> | null = null;

export function getApp(): Promise<express.Express> {
  if (_ready) return _ready;

  _ready = (async () => {
    const app = express();

    if (ON_RAILWAY) {
      // Railway API mode: add CORS so blissops.com (Vercel frontend) can call us.
      // All /api/* requests are proxied from Vercel → Railway.
      const allowedOrigins = [
        "https://blissops.com",
        "https://www.blissops.com",
        "https://app.blissops.com",
        "https://api.blissops.com",
        "https://admin.blissops.com",
        ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
        ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`] : []),
      ];
      app.use((req, res, next) => {
        const origin = req.headers.origin as string | undefined;
        if (origin && allowedOrigins.includes(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Request-Id");
        }
        if (req.method === "OPTIONS") { res.sendStatus(204); return; }
        next();
      });
      // Health check endpoint for Railway healthcheck
      app.get("/health", (_req, res) => res.json({ ok: true, service: "blissops-api", ts: Date.now() }));
    }

    if (!ON_VERCEL && !ON_RAILWAY) {
      // These guards run only in non-Vercel, non-Railway environments (Replit dev / self-hosted).
      const { wwwRedirectMiddleware } = await import("./middleware/www-redirect");
      const { hostAllowlistMiddleware } = await import("./middleware/host-allowlist");
      app.use(wwwRedirectMiddleware);
      app.use(hostAllowlistMiddleware);
    }

    app.use(nonceMiddleware);
    app.use(securityHeaders);
    app.use(reportingEndpointsMiddleware);
    app.use(responseSecurityMiddleware);

    app.use(
      express.json({
        limit: "1mb",
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(express.urlencoded({ extended: false, limit: "1mb" }));

    app.use(requestIdMiddleware);
    app.use(structuredLoggingMiddleware);

    app.use("/api", globalApiLimiter);
    app.use("/api", createRouteGroupRateLimiter());

    app.use(robotsRouter);
    app.use("/api/security", cspReportRouter);
    app.use(authMiddleware);
    app.use(adminDomainGuard);
    app.use(adminNoindexHeader);
    app.use("/api/admin", adminGuardMiddleware);
    app.use(lockdownGuard);

    // Register all API routes
    const httpServer = createServer(app);
    await registerRoutes(httpServer, app);

    // Global error handler — no stack traces to clients
    app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const requestId = (req as any).requestId ?? null;
      if (res.headersSent) return;
      const message = status < 500 ? err.message ?? "Bad request" : "Internal server error";
      res.status(status).json({
        error_code: err.code ?? err.errorCode ?? (status < 500 ? "CLIENT_ERROR" : "INTERNAL_ERROR"),
        message,
        request_id: requestId,
      });
    });

    return app;
  })();

  return _ready;
}
