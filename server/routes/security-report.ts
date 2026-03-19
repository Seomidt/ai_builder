import { Router } from "express";

export const cspReportRouter = Router();

cspReportRouter.post("/csp-report", (req, res) => {
  const report = req.body?.["csp-report"] || req.body;
  if (process.env.NODE_ENV !== "production") {
    console.warn("[CSP-REPORT]", JSON.stringify(report));
  }
  res.status(204).end();
});
