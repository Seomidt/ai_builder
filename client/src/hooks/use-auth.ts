/**
 * useAuth — Optimistic session hook
 *
 * FLOW (non-blocking):
 *   1. Read session from supabase.auth.getSession() — localStorage read, ~1ms
 *   2. If local session exists → isAuthed = true IMMEDIATELY (no network wait)
 *   3. /api/auth/session runs in background to confirm + fetch org/role
 *   4. If backend returns 401 → force redirect (token expired / revoked)
 *
 * This makes refresh instant: the shell renders using the local session
 * while backend validation runs async. Security is preserved — any invalid
 * token is caught and redirected once backend responds.
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

  // Optimistic: read local session immediately (localStorage, ~1ms)
  // null  = not checked yet
  // false = checked, no session
  // true  = checked, session exists
  const [hasLocalSession, setHasLocalSession] = useState<boolean | null>(null);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    supabase.auth.getSession().then(({ data }) => {
      setHasLocalSession(data.session !== null);
    });
  }, []);

  // Subscribe to auth state changes (sign-in, sign-out, token refresh)
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setHasLocalSession(session !== null);

      if (event === "SIGNED_OUT") {
        // Hard clear: remove all cached tenant/user data so the next user
        // cannot see a previous user's dashboard, projects, runs etc.
        queryClient.clear();
      } else if (event === "SIGNED_IN") {
        // A new sign-in (NOT initial page-load session detection which uses
        // INITIAL_SESSION). Clear any stale data that may belong to a previous
        // user context. This fires synchronously *before* signInWithPassword()
        // resolves in login.tsx — so the prefetchQuery that follows lands into
        // the now-empty cache, giving a clean cache hit on dashboard mount.
        queryClient.clear();
      } else {
        // TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION, PASSWORD_RECOVERY:
        // only re-validate the session query; don't disturb other cached data.
        queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      }
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  // Background backend validation — starts IMMEDIATELY (not gated on getSession).
  // fetchSession() calls getSessionToken() internally; if there is no token it
  // returns {status:401, user:null} without hitting the network. Starting the
  // query unconditionally means the Vercel serverless function begins warming up
  // ~0 ms after app init instead of after the getSession() Promise resolves.
  // On a cold-start backend this overlap can save several seconds.
  const { data, isLoading: queryLoading } = useQuery<SessionResult>({
    queryKey: ["/api/auth/session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: true,
  });

  const backendStatus = data?.status ?? null;

  // Loading = haven't read localStorage yet (< 5ms in practice)
  const isLoading = hasLocalSession === null;

  // Optimistic auth: trust local session until backend says otherwise
  // - hasLocalSession = true AND backend hasn't returned 401/403 yet → authed
  // - hasLocalSession = false → not authed (localStorage is definitive for this)
  // - backend returns 401 → override optimistic (token expired)
  const isAuthed =
    hasLocalSession === true &&
    backendStatus !== 401 &&
    backendStatus !== 403;

  const isLockdown = backendStatus === 403;

  // Prefer backend-verified user object; fall back to null while loading
  const user = data?.user ?? null;

  return {
    isLoading,
    user,
    status: backendStatus,
    isAuthed,
    isLockdown,
  };
}
