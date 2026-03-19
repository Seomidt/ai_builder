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
import { registerRoutes } from "./routes";
import { authMiddleware } from "./middleware/auth";
import { requestIdMiddleware, structuredLoggingMiddleware } from "./middleware/request-id";
import { securityHeaders, reportingEndpointsMiddleware } from "./middleware/security-headers";
import { responseSecurityMiddleware } from "./middleware/response-security";
import { globalApiLimiter } from "./middleware/rate-limit";
import { nonceMiddleware } from "./middleware/nonce";
import { cspReportRouter } from "./routes/security-report";
import { createRouteGroupRateLimiter } from "./lib/security/api-rate-limits";
import { robotsRouter } from "./routes/robots";
import { adminDomainGuard, adminNoindexHeader } from "./middleware/admin-domain";
import { adminGuardMiddleware } from "./middleware/ai-guards";
import { lockdownGuard } from "./middleware/lockdown";

// Vercel handles www-redirects and host-allowlisting at the platform level.
const ON_VERCEL = !!process.env.VERCEL;

// Singleton: routes are registered once per process lifetime.
let _ready: Promise<express.Express> | null = null;

export function getApp(): Promise<express.Express> {
  if (_ready) return _ready;

  _ready = (async () => {
    const app = express();

    if (!ON_VERCEL) {
      // These guards run only in non-Vercel environments (Replit dev / self-hosted).
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
