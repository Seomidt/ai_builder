import type { Express, Request, Response } from "express";

export function registerAuthPlatformRoutes(app: Express): void {

  // Public — Supabase config for frontend client initialisation.
  // SUPABASE_ANON_KEY is intentionally public (safe to expose to browser).
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    res.json({
      supabaseUrl:     process.env.SUPABASE_URL     ?? "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
    });
  });

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
