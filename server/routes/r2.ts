import type { Express, Request, Response } from "express";

export function registerR2Routes(app: Express): void {

  app.get("/api/r2/buckets", (_req: Request, res: Response) => {
    res.json({ buckets: [], message: "R2 integration requires CF_R2_* environment variables" });
  });

  app.post("/api/r2/upload-url", (_req: Request, res: Response) => {
    res.status(503).json({ error_code: "R2_NOT_CONFIGURED", message: "R2 storage not configured" });
  });

  app.get("/api/r2/object/:key", (_req: Request, res: Response) => {
    res.status(503).json({ error_code: "R2_NOT_CONFIGURED", message: "R2 storage not configured" });
  });
}
