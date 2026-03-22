import type { IncomingMessage, ServerResponse } from "http";

export function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":  "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function err(
  res: ServerResponse,
  status: number,
  code:    string,
  message: string,
): void {
  json(res, { error_code: code, message }, status);
}

export function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function pathSegments(req: IncomingMessage, base: string): string[] {
  const u = parseUrl(req);
  const after = u.pathname.replace(new RegExp(`^${base}`), "").replace(/^\//, "");
  return after ? after.split("/") : [];
}

export async function readBody<T = Record<string, unknown>>(
  req: IncomingMessage,
): Promise<T> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : ({} as T)); }
      catch { resolve({} as T); }
    });
    req.on("error", () => resolve({} as T));
  });
}
