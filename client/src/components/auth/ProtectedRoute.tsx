/**
 * ProtectedRoute — Client-side auth guard
 *
 * Loading states (isLoading in useAuth):
 *   - localStorage not checked yet              → spinner
 *   - local session exists + backend in-flight  → spinner (no premature redirect)
 *
 * After loading:
 *   - isAuthed = false (backend returned 401/403) → redirect to /auth/login
 *   - isAuthed = true  (backend returned 200)     → render children
 *   - isAuthed = true  (network error, status 0)  → render optimistically (retry on focus)
 *
 * KEY: isAuthed already encodes the 401/403 signal from the backend.
 * Using !isAuthed (not !user) means network errors don't cause false logouts.
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
  const { isLoading, isLockdown, isAuthed } = useAuth();

  // Wait for localStorage + backend session before deciding.
  // useAuth's isLoading is true until both are resolved.
  if (isLoading) {
    return <BootSpinner />;
  }

  if (isLockdown) {
    return <LockdownScreen />;
  }

  // isAuthed = false only when backend explicitly returned 401 or 403.
  // Network errors (status 0) keep isAuthed = true so we render optimistically.
  if (!isAuthed) {
    return <Redirect to="/auth/login" />;
  }

  return <>{children}</>;
}
