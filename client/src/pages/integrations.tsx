import { useQuery, useMutation } from "@tanstack/react-query";
import { CheckCircle, Circle, Settings } from "lucide-react";
import { SiGithub, SiOpenai, SiVercel, SiSupabase, SiCloudflare } from "react-icons/si";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Integration } from "@shared/schema";

type Provider = Integration["provider"];

const PROVIDER_META: Record<Provider, {
  label: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  v1Ready: boolean;
}> = {
  github: {
    label: "GitHub",
    description: "Source of truth for code generation. Required for branch/PR operations.",
    icon: SiGithub,
    iconColor: "text-white",
    v1Ready: true,
  },
  openai: {
    label: "OpenAI",
    description: "AI provider for agent execution. Abstracted behind provider interface.",
    icon: SiOpenai,
    iconColor: "text-green-400",
    v1Ready: true,
  },
  vercel: {
    label: "Vercel",
    description: "Deployment target. Full integration planned for V2.",
    icon: SiVercel,
    iconColor: "text-white",
    v1Ready: false,
  },
  supabase: {
    label: "Supabase",
    description: "Auth and database provider. Used as platform foundation.",
    icon: SiSupabase,
    iconColor: "text-green-400",
    v1Ready: false,
  },
  cloudflare: {
    label: "Cloudflare",
    description: "DNS and edge layer. Planned for V3.",
    icon: SiCloudflare,
    iconColor: "text-orange-400",
    v1Ready: false,
  },
};

function IntegrationCard({ integration, onConfigure }: { integration: Integration; onConfigure: (provider: Provider) => void }) {
  const meta = PROVIDER_META[integration.provider];
  const Icon = meta.icon;
  const isActive = integration.status === "active";

  return (
    <Card data-testid={`integration-card-${integration.provider}`} className="bg-card border-card-border hover:border-primary/20 transition-colors">
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted/50 shrink-0">
            <Icon className={`w-5 h-5 ${meta.iconColor}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-semibold text-card-foreground">{meta.label}</p>
              {isActive ? (
                <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-muted-foreground/30" />
              )}
              {!meta.v1Ready && (
                <Badge variant="outline" className="text-xs text-muted-foreground border-border">V2+</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{meta.description}</p>
            <div className="flex items-center justify-between mt-3">
              <Badge
                variant="outline"
                className={`text-xs border capitalize ${isActive ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-muted-foreground/60 border-border"}`}
              >
                {isActive ? "Configured" : "Not configured"}
              </Badge>
              {meta.v1Ready && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onConfigure(integration.provider)}
                  data-testid={`btn-configure-${integration.provider}`}
                >
                  <Settings className="w-3 h-3 mr-1" />
                  {isActive ? "Reconfigure" : "Configure"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Integrations() {
  const [configProvider, setConfigProvider] = useState<Provider | null>(null);
  const { toast } = useToast();

  const { data: integrations, isLoading } = useQuery<Integration[]>({ queryKey: ["/api/integrations"] });

  const enableMutation = useMutation({
    mutationFn: async (provider: Provider) => {
      await apiRequest("POST", "/api/integrations", { provider, status: "active" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
      setConfigProvider(null);
      toast({ title: "Integration configured" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const configMeta = configProvider ? PROVIDER_META[configProvider] : null;

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Connect external services to your AI Builder Platform</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {integrations?.map((integration) => (
            <IntegrationCard
              key={integration.provider}
              integration={integration}
              onConfigure={(p) => setConfigProvider(p)}
            />
          ))}
        </div>
      )}

      <Dialog open={!!configProvider} onOpenChange={() => setConfigProvider(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Configure {configMeta?.label}</DialogTitle>
            <DialogDescription>
              Provider secrets are stored securely server-side only and never exposed to the client.
              Set them via environment variables in your deployment.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground space-y-1">
              {configProvider === "github" && (
                <>
                  <p className="font-mono">GITHUB_TOKEN=ghp_xxxx</p>
                  <p className="mt-2 text-muted-foreground/70">Set this in your .env file or deployment environment. This marks the integration as active.</p>
                </>
              )}
              {configProvider === "openai" && (
                <>
                  <p className="font-mono">OPENAI_API_KEY=sk-xxxx</p>
                  <p className="mt-2 text-muted-foreground/70">Set this in your .env file or deployment environment. This marks the integration as active.</p>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigProvider(null)}>Cancel</Button>
            <Button
              onClick={() => configProvider && enableMutation.mutate(configProvider)}
              disabled={enableMutation.isPending}
              data-testid={`btn-confirm-configure-${configProvider}`}
            >
              {enableMutation.isPending ? "Saving…" : "Mark as Configured"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
