import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { authMiddleware } from "./middleware/auth";
import { requestIdMiddleware, structuredLoggingMiddleware } from "./middleware/request-id";
import { securityHeaders } from "./middleware/security-headers";
import { cspMiddleware } from "./middleware/csp";
import { responseSecurityMiddleware } from "./middleware/response-security";
import { globalApiLimiter } from "./middleware/rate-limit";

const app = express();
const httpServer = createServer(app);

// Phase 13.2: security headers — FIRST, before all routes and body parsing
app.use(securityHeaders);
// Phase 13.2: explicit CSP header
app.use(cspMiddleware);
// Phase 13.2: response header hardening (overrides specific helmet defaults)
app.use(responseSecurityMiddleware);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Phase 13.2: JSON body limit 1mb — rejects oversized payloads (INV-SEC-H4)
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// Phase 13.2: urlencoded limit aligned to 1mb
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// Phase 13.1: request ID + structured logging (before auth so all requests are traced)
app.use(requestIdMiddleware);
app.use(structuredLoggingMiddleware);

// Phase 13.2: global API rate limiter — 1000 req/15 min per actor/IP (replaces Phase 13.1 inline)
app.use("/api", globalApiLimiter);

app.use(authMiddleware);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Phase 13.1 hardened global error handler — structured response, no stack traces
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const requestId = (req as any).requestId ?? null;

    if (res.headersSent) return;

    // Never expose stack traces to clients
    const message = status < 500 ? (err.message || "Bad request") : "Internal server error";

    return res.status(status).json({
      error_code: err.code || err.errorCode || (status < 500 ? "CLIENT_ERROR" : "INTERNAL_ERROR"),
      message,
      request_id: requestId,
    });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
