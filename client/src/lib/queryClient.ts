import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getSessionToken } from "./supabase";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
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
