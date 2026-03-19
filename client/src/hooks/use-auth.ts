/**
 * useAuth — Session state hook
 *
 * Fetches /api/auth/session with a Supabase Bearer token (if present).
 * Handles 401 (unauthenticated) and 403 (lockdown) gracefully.
 */

import { useQuery } from "@tanstack/react-query";
import { getSessionToken } from "@/lib/supabase";

export interface SessionUser {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}

interface SessionResult {
  status: number;
  user: SessionUser | null;
}

async function fetchSession(): Promise<SessionResult> {
  try {
    const token = await getSessionToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch("/api/auth/session", {
      headers,
      credentials: "include",
      cache: "no-store",
    });

    if (res.status === 401) return { status: 401, user: null };
    if (res.status === 403) return { status: 403, user: null };
    if (!res.ok)            return { status: res.status, user: null };

    const data = await res.json() as { user: SessionUser };
    return { status: 200, user: data.user ?? null };
  } catch {
    return { status: 0, user: null };
  }
}

export function useAuth() {
  const { data, isLoading } = useQuery<SessionResult>({
    queryKey:            ["/api/auth/session"],
    queryFn:             fetchSession,
    retry:               false,
    staleTime:           30_000,
    refetchOnWindowFocus: true,
  });

  const status = data?.status ?? null;
  const user   = data?.user   ?? null;

  return {
    isLoading,
    user,
    status,
    isAuthed:   status === 200 && user !== null,
    isLockdown: status === 403,
  };
}
