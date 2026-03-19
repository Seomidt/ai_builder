/**
 * Robots.txt endpoint — host-aware
 * Phase Next — Domain/Subdomain Architecture Hardening
 *
 * Serves the correct robots.txt content based on the request host.
 * Public domain: allows all crawlers.
 * App / admin / auth / unknown hosts: disallow all.
 */

import { Router, Request, Response } from "express";
import {
  PRODUCTION_ALLOWED_HOSTS,
  PUBLIC_CANONICAL_HOST,
} from "../lib/platform/platform-hardening-config";

const router = Router();

const ROBOTS_PUBLIC = `User-agent: *\nAllow: /\n\nSitemap: https://${PUBLIC_CANONICAL_HOST}/sitemap.xml\n`;
const ROBOTS_DISALLOW = `User-agent: *\nDisallow: /\n`;

const PUBLIC_HOSTS = new Set([PUBLIC_CANONICAL_HOST, `www.${PUBLIC_CANONICAL_HOST}`]);

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, "");
}

router.get("/robots.txt", (req: Request, res: Response) => {
  const host = extractHost(req);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");

  if (PUBLIC_HOSTS.has(host)) {
    res.send(ROBOTS_PUBLIC);
  } else {
    res.send(ROBOTS_DISALLOW);
  }
});

export { router as robotsRouter };
