/**
 * ProtectedRoute — Client-side auth guard (safe, no early redirects)
 *
 * Behavior:
 *   isLoading (localStorage + backend in-flight) → skeleton spinner
 *   user !== null (backend confirmed)            → render children
 *   user === null (backend returned 401/403)     → redirect to login
 *
 * CRITICAL: never redirect before backend session resolves.
 * Redirecting based on optimistic local state caused login loops when the
 * backend (cold-start or transient error) returned 401 for valid sessions.
 */

import { Redirect } from "wouter";
import { useAuth } from "@/hooks/use-auth";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function BootSpinner() {
  return (
    <div
      className="flex items-center justify-center h-screen bg-background"
      data-testid="auth-loading-screen"
    >
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
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
  const { isLoading, isLockdown, user, isAuthed } = useAuth();

  // Wait for both localStorage check AND backend session to resolve.
  // This prevents redirecting to login on cold-start 401s or transient errors.
  if (isLoading) {
    return <BootSpinner />;
  }

  if (isLockdown) {
    return <LockdownScreen />;
  }

  // Fast path: no local session at all — skip waiting for backend
  if (!isAuthed && !user) {
    return <Redirect to="/auth/login" />;
  }

  // Backend confirmed: no valid user (401 after backend responded)
  if (!user) {
    return <Redirect to="/auth/login" />;
  }

  return <>{children}</>;
}
