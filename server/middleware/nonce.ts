import { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";

declare global {
  namespace Express {
    interface Request {
      cspNonce: string;
    }
  }
}

export function nonceMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.cspNonce = randomBytes(16).toString("base64");
  next();
}
