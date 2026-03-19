import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = (req.headers["x-request-id"] as string) || randomUUID();
  req.startTime = Date.now();
  next();
}

export function structuredLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      const duration = Date.now() - (req.startTime || Date.now());
      const logData = {
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip,
      };
      if (process.env.NODE_ENV === "development") {
        console.log("[api]", JSON.stringify(logData));
      }
    }
  });
  next();
}
