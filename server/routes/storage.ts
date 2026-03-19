import { Router, Request, Response } from "express";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json({ files: [], total: 0 });
});

router.post("/upload-url", async (_req: Request, res: Response) => {
  res.status(503).json({ error_code: "NOT_IMPLEMENTED", message: "Upload URL generation not yet implemented" });
});

router.delete("/:fileId", async (_req: Request, res: Response) => {
  res.status(501).json({ error_code: "NOT_IMPLEMENTED", message: "File deletion not yet implemented" });
});

export default router;
