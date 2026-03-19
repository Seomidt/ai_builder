import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { I18nProvider } from "@/components/providers/I18nProvider";
import Dashboard from "@/pages/dashboard";
import Projects from "@/pages/projects";
import Architectures from "@/pages/architectures";
import Runs from "@/pages/runs";
import RunDetail from "@/pages/run-detail";
import Integrations from "@/pages/integrations";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";
import OpsDashboard from "@/pages/ops/dashboard";
import OpsTenants from "@/pages/ops/tenants";
import OpsJobs from "@/pages/ops/jobs";
import OpsWebhooks from "@/pages/ops/webhooks";
import OpsAi from "@/pages/ops/ai";
import OpsBilling from "@/pages/ops/billing";
import OpsRecovery from "@/pages/ops/recovery";
import OpsSecurity from "@/pages/ops/security";
import OpsAssistant from "@/pages/ops/assistant";
import OpsRelease from "@/pages/ops/release";
import OpsAuthSecurity from "@/pages/ops/auth";
import AuthLogin from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify from "@/pages/auth/email-verify";
import AuthInviteAccept from "@/pages/auth/invite-accept";
import AuthMfaChallenge from "@/pages/auth/mfa-challenge";
import AuthCallback from "@/pages/auth/callback";
import SecuritySettings from "@/pages/settings/security";
import OpsStorage from "@/pages/ops/storage";

/**
 * Protected inner routes — only rendered when ProtectedRoute clears session.
 * AppShell (sidebar + layout) is only shown to authenticated users.
 */
function ProtectedApp() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Switch>
          {/* Platform routes */}
          <Route path="/" component={Dashboard} />
          <Route path="/projects" component={Projects} />
          <Route path="/architectures" component={Architectures} />
          <Route path="/runs" component={Runs} />
          <Route path="/runs/:id" component={RunDetail} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/security" component={SecuritySettings} />

          {/* Ops Console routes */}
          <Route path="/ops" component={OpsDashboard} />
          <Route path="/ops/tenants" component={OpsTenants} />
          <Route path="/ops/jobs" component={OpsJobs} />
          <Route path="/ops/webhooks" component={OpsWebhooks} />
          <Route path="/ops/ai" component={OpsAi} />
          <Route path="/ops/billing" component={OpsBilling} />
          <Route path="/ops/recovery" component={OpsRecovery} />
          <Route path="/ops/security" component={OpsSecurity} />
          <Route path="/ops/assistant" component={OpsAssistant} />
          <Route path="/ops/release" component={OpsRelease} />
          <Route path="/ops/auth" component={OpsAuthSecurity} />
          <Route path="/ops/storage" component={OpsStorage} />

          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </ProtectedRoute>
  );
}

/**
 * Top-level router.
 *
 * Auth routes (/auth/*) are PUBLIC — no ProtectedRoute, no AppShell.
 * Every other route falls into the catch-all which applies ProtectedRoute.
 *
 * This ensures:
 * - Unauthenticated users see /auth/login (not a dashboard shell)
 * - Lockdown-blocked users see the access-denied screen
 * - The AppShell/sidebar is NEVER rendered for unauthenticated users
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
