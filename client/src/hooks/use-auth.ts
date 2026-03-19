/**
 * useAuth — Session state hook
 *
 * Fetches /api/auth/session and exposes the result as a typed hook.
 * Handles 401 (unauthenticated) and 403 (lockdown/forbidden) gracefully.
 *
 * Returns:
 *   isLoading  — session check in progress (show spinner, not blocked screen)
 *   user       — authenticated user object, or null
 *   status     — HTTP status of the session check (200 | 401 | 403 | null)
 *   isAuthed   — true only when status === 200 and user is present
 *   isLockdown — true when status === 403 (lockdown blocked)
 */

import { useQuery } from "@tanstack/react-query";

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
    const res = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
    });

    if (res.status === 401) return { status: 401, user: null };
    if (res.status === 403) return { status: 403, user: null };
    if (!res.ok) return { status: res.status, user: null };

    const data = await res.json() as { user: SessionUser };
    return { status: 200, user: data.user ?? null };
  } catch {
    return { status: 0, user: null };
  }
}

export function useAuth() {
  const { data, isLoading } = useQuery<SessionResult>({
    queryKey: ["/api/auth/session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const status = data?.status ?? null;
  const user = data?.user ?? null;

  return {
    isLoading,
    user,
    status,
    isAuthed: status === 200 && user !== null,
    isLockdown: status === 403,
  };
}
