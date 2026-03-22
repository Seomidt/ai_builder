/**
 * useAuth — Robust session hook
 *
 * CRITICAL FIX: Supabase v2 holds an internal lock during SIGNED_IN.
 * Calling supabase.auth.getSession() immediately after SIGNED_IN can return
 * null while the lock is held. We solve this by using the access_token
 * delivered directly from onAuthStateChange (lock is not needed there),
 * stored in a module-level ref so fetchSession() can use it synchronously.
 *
 * FLOW:
 *   1. onAuthStateChange fires with session.access_token → stored in tokenRef
 *   2. queryClient.setQueryData called immediately with the fresh token → no re-fetch needed
 *   3. ProtectedRoute: isLoading=false, isAuthed=true → render dashboard
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

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

// Module-level token cache — survives component re-mounts.
// Set by onAuthStateChange before any query fires.
let _cachedToken: string | null = null;

async function fetchSessionWithToken(token: string | null): Promise<SessionResult> {
  if (!token) {
    // Last-resort: try getSession() (covers page-reload case)
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token ?? null;
    } catch {
      token = null;
    }
  }

  if (!token) return { status: 401, user: null };

  try {
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
    // Network error — keep stale data, don't force logout
    return { status: 0, user: null };
  }
}

export function useAuth() {
  const queryClient = useQueryClient();

  const [hasLocalSession, setHasLocalSession] = useState<boolean | null>(null);
  const bootstrapped = useRef(false);

  // On mount: read local session from cookie storage (~5ms)
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    supabase.auth.getSession().then(({ data }) => {
      const hasSession = data.session !== null;
      _cachedToken = data.session?.access_token ?? null;
      setHasLocalSession(hasSession);
    });
  }, []);

  // Auth state changes: sign-in, sign-out, token refresh, page reload
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Always update the cached token from the event — this is the
      // authoritative source and does NOT require the Supabase lock.
      _cachedToken = session?.access_token ?? null;
      setHasLocalSession(session !== null);

      if (event === "SIGNED_OUT") {
        _cachedToken = null;
        queryClient.clear();
      } else if (event === "SIGNED_IN" && session?.access_token) {
        // On sign-in: immediately call the backend with the fresh token
        // from the event (not from getSession() which may be lock-blocked).
        // setQueryData gives ProtectedRoute the result without a re-fetch.
        queryClient.clear();
        fetchSessionWithToken(session.access_token).then((result) => {
          queryClient.setQueryData(["/api/auth/session"], result);
        });
      } else if (event === "TOKEN_REFRESHED" && session?.access_token) {
        // Silently update the cached session after token refresh
        queryClient.setQueryData(["/api/auth/session"], (old: SessionResult | undefined) =>
          old?.status === 200 ? old : undefined,
        );
        queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      } else if (event === "INITIAL_SESSION") {
        // Page reload: session already in cookie — invalidate to trigger fresh fetch
        queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      }
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  // Background session query — uses _cachedToken (set by onAuthStateChange)
  // as primary source; falls back to getSession() on page reload.
  const { data, isLoading: queryLoading } = useQuery<SessionResult>({
    queryKey: ["/api/auth/session"],
    queryFn: () => fetchSessionWithToken(_cachedToken),
    retry: false,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    enabled: true,
  });

  const backendStatus = data?.status ?? null;

  // isLoading: true until localStorage is checked AND backend has responded
  // (or stale cache exists). If hasLocalSession=false, stop loading immediately.
  const isLoading =
    hasLocalSession === null ||
    (hasLocalSession === true && queryLoading);

  // isAuthed: local session confirmed, backend has NOT explicitly rejected
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
