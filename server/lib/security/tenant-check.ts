import { Request, Response, NextFunction } from "express";

export class ForbiddenError extends Error {
  statusCode = 403;
  errorCode  = "FORBIDDEN";
  constructor(message = "Forbidden") { super(message); }
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  errorCode  = "UNAUTHORIZED";
  constructor(message = "Unauthorized") { super(message); }
}

export async function requireOwnerRole(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = (req as any).user;
  if (!user) throw new UnauthorizedError("Authentication required");
  if (user.role !== "owner" && user.role !== "superadmin") {
    throw new ForbiddenError("Owner role required");
  }
  next();
}
