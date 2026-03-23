/**
 * Platform Integrations Health Dashboard — Final Enterprise Pass
 *
 * Shows live health status of all platform-managed integrations.
 * Resilient: degraded state, latency classification, impact text,
 * last success/failure tracking, cache status indicator.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertTriangle, Box,
  RefreshCw, Mail, Webhook, Clock, Zap,
  ShieldAlert, Activity, TrendingDown,
} from "lucide-react";
import {
  SiOpenai, SiAnthropic, SiGooglegemini,
  SiGithub, SiStripe, SiSupabase, SiVercel, SiCloudflare,
} from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getSessionToken } from "@/lib/supabase";

// ── Types (mirror server canonical model) ─────────────────────────────────────

type HealthStatus = "connected" | "degraded" | "missing" | "invalid" | "expired" | "partial" | "rate_limited" | "stub";
type LatencyClass = "good" | "warning" | "poor";
type Severity = "critical" | "important" | "optional";
type ProviderGroup = "ai" | "platform" | "infrastructure";

interface ProviderHealth {
  key: string;
  label: string;
  description: string;
  category: ProviderGroup;
  severity: Severity;
  status: HealthStatus;
  requiredEnv: string[];
  missingEnv: string[];
  checkedAt: string;
  latencyMs: number | null;
  latencyClass: LatencyClass | null;
  details: Record<string, boolean | string | number | null>;
  message: string;
  impact: string[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

interface HealthGroup {
  key: ProviderGroup;
  label: string;
  providers: ProviderHealth[];
}

interface HealthSummary {
  total: number;
  connected: number;
  degraded: number;
  missing: number;
  invalid: number;
  expired: number;
  partial: number;
  rate_limited: number;
  stub: number;
  criticalFailures: number;
}

interface IntegrationsHealthReport {
  summary: HealthSummary;
  groups: HealthGroup[];
  cachedAt: string;
  fromCache: boolean;
  cacheStatus: "fresh" | "cached";
  ageMs: number;
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  openai:     { icon: SiOpenai,       color: "text-green-400" },
  anthropic:  { icon: SiAnthropic,    color: "text-orange-300" },
  gemini:     { icon: SiGooglegemini, color: "text-blue-400" },
  supabase:   { icon: SiSupabase,     color: "text-emerald-400" },
  github:     { icon: SiGithub,       color: "text-slate-200" },
  stripe:     { icon: SiStripe,       color: "text-violet-400" },
  vercel:     { icon: SiVercel,       color: "text-white" },
  cloudflare: { icon: SiCloudflare,   color: "text-orange-400" },
  email:      { icon: Mail,           color: "text-sky-400" },
  webhooks:   { icon: Webhook,        color: "text-cyan-400" },
};

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<HealthStatus, {
  label: string;
  color: string;
  border: string;
  bg: string;
  icon: React.ElementType;
}> = {
  connected:    { label: "Connected",    color: "text-green-400",  border: "border-green-500/30",  bg: "bg-green-500/10",  icon: CheckCircle2 },
  degraded:     { label: "Degraded",     color: "text-amber-300",  border: "border-amber-500/35",  bg: "bg-amber-500/10",  icon: TrendingDown },
  missing:      { label: "Missing",      color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/10",    icon: XCircle },
  invalid:      { label: "Invalid",      color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/10",    icon: XCircle },
  expired:      { label: "Expired",      color: "text-orange-400", border: "border-orange-500/30", bg: "bg-orange-500/10", icon: AlertTriangle },
  partial:      { label: "Partial",      color: "text-amber-400",  border: "border-amber-500/30",  bg: "bg-amber-500/10",  icon: AlertTriangle },
  rate_limited: { label: "Rate Limited", color: "text-amber-400",  border: "border-amber-500/30",  bg: "bg-amber-500/10",  icon: AlertTriangle },
  stub:         { label: "Not Active",   color: "text-slate-400",  border: "border-slate-600/40",  bg: "bg-slate-500/8",   icon: Box },
};

// ── Latency chip ───────────────────────────────────────────────────────────────

const LATENCY_CLASS_CONFIG: Record<LatencyClass, { color: string; label: string }> = {
  good:    { color: "text-green-400/70",  label: "" },
  warning: { color: "text-amber-400/70",  label: "slow" },
  poor:    { color: "text-red-400/70",    label: "very slow" },
};

function LatencyChip({ latencyMs, latencyClass }: { latencyMs: number; latencyClass: LatencyClass }) {
  const cfg = LATENCY_CLASS_CONFIG[latencyClass];
  return (
    <span className={`flex items-center gap-1 text-[10px] font-mono ${cfg.color}`}>
      <Zap className="w-2.5 h-2.5" />
      {latencyMs}ms{cfg.label ? ` · ${cfg.label}` : ""}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtAge(ageMs: number): string {
  if (ageMs < 5000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  return `${Math.round(ageMs / 60_000)}m ago`;
}

function StatusBadge({ status }: { status: HealthStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={`text-xs ${cfg.color} ${cfg.border} ${cfg.bg} gap-1 shrink-0`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </Badge>
  );
}

function SeverityAccent({ severity }: { severity: Severity }) {
  const map: Record<Severity, string> = {
    critical: "bg-red-500",
    important: "bg-amber-500",
    optional: "bg-slate-600",
  };
  return <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${map[severity]}`} />;
}

// ── Provider card ─────────────────────────────────────────────────────────────

function ProviderCard({ provider }: { provider: ProviderHealth }) {
  const iconMeta = PROVIDER_ICON[provider.key];
  const Icon = iconMeta?.icon ?? Box;
  const iconColor = iconMeta?.color ?? "text-slate-400";
  const statusCfg = STATUS_CONFIG[provider.status];
  const isConnected = provider.status === "connected";
  const isDegraded = provider.status === "degraded";
  const isProblematic = ["missing", "invalid", "expired"].includes(provider.status);
  const isWarn = ["partial", "rate_limited"].includes(provider.status);

  const checkedTime = fmtTime(provider.checkedAt);
  const lastSuccessTime = fmtTime(provider.lastSuccessAt);
  const lastFailureTime = fmtTime(provider.lastFailureAt);

  const iconBg = isConnected ? "bg-green-500/10"
    : isDegraded ? "bg-amber-500/10"
    : isProblematic ? "bg-red-500/10"
    : "bg-muted/40";

  return (
    <Card
      className={`bg-card border-card-border relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 ${
        isProblematic && provider.severity === "critical" ? "border-red-500/30" :
        isDegraded && provider.severity === "critical" ? "border-amber-500/30" : ""
      }`}
      data-testid={`integration-card-${provider.key}`}
    >
      <SeverityAccent severity={provider.severity} />

      <CardContent className="pt-4 pb-4 pl-5">
        {/* Header */}
        <div className="flex items-start gap-3 mb-2.5">
          <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${iconBg}`}>
            <Icon className={`w-[18px] h-[18px] ${iconColor}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
              <span className="text-sm font-semibold text-foreground leading-tight">{provider.label}</span>
              <StatusBadge status={provider.status} />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{provider.description}</p>
          </div>
        </div>

        {/* Status message */}
        <p className={`text-xs mb-2.5 leading-relaxed ${
          isProblematic ? "text-red-400/80" :
          isDegraded ? "text-amber-400/80" :
          isWarn ? "text-amber-400/70" :
          "text-muted-foreground"
        }`}>
          {provider.message}
        </p>

        {/* Impact text — only shown when not healthy */}
        {!isConnected && provider.status !== "stub" && provider.impact.length > 0 && (
          <div className="mb-2.5 pl-2 border-l border-muted/30">
            {provider.impact.map((line) => (
              <p key={line} className="text-[11px] text-muted-foreground/60 leading-relaxed">
                · {line}
              </p>
            ))}
          </div>
        )}

        {/* Missing env vars */}
        {provider.missingEnv.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2.5">
            {provider.missingEnv.map((v) => (
              <code
                key={v}
                className="text-[10px] font-mono bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded"
                data-testid={`missing-env-${provider.key}-${v}`}
              >
                {v}
              </code>
            ))}
          </div>
        )}

        {/* Capability details — only when connected/degraded */}
        {(isConnected || isDegraded) && Object.keys(provider.details).length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2.5">
            {Object.entries(provider.details)
              .filter(([, v]) => v !== null && v !== false)
              .map(([k, v]) => (
                <span key={k} className="text-[10px] font-mono bg-green-500/8 border border-green-500/15 text-green-400/65 px-1.5 py-0.5 rounded flex items-center gap-1">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  {k}{typeof v === "string" ? `: ${v}` : ""}
                </span>
              ))}
          </div>
        )}

        {/* Footer: latency + history + checked time */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground/50 mt-1">
          {provider.latencyMs !== null && provider.latencyClass !== null && (
            <LatencyChip latencyMs={provider.latencyMs} latencyClass={provider.latencyClass} />
          )}
          {lastSuccessTime && (
            <span className="flex items-center gap-1 text-green-400/40">
              <CheckCircle2 className="w-2.5 h-2.5" />
              Success {lastSuccessTime}
            </span>
          )}
          {lastFailureTime && (
            <span className="flex items-center gap-1 text-red-400/40">
              <XCircle className="w-2.5 h-2.5" />
              Failure {lastFailureTime}
            </span>
          )}
          {checkedTime && (
            <span className="flex items-center gap-1 ml-auto">
              <Clock className="w-2.5 h-2.5" />
              {checkedTime}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Summary stat ───────────────────────────────────────────────────────────────

function StatPill({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-sm font-bold tabular-nums ${color}`}>{count}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Integrations() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, isFetching } = useQuery<IntegrationsHealthReport>({
    queryKey: ["/api/admin/integrations/health"],
    queryFn: async () => {
      const token = await getSessionToken();
      const res = await fetch("/api/admin/integrations/health", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  function handleRefresh() {
    // Force cache bypass via ?refresh=true
    queryClient.fetchQuery({
      queryKey: ["/api/admin/integrations/health"],
      queryFn: async () => {
        const token = await getSessionToken();
        const res = await fetch("/api/admin/integrations/health?refresh=true", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
        return res.json();
      },
    }).then((fresh) => {
      queryClient.setQueryData(["/api/admin/integrations/health"], fresh);
    }).catch(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/health"] });
    });
  }

  const s = data?.summary;
  const hasCriticalFailures = (s?.criticalFailures ?? 0) > 0;
  const totalProblems = s ? (s.missing + s.invalid + s.expired + s.partial + s.rate_limited + s.degraded) : 0;
  const hasWarnings = !hasCriticalFailures && totalProblems > 0;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-5xl" data-testid="integrations-page">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.18)" }}
            >
              <Activity className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-integrations-title">
              Platform Integrations
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Platform-managed integrations used by the BlissOps runtime. Secrets are server-side only and never exposed.
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          data-testid="button-refresh-integrations"
          className="text-muted-foreground shrink-0"
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Checking..." : "Refresh"}
        </Button>
      </div>

      {/* ── Critical alert banner ────────────────────────────────────────────── */}
      {!isLoading && hasCriticalFailures && (
        <Card
          className="border-red-500/30"
          style={{ background: "rgba(239,68,68,0.07)" }}
          data-testid="critical-alert-banner"
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-300 mb-1">
                  Critical platform dependencies are degraded
                </p>
                <p className="text-xs text-red-400/70 leading-relaxed">
                  AI execution or core runtime features may be affected. Review the providers below — degraded, partial, or rate-limited status on critical integrations requires immediate operator attention.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Error state ──────────────────────────────────────────────────────── */}
      {error && !isLoading && (
        <Card className="bg-destructive/8 border-destructive/25">
          <CardContent className="pt-4 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-destructive shrink-0" />
            <p className="text-sm text-destructive">
              Health check failed — {(error as Error).message}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Summary bar ──────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex gap-5 flex-wrap">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-20" />)}
        </div>
      ) : s ? (
        <Card className="bg-card/50 border-card-border" data-testid="summary-bar">
          <CardContent className="pt-3.5 pb-3.5">
            <div className="flex flex-wrap gap-x-5 gap-y-2 items-center">
              <StatPill count={s.connected}    label="connected"    color="text-green-400" />
              {s.degraded > 0      && <StatPill count={s.degraded}      label="degraded"      color="text-amber-300" />}
              {s.missing > 0       && <StatPill count={s.missing}       label="missing"       color="text-red-400" />}
              {s.invalid > 0       && <StatPill count={s.invalid}       label="invalid"       color="text-red-400" />}
              {s.expired > 0       && <StatPill count={s.expired}       label="expired"       color="text-orange-400" />}
              {s.partial > 0       && <StatPill count={s.partial}       label="partial"       color="text-amber-400" />}
              {s.rate_limited > 0  && <StatPill count={s.rate_limited}  label="rate limited"  color="text-amber-400" />}
              {s.stub > 0          && <StatPill count={s.stub}          label="not active"    color="text-slate-400" />}
              {s.criticalFailures > 0 && (
                <span className="flex items-center gap-1 text-xs text-red-400/80 ml-1">
                  <ShieldAlert className="w-3 h-3" />
                  {s.criticalFailures} critical
                </span>
              )}

              <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
                {data?.cacheStatus === "cached" ? (
                  <>
                    <Clock className="w-3 h-3" />
                    Cached · {fmtAge(data.ageMs)} · {new Date(data.cachedAt).toLocaleTimeString("da-DK")}
                  </>
                ) : (
                  <>
                    <Activity className="w-3 h-3" />
                    Fresh check · {new Date(data?.cachedAt ?? "").toLocaleTimeString("da-DK")}
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Provider groups ───────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-8">
          {[3, 3, 4].map((count, gi) => (
            <div key={gi} className="space-y-3">
              <Skeleton className="h-4 w-28" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Array.from({ length: count }).map((_, i) => (
                  <Skeleton key={i} className="h-40 rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {data?.groups.map(({ key, label, providers }) => {
            const groupConnected = providers.filter((p) => p.status === "connected").length;
            const groupProblems  = providers.filter((p) => ["missing", "invalid", "expired", "partial", "rate_limited", "degraded"].includes(p.status)).length;
            return (
              <div key={key} data-testid={`group-${key}`}>
                <div className="flex items-center gap-2 mb-3.5">
                  <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</h2>
                  <div className="flex-1 h-px bg-white/5" />
                  <span className={`text-[11px] ${groupProblems > 0 ? "text-amber-400/60" : "text-muted-foreground/40"}`}>
                    {groupConnected}/{providers.length} connected
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {providers.map((provider) => (
                    <ProviderCard key={provider.key} provider={provider} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Warnings summary (non-critical) ──────────────────────────────────── */}
      {!isLoading && hasWarnings && (
        <Card className="border-amber-500/20" style={{ background: "rgba(245,158,11,0.05)" }}>
          <CardContent className="pt-3.5 pb-3.5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400/70 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-300/60 leading-relaxed">
              {totalProblems} provider{totalProblems !== 1 ? "s" : ""} {totalProblems !== 1 ? "need" : "needs"} attention.
              Configure the missing environment variables in the Vercel dashboard to enable full platform functionality.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
