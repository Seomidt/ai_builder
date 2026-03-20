import { lazy, Suspense } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AdminRoute } from "@/components/auth/AdminRoute";
import { I18nProvider } from "@/components/providers/I18nProvider";

// ── Eagerly loaded: core tenant pages (most frequently visited) ───────────────
import Dashboard from "@/pages/dashboard";
import Projects from "@/pages/projects";
import Architectures from "@/pages/architectures";
import Runs from "@/pages/runs";
import Integrations from "@/pages/integrations";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";

// ── Eagerly loaded: auth pages (needed immediately on login) ──────────────────
import AuthLogin from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify from "@/pages/auth/email-verify";
import AuthInviteAccept from "@/pages/auth/invite-accept";
import AuthMfaChallenge from "@/pages/auth/mfa-challenge";
import AuthCallback from "@/pages/auth/callback";

// ── Lazy loaded: heavy or rarely-visited pages ────────────────────────────────
// These are split into separate JS chunks and only downloaded on first visit.
// Tenant users never pay the download cost for ops/admin code.
const RunDetail        = lazy(() => import("@/pages/run-detail"));
const SecuritySettings = lazy(() => import("@/pages/settings/security"));

// Ops console — admin-only surface, completely isolated from tenant bundle
const OpsDashboard    = lazy(() => import("@/pages/ops/dashboard"));
const OpsTenants      = lazy(() => import("@/pages/ops/tenants"));
const OpsJobs         = lazy(() => import("@/pages/ops/jobs"));
const OpsWebhooks     = lazy(() => import("@/pages/ops/webhooks"));
const OpsAi           = lazy(() => import("@/pages/ops/ai"));
const OpsBilling      = lazy(() => import("@/pages/ops/billing"));
const OpsRecovery     = lazy(() => import("@/pages/ops/recovery"));
const OpsSecurity     = lazy(() => import("@/pages/ops/security"));
const OpsAssistant    = lazy(() => import("@/pages/ops/assistant"));
const OpsRelease      = lazy(() => import("@/pages/ops/release"));
const OpsAuthSecurity = lazy(() => import("@/pages/ops/auth"));
const OpsStorage      = lazy(() => import("@/pages/ops/storage"));

// ── Page-level loading fallback ───────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

/**
 * Protected inner routes — only rendered when ProtectedRoute clears session.
 * AppShell (sidebar + layout) is only shown to authenticated users.
 * Lazy pages are wrapped in Suspense so the app shell renders immediately
 * while the route chunk downloads in the background.
 */
function ProtectedApp() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Suspense fallback={<PageLoader />}>
          <Switch>
            {/* Core tenant routes — eagerly loaded */}
            <Route path="/" component={Dashboard} />
            <Route path="/projects" component={Projects} />
            <Route path="/architectures" component={Architectures} />
            <Route path="/runs" component={Runs} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/settings" component={Settings} />

            {/* Lazy tenant routes */}
            <Route path="/runs/:id" component={RunDetail} />
            <Route path="/settings/security" component={SecuritySettings} />

            {/* Ops Console routes — lazy, platform_admin only */}
            <Route path="/ops"           component={() => <AdminRoute><OpsDashboard /></AdminRoute>} />
            <Route path="/ops/tenants"   component={() => <AdminRoute><OpsTenants /></AdminRoute>} />
            <Route path="/ops/jobs"      component={() => <AdminRoute><OpsJobs /></AdminRoute>} />
            <Route path="/ops/webhooks"  component={() => <AdminRoute><OpsWebhooks /></AdminRoute>} />
            <Route path="/ops/ai"        component={() => <AdminRoute><OpsAi /></AdminRoute>} />
            <Route path="/ops/billing"   component={() => <AdminRoute><OpsBilling /></AdminRoute>} />
            <Route path="/ops/recovery"  component={() => <AdminRoute><OpsRecovery /></AdminRoute>} />
            <Route path="/ops/security"  component={() => <AdminRoute><OpsSecurity /></AdminRoute>} />
            <Route path="/ops/assistant" component={() => <AdminRoute><OpsAssistant /></AdminRoute>} />
            <Route path="/ops/release"   component={() => <AdminRoute><OpsRelease /></AdminRoute>} />
            <Route path="/ops/auth"      component={() => <AdminRoute><OpsAuthSecurity /></AdminRoute>} />
            <Route path="/ops/storage"   component={() => <AdminRoute><OpsStorage /></AdminRoute>} />

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </AppShell>
    </ProtectedRoute>
  );
}

/**
 * Top-level router.
 *
 * Auth routes (/auth/*) are PUBLIC — no ProtectedRoute, no AppShell.
 * Every other route falls into the catch-all which applies ProtectedRoute.
 */
function Router() {
  return (
    <Switch>
      {/* Public auth routes — no guard, no sidebar */}
      <Route path="/auth/login" component={AuthLogin} />
      <Route path="/auth/password-reset" component={AuthPasswordResetRequest} />
      <Route path="/auth/password-reset-confirm" component={AuthPasswordResetConfirm} />
      <Route path="/auth/email-verify" component={AuthEmailVerify} />
      <Route path="/auth/invite-accept" component={AuthInviteAccept} />
      <Route path="/auth/callback" component={AuthCallback} />
      <Route path="/auth/mfa-challenge" component={AuthMfaChallenge} />

      {/* All other routes — protected (session required) */}
      <Route component={ProtectedApp} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
