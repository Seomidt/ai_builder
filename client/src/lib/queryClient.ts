import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getSessionToken } from "./supabase";

/**
 * Typed API error.  Thrown by apiRequest / getQueryFn whenever the server
 * returns a non-2xx response that carries a typed `error_code` payload.
 *
 * Consumers can narrow on `errorCode`:
 *   if (err instanceof ApiError && err.errorCode === "DUPLICATE_SLUG") { ... }
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let errorCode = "UNKNOWN_ERROR";
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error_code?: string; message?: string };
      if (body.error_code) errorCode = body.error_code;
      if (body.message) message = body.message;
    } catch {
      message = (await res.text().catch(() => res.statusText)) || res.statusText;
    }
    throw new ApiError(res.status, errorCode, message);
  }
}

async function bearerHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getSessionToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export function getDirectApiBase(): string {
  if (typeof window === "undefined") return "";
  const env = (import.meta.env.VITE_API_DIRECT_URL as string | undefined) ?? "";
  if (env) return env.replace(/\/$/, "");
  if (window.location.hostname.endsWith("blissops.com")) return "https://blissops-production.up.railway.app";
  return "";
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  const headers = await bearerHeaders(
    data ? { "Content-Type": "application/json" } : undefined,
  );
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  return res;
}

export async function apiRequestForm(
  method: string,
  url: string,
  form: FormData,
): Promise<Response> {
  const headers = await bearerHeaders();
  const res = await fetch(url, {
    method,
    headers,
    body: form,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers = await bearerHeaders();
    const res = await fetch(queryKey.join("/") as string, {
      headers,
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // 60s staleTime: data is reused within a session (fast UX) but
      // re-fetches after 60s to surface updates. Prefetch data is always
      // < 60s old on login, so cache hit is guaranteed there.
      // NOT Infinity — prevents cross-user stale data if cache is not
      // explicitly cleared (defence-in-depth alongside queryClient.clear()).
      staleTime: 60_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
