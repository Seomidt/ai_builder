import type { Express, Request, Response } from "express";

export function registerAdminRoutes(app: Express): void {

  app.get("/api/admin/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/admin/tenants", (_req: Request, res: Response) => {
    res.json({ tenants: [], total: 0 });
  });

  app.get("/api/admin/plans", (_req: Request, res: Response) => {
    res.json({ plans: [] });
  });

  app.get("/api/admin/invoices", (_req: Request, res: Response) => {
    res.json({ invoices: [], total: 0 });
  });
}
