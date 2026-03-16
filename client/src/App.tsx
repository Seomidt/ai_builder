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
