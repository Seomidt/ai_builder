/**
 * Robots.txt endpoint — single-domain app-on-root policy
 *
 * CURRENT MODE: single-domain (blissops.com = authenticated application)
 *
 * blissops.com is NOT a public marketing site.
 * All routes require authentication. Crawlers must be blocked entirely.
 *
 * Policy: Disallow: / for ALL hosts.
 *
 * Future: when a separate public marketing site is launched, update
 * DOMAIN_CONFIG.mode = "multi" and serve Allow: / only for the public host.
 */

import { Router, Request, Response } from "express";

const router = Router();

const ROBOTS_DISALLOW = `User-agent: *\nDisallow: /\n`;

router.get("/robots.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(ROBOTS_DISALLOW);
});

export { router as robotsRouter };
