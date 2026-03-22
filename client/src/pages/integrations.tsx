/**
 * Platform Integrations Dashboard — Admin Surface
 *
 * Shows real configuration status for all platform integrations.
 * Data comes from /api/admin/integrations/status (server-side env checks).
 * Secrets are NEVER exposed — only boolean status and env var NAMES.
 */

import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Box,
  RefreshCw,
  Mail,
  Webhook,
} from "lucide-react";
import {
  SiOpenai,
  SiAnthropic,
  SiGooglegemini,
  SiGithub,
  SiStripe,
  SiSupabase,
  SiVercel,
  SiCloudflare,
} from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { QUERY_POLICY } from "@/lib/query-policy";

// ── Types ─────────────────────────────────────────────────────────────────────

type ProviderStatus = "healthy" | "warning" | "missing" | "stub";
type ProviderCategory = "ai" | "platform" | "infra";

interface IntegrationStatus {
  key: string;
  label: string;
  category: ProviderCategory;
  configured: boolean;
  status: ProviderStatus;
  message: string;
  requiredEnvVars: string[];
  missingEnvVars: string[];
  docsHint?: string;
}

interface PlatformIntegrationsReport {
  providers: IntegrationStatus[];
  summary: {
    total: number;
    healthy: number;
    missing: number;
    warning: number;
    stub: number;
  };
  generatedAt: string;
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  openai:     { icon: SiOpenai,      color: "text-green-400" },
  anthropic:  { icon: SiAnthropic,   color: "text-orange-300" },
  gemini:     { icon: SiGooglegemini,color: "text-blue-400" },
  supabase:   { icon: SiSupabase,    color: "text-emerald-400" },
  github:     { icon: SiGithub,      color: "text-slate-200" },
  stripe:     { icon: SiStripe,      color: "text-violet-400" },
  vercel:     { icon: SiVercel,      color: "text-white" },
  cloudflare: { icon: SiCloudflare,  color: "text-orange-400" },
  email:      { icon: Mail,          color: "text-sky-400" },
  webhooks:   { icon: Webhook,       color: "text-cyan-400" },
};

const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  ai:       "AI Providers",
  platform: "Platform",
  infra:    "Infrastructure",
};

// ── Status helpers ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ProviderStatus }) {
  if (status === "healthy") {
    return (
      <Badge variant="outline" className="text-green-400 border-green-500/30 bg-green-500/10 text-xs">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Connected
      </Badge>
    );
  }
  if (status === "missing") {
    return (
      <Badge variant="outline" className="text-red-400 border-red-500/30 bg-red-500/10 text-xs">
        <XCircle className="w-3 h-3 mr-1" />
        Missing
      </Badge>
    );
  }
  if (status === "warning") {
    return (
      <Badge variant="outline" className="text-amber-400 border-amber-500/30 bg-amber-500/10 text-xs">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Warning
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-slate-400 border-slate-600/50 bg-slate-500/10 text-xs">
      <Box className="w-3 h-3 mr-1" />
      Not implemented
    </Badge>
  );
}

// ── Integration card ──────────────────────────────────────────────────────────

function IntegrationCard({ provider }: { provider: IntegrationStatus }) {
  const meta = PROVIDER_ICON[provider.key];
  const Icon = meta?.icon ?? Box;
  const iconColor = meta?.color ?? "text-slate-400";

  return (
    <div
      data-testid={`integration-card-${provider.key}`}
      className="flex items-start gap-4 p-4 rounded-xl border border-white/8 bg-card/50 hover:border-white/15 transition-colors"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted/50 shrink-0">
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-sm font-semibold text-foreground">{provider.label}</span>
          <StatusBadge status={provider.status} />
        </div>

        <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
          {provider.message}
        </p>

        {provider.missingEnvVars.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {provider.missingEnvVars.map((v) => (
              <code
                key={v}
                className="text-[10px] font-mono bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded"
              >
                {v}
              </code>
            ))}
          </div>
        )}

        {provider.docsHint && provider.status !== "healthy" && (
          <p className="text-[10px] text-muted-foreground/60 mt-1">{provider.docsHint}</p>
        )}
      </div>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ summary }: { summary: PlatformIntegrationsReport["summary"] }) {
  return (
    <div className="flex flex-wrap gap-3">
      <div className="flex items-center gap-1.5 text-sm">
        <CheckCircle2 className="w-4 h-4 text-green-400" />
        <span className="text-foreground font-medium">{summary.healthy}</span>
        <span className="text-muted-foreground">connected</span>
      </div>
      {summary.missing > 0 && (
        <div className="flex items-center gap-1.5 text-sm">
          <XCircle className="w-4 h-4 text-red-400" />
          <span className="text-foreground font-medium">{summary.missing}</span>
          <span className="text-muted-foreground">missing</span>
        </div>
      )}
      {summary.warning > 0 && (
        <div className="flex items-center gap-1.5 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <span className="text-foreground font-medium">{summary.warning}</span>
          <span className="text-muted-foreground">warning</span>
        </div>
      )}
      {summary.stub > 0 && (
        <div className="flex items-center gap-1.5 text-sm">
          <Box className="w-4 h-4 text-slate-500" />
          <span className="text-foreground font-medium">{summary.stub}</span>
          <span className="text-muted-foreground">not implemented</span>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Integrations() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<PlatformIntegrationsReport>({
    queryKey: ["/api/admin/integrations/status"],
    ...QUERY_POLICY.staticList,
  });

  const grouped = data
    ? (["ai", "platform", "infra"] as ProviderCategory[]).map((cat) => ({
        category: cat,
        label: CATEGORY_LABEL[cat],
        providers: data.providers.filter((p) => p.category === cat),
      })).filter((g) => g.providers.length > 0)
    : [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Platform provider status. Secrets are server-side only — never exposed to the browser.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-integrations"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 p-3">
          <XCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">
            Could not load integrations status. Check server connectivity.
          </p>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-4 w-24" />
              <div className="space-y-2">
                {[1, 2, 3].map((j) => <Skeleton key={j} className="h-20 w-full rounded-xl" />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary + providers */}
      {data && (
        <>
          {/* Summary bar */}
          <div className="rounded-xl border border-white/8 bg-card/30 p-4">
            <SummaryBar summary={data.summary} />
            <p className="text-[10px] text-muted-foreground/50 mt-2">
              Last checked: {new Date(data.generatedAt).toLocaleTimeString()}
            </p>
          </div>

          {/* Warning for missing critical providers */}
          {data.providers.filter((p) => p.status === "missing" && ["openai", "supabase", "github"].includes(p.key)).length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                One or more critical providers are not configured. Platform features may be degraded.
                Set the missing environment variables in your secrets manager.
              </p>
            </div>
          )}

          {/* Grouped provider sections */}
          {grouped.map(({ category, label, providers }) => (
            <div key={category} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</h2>
                <div className="flex-1 h-px bg-white/5" />
                <span className="text-xs text-muted-foreground/50">
                  {providers.filter((p) => p.status === "healthy").length}/{providers.length} connected
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {providers.map((provider) => (
                  <IntegrationCard key={provider.key} provider={provider} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
