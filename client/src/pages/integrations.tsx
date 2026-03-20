import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle, Circle, Settings, AlertCircle } from "lucide-react";
import { SiGithub, SiOpenai, SiVercel, SiSupabase, SiCloudflare } from "react-icons/si";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabase";
import { QUERY_POLICY, PAGE_LIMIT } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";
import { usePagePerf } from "@/lib/perf";
import type { Integration } from "@shared/schema";

type Provider = Integration["provider"];

interface IntegrationRow {
  id: string;
  provider: Provider;
  status: string;
  createdAt: string;
}

interface IntegrationPage {
  items: IntegrationRow[];
  nextCursor: string | null;
}

interface ConfigStatus {
  supabase: { url: string | null; connected: boolean };
  github: { connected: boolean; owner: string | null; repo: string | null };
  openai: { connected: boolean };
}

const PROVIDER_META: Record<Provider, {
  label: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  phase: "V1" | "V2" | "V3";
}> = {
  github: {
    label: "GitHub",
    description: "Source of truth for generated code. Required for branch creation, file writes and PR operations.",
    icon: SiGithub,
    iconColor: "text-white",
    phase: "V1",
  },
  openai: {
    label: "OpenAI",
    description: "Primary AI provider abstracted behind a provider interface. Set OPENAI_API_KEY server-side.",
    icon: SiOpenai,
    iconColor: "text-green-400",
    phase: "V1",
  },
  supabase: {
    label: "Supabase",
    description: "Platform auth and database foundation. Already wired as the identity and DB layer.",
    icon: SiSupabase,
    iconColor: "text-emerald-400",
    phase: "V1",
  },
  vercel: {
    label: "Vercel",
    description: "Deployment target for builder app and generated projects. Full integration planned for V2.",
    icon: SiVercel,
    iconColor: "text-white",
    phase: "V2",
  },
  cloudflare: {
    label: "Cloudflare",
    description: "DNS and edge layer. Planned as future runtime for V3.",
    icon: SiCloudflare,
    iconColor: "text-orange-400",
    phase: "V3",
  },
};

function getPhaseColor(phase: string) {
  if (phase === "V1") return "text-primary border-primary/25 bg-primary/8";
  if (phase === "V2") return "text-secondary border-secondary/25 bg-secondary/8";
  return "text-muted-foreground border-border bg-muted/30";
}

function IntegrationCard({
  integration,
  configStatus,
  onConfigure,
}: {
  integration: IntegrationRow;
  configStatus?: ConfigStatus;
  onConfigure: (provider: Provider) => void;
}) {
  const meta = PROVIDER_META[integration.provider];
  if (!meta) return null;
  const Icon = meta.icon;

  let isActive = integration.status === "active";
  let envStatus: string | null = null;

  if (integration.provider === "github" && configStatus) {
    isActive = configStatus.github.connected;
    if (configStatus.github.owner) envStatus = `${configStatus.github.owner}/${configStatus.github.repo || "…"}`;
  }
  if (integration.provider === "openai" && configStatus) {
    isActive = configStatus.openai.connected;
  }
  if (integration.provider === "supabase" && configStatus) {
    isActive = configStatus.supabase.connected;
    envStatus = configStatus.supabase.url;
  }

  return (
    <Card
      data-testid={`integration-card-${integration.provider}`}
      className="bg-card border-card-border hover:border-primary/20 transition-colors"
    >
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
              <Badge variant="outline" className={`text-xs border ${getPhaseColor(meta.phase)}`}>
                {meta.phase}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{meta.description}</p>
            {envStatus && (
              <p className="text-xs font-mono text-muted-foreground/60 mt-1 truncate">{envStatus}</p>
            )}
            <div className="flex items-center justify-between mt-3">
              <Badge
                variant="outline"
                className={`text-xs border capitalize ${
                  isActive
                    ? "text-green-400 border-green-500/30 bg-green-500/10"
                    : "text-muted-foreground/60 border-border"
                }`}
              >
                {isActive ? "Connected" : "Not configured"}
              </Badge>
              {meta.phase === "V1" && integration.provider !== "supabase" && (
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
  const perf = usePagePerf("integrations");

  const {
    data,
    isLoading,
  } = useInfiniteQuery<IntegrationPage>({
    queryKey: ["integrations"],
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.rpc("get_integrations_page", {
        p_limit: PAGE_LIMIT.integrations,
        p_cursor: (pageParam as string | null) ?? null,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as IntegrationPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...QUERY_POLICY.staticList,
  });

  const integrations = data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => {
    if (integrations.length > 0 || !isLoading) perf.record(integrations.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations.length, isLoading]);

  const { data: configStatus } = useQuery<ConfigStatus>({
    queryKey: ["/api/config/status"],
    ...QUERY_POLICY.staticList,
  });

  const enableMutation = useMutation({
    mutationFn: async (provider: Provider) => {
      await apiRequest("POST", "/api/integrations", { provider, status: "active" });
    },
    onSuccess: () => {
      invalidate.afterIntegrationMutation();
      setConfigProvider(null);
      toast({ title: "Integration marked as configured" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const configMeta = configProvider ? PROVIDER_META[configProvider] : null;

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Connect external services. Provider secrets are always server-side only.
        </p>
      </div>

      {!configStatus?.github.connected && (
        <div className="flex items-start gap-3 rounded-md border border-secondary/25 bg-secondary/8 p-3">
          <AlertCircle className="w-4 h-4 text-secondary shrink-0 mt-0.5" />
          <p className="text-xs text-secondary">
            GitHub token not detected. Set <code className="font-mono bg-muted px-1 rounded">GITHUB_TOKEN</code> in your environment to enable code generation and PR tools.
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.provider}
              integration={integration}
              configStatus={configStatus}
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
              Secrets are stored as environment variables server-side only — never in the database or exposed to the browser.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground space-y-1.5">
              {configProvider === "github" && (
                <>
                  <p className="font-medium text-foreground mb-2">Required environment variables:</p>
                  <p className="font-mono">GITHUB_TOKEN=ghp_xxxx</p>
                  <p className="font-mono text-muted-foreground/60">GITHUB_OWNER=your-org  <span className="text-muted-foreground/40"># optional</span></p>
                  <p className="font-mono text-muted-foreground/60">GITHUB_REPO=your-repo  <span className="text-muted-foreground/40"># optional</span></p>
                  <p className="mt-2 text-muted-foreground/70">
                    The GITHUB_TOKEN is already set in Replit Secrets. Click "Mark as configured" to register this integration.
                  </p>
                </>
              )}
              {configProvider === "openai" && (
                <>
                  <p className="font-medium text-foreground mb-2">Required environment variables:</p>
                  <p className="font-mono">OPENAI_API_KEY=sk-xxxx</p>
                  <p className="mt-2 text-muted-foreground/70">
                    Set OPENAI_API_KEY in Replit Secrets, then click "Mark as configured".
                  </p>
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
