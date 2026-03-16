import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
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
import SecuritySettings from "@/pages/settings/security";

function Router() {
  return (
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

        {/* Auth routes */}
        <Route path="/auth/login" component={AuthLogin} />
        <Route path="/auth/password-reset" component={AuthPasswordResetRequest} />
        <Route path="/auth/password-reset-confirm" component={AuthPasswordResetConfirm} />
        <Route path="/auth/email-verify" component={AuthEmailVerify} />
        <Route path="/auth/invite-accept" component={AuthInviteAccept} />
        <Route path="/auth/mfa-challenge" component={AuthMfaChallenge} />
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

        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
