/**
 * api/index.ts — Vercel Serverless Function entry point
 *
 * Vercel routes all /api/* requests here.
 * Express app is initialised once per cold-start (singleton via getApp()).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { getApp } from "../server/app";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app(req as any, res as any);
}
