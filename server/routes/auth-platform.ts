import type { Express, Request, Response } from "express";

export function registerAuthPlatformRoutes(app: Express): void {

  app.get("/api/auth/session", (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error_code: "UNAUTHENTICATED", message: "No session" });
    res.json({ user });
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/auth/mfa/status", (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error_code: "UNAUTHENTICATED", message: "No session" });
    res.json({ mfaEnabled: false, factors: [] });
  });
}
