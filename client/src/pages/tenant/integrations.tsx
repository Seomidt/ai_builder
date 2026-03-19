import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plug, CheckCircle, AlertTriangle, Circle, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { SiGithub, SiOpenai, SiSupabase, SiVercel } from "react-icons/si";
import type { Integration } from "@shared/schema";

const PROVIDER_ICONS: Record<string, React.ElementType> = {
  github:  SiGithub,
  openai:  SiOpenai,
  supabase: SiSupabase,
  vercel:  SiVercel,
};

const PROVIDER_COLORS: Record<string, string> = {
  github:   "text-white",
  openai:   "text-green-400",
  supabase: "text-emerald-400",
  vercel:   "text-white",
};

function IntegrationCard({ integration }: { integration: Integration }) {
  const Icon       = PROVIDER_ICONS[integration.provider] ?? Plug;
  const iconColor  = PROVIDER_COLORS[integration.provider] ?? "text-primary";
  const isActive   = integration.status === "active";

  return (
    <Card
      className="bg-card border-card-border hover:shadow-sm transition-shadow"
      data-testid={`integration-card-${integration.id}`}
    >
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
              <Icon className={`w-5 h-5 ${iconColor}`} />
            </div>
            <div>
              <p className="text-sm font-medium capitalize" data-testid={`integration-name-${integration.id}`}>
                {integration.provider}
              </p>
              <p className="text-xs text-muted-foreground">
                {(integration as any).description ?? "External service integration"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {isActive
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              : <AlertTriangle className="w-3.5 h-3.5 text-secondary" />}
            <Badge
              variant="outline"
              className={isActive
                ? "text-xs bg-green-500/15 text-green-400 border-green-500/25"
                : "text-xs bg-secondary/15 text-secondary border-secondary/25"}
              data-testid={`integration-status-${integration.id}`}
            >
              {integration.status}
            </Badge>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" size="sm" className="text-xs gap-1" data-testid={`button-configure-${integration.id}`}>
            Configure
          </Button>
          <Button variant="ghost" size="sm" className="text-xs gap-1" data-testid={`button-view-logs-${integration.id}`}>
            <ExternalLink className="w-3 h-3" /> Logs
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TenantIntegrations() {
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");

  const { data: integrations, isLoading } = useQuery<Integration[]>({
    queryKey: ["/api/integrations"],
  });

  const filtered = (integrations ?? []).filter((i) => {
    if (filter === "active")   return i.status === "active";
    if (filter === "inactive") return i.status !== "active";
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Plug className="w-5 h-5 text-primary" /> Integrations
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Manage webhooks, API keys, and external services</p>
          </div>
          <div className="flex gap-1" data-testid="integration-filter">
            {(["all", "active", "inactive"] as const).map((f) => (
              <Button
                key={f}
                variant={filter === f ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(f)}
                data-testid={`button-filter-${f}`}
                className="text-xs capitalize"
              >
                {f}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="integrations-grid">
            {filtered.map((i) => <IntegrationCard key={i.id} integration={i} />)}
          </div>
        ) : (
          <Card className="bg-card border-card-border">
            <CardContent className="py-8 text-center">
              <Plug className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground" data-testid="no-integrations-msg">
                {filter === "all" ? "No integrations configured" : `No ${filter} integrations`}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
