/**
 * useAuth — Session hook with safe loading semantics
 *
 * FLOW:
 *   1. Read local session from cookie storage via getSession() — ~5ms
 *   2. While backend /api/auth/session is in-flight → isLoading = true (show skeleton)
 *   3. Backend responds → user object set, loading cleared
 *   4. Backend returns 401 → user = null → ProtectedRoute redirects to login
 *
 * KEY SAFETY RULE: never redirect to login until the backend session query
 * has fully resolved. This prevents false logout loops during cold starts or
 * transient network errors.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase, getSessionToken } from "@/lib/supabase";

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

    if (!token) {
      return { status: 401, user: null };
    }

    const res = await fetch("/api/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
      cache: "no-store",
    });

    if (res.status === 401) return { status: 401, user: null };
    if (res.status === 403) return { status: 403, user: null };
    if (!res.ok) return { status: res.status, user: null };

    const data = (await res.json()) as { user: SessionUser };
    return { status: 200, user: data.user ?? null };
  } catch {
    // Network error: don't invalidate — let stale data hold
    return { status: 0, user: null };
  }
}

export function useAuth() {
  const queryClient = useQueryClient();

  // null  = haven't checked yet
  // false = no local session
  // true  = local session exists
  const [hasLocalSession, setHasLocalSession] = useState<boolean | null>(null);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    supabase.auth.getSession().then(({ data }) => {
      setHasLocalSession(data.session !== null);
    });
  }, []);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setHasLocalSession(session !== null);

      if (event === "SIGNED_OUT") {
        queryClient.clear();
      } else if (event === "SIGNED_IN") {
        queryClient.clear();
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      }
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  const { data, isLoading: queryLoading } = useQuery<SessionResult>({
    queryKey: ["/api/auth/session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    enabled: true,
  });

  const backendStatus = data?.status ?? null;

  // Loading = localStorage not checked yet OR local session exists and backend
  // hasn't responded yet (first fetch, no cache). This prevents redirecting to
  // login before we know what the backend thinks of the session.
  //
  // If hasLocalSession = false: stop loading immediately — redirect at once.
  // If hasLocalSession = true and queryLoading: wait for backend before deciding.
  // If stale cache exists (queryLoading = false): use cached result immediately.
  const isLoading =
    hasLocalSession === null ||
    (hasLocalSession === true && queryLoading);

  // Secondary optimistic check: trust local session while backend is still
  // responding, but honour explicit 401/403 rejections.
  const isAuthed =
    hasLocalSession === true &&
    backendStatus !== 401 &&
    backendStatus !== 403;

  const isLockdown = backendStatus === 403;

  const user = data?.user ?? null;

  return {
    isLoading,
    user,
    status: backendStatus,
    isAuthed,
    isLockdown,
  };
}
