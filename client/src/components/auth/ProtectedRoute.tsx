/**
 * ProtectedRoute — Client-side auth guard
 *
 * Wraps protected app surfaces. Behavior:
 *   Loading   → shows spinner (prevents flash of unauth content)
 *   401       → redirects to /auth/login
 *   403       → shows lockdown / access-denied screen (no redirect)
 *   200       → renders children
 *
 * Backend enforcement remains the primary security layer.
 * This guard provides the correct UX for unauthenticated/blocked users.
 */

import { Redirect, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function LoadingScreen() {
  return (
    <div
      className="flex items-center justify-center h-screen bg-background"
      data-testid="auth-loading-screen"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Checking session…</p>
      </div>
    </div>
  );
}

function LockdownScreen() {
  return (
    <div
      className="flex items-center justify-center h-screen bg-background"
      data-testid="auth-lockdown-screen"
    >
      <div className="max-w-md text-center px-6">
        <div className="mb-4 text-4xl">🔒</div>
        <h1 className="text-2xl font-bold mb-2" data-testid="text-lockdown-title">
          Access Restricted
        </h1>
        <p className="text-muted-foreground text-sm" data-testid="text-lockdown-message">
          This platform is in emergency lockdown. Your account is not authorised
          to access this surface. Contact the platform administrator.
        </p>
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isLoading, isAuthed, isLockdown } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (isLockdown) {
    return <LockdownScreen />;
  }

  if (!isAuthed) {
    return <Redirect to="/auth/login" />;
  }

  return <>{children}</>;
}
