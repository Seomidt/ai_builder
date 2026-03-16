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
import TenantDashboard from "@/pages/tenant/dashboard";
import TenantData from "@/pages/tenant/data";
import TenantAi from "@/pages/tenant/ai";
import TenantUsage from "@/pages/tenant/usage";
import TenantBilling from "@/pages/tenant/billing";
import TenantIntegrations from "@/pages/tenant/integrations";
import TenantTeam from "@/pages/tenant/team";
import TenantSettings from "@/pages/tenant/settings";
import TenantAudit from "@/pages/tenant/audit";

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

        {/* Tenant Portal routes */}
        <Route path="/tenant" component={TenantDashboard} />
        <Route path="/tenant/data" component={TenantData} />
        <Route path="/tenant/ai" component={TenantAi} />
        <Route path="/tenant/usage" component={TenantUsage} />
        <Route path="/tenant/billing" component={TenantBilling} />
        <Route path="/tenant/integrations" component={TenantIntegrations} />
        <Route path="/tenant/team" component={TenantTeam} />
        <Route path="/tenant/settings" component={TenantSettings} />
        <Route path="/tenant/audit" component={TenantAudit} />

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
