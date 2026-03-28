/**
 * client/src/pages/tenant/insights.tsx
 * Phase 2.2 — Tenant Insights Engine
 *
 * Shows actionable machine-readable insights for the tenant.
 * Text is rendered from i18n keys — locale-safe by design.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, AlertCircle, Info, CheckCircle2,
  RefreshCw, X, ChevronDown, ChevronUp, Lightbulb,
  DollarSign, Cpu, Shield, Settings2, Database,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

// ── i18n dictionary (locale-safe key → Danish text) ──────────────────────────
// When a full i18n system is added, replace this lookup with the real resolver.
// Keys are the canonical model — text here is a temporary fallback.

const INSIGHT_STRINGS: Record<string, string> = {
  // budget_warning_80
  "insights.budget_warning_80.title":
    "AI-budget nærmer sig grænsen",
  "insights.budget_warning_80.description":
    "Dit AI-forbrug har oversteget advarselstærsklen for den aktuelle periode.",
  "insights.budget_warning_80.recommendation":
    "Gennemgå dit forbrug under Usage og overvej at øge budgetgrænsen eller reducere AI-aktiviteten.",

  // missing_rate_limit
  "insights.missing_rate_limit.title":
    "Ingen hastighedsbegrænsning konfigureret",
  "insights.missing_rate_limit.description":
    "Der er ikke konfigureret nogen aktiv hastighedsbegrænsning for din organisation. Det betyder ubegrænset AI-aktivitet.",
  "insights.missing_rate_limit.recommendation":
    "Konfigurer en hastighedsbegrænsning for at beskytte mod utilsigtet overforbrug og uønskede AI-kald.",

  // low_retrieval_confidence
  "insights.low_retrieval_confidence.title":
    "Lav genkendelseskvalitet i vidensøgning",
  "insights.low_retrieval_confidence.description":
    "En betydelig andel af dine seneste vidensøgninger returnerede resultater med lav tillid.",
  "insights.low_retrieval_confidence.recommendation":
    "Gennemgå dine videndatakilder og sørg for, at dokumenter er relevante, opdaterede og korrekt indekserede.",

  // high_ai_error_rate
  "insights.high_ai_error_rate.title":
    "Forhøjet AI-fejlrate",
  "insights.high_ai_error_rate.description":
    "Mere end 10% af dine AI-forespørgsler de seneste 7 dage mislykkedes.",
  "insights.high_ai_error_rate.recommendation":
    "Tjek integrationskonfigurationer og API-nøgler. Kontakt support hvis fejlene fortsætter.",

  // slow_ai_response_p95
  "insights.slow_ai_response_p95.title":
    "Langsom AI-svartid (p95)",
  "insights.slow_ai_response_p95.description":
    "95% af dine seneste AI-svar tager mere end 8 sekunder.",
  "insights.slow_ai_response_p95.recommendation":
    "Overvej at reducere prompt-kompleksitet eller skifte til en hurtigere model for realtidsopgaver.",
};

function t(key: string, fallback?: string): string {
  return INSIGHT_STRINGS[key] ?? fallback ?? key;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TenantInsight {
  id:                string;
  tenantId:          string;
  code:              string;
  category:          string;
  severity:          string;
  status:            string;
  titleKey:          string;
  descriptionKey:    string;
  recommendationKey: string;
  metadata:          Record<string, unknown> | null;
  firstDetectedAt:   string;
  lastDetectedAt:    string;
  dismissedAt:       string | null;
  resolvedAt:        string | null;
  createdAt:         string;
}

interface InsightSummary {
  total:    number;
  severity: { low: number; moderate: number; high: number };
  category: {
    security:      number;
    performance:   number;
    cost:          number;
    configuration: number;
    retrieval:     number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function severityColor(s: string) {
  if (s === "high")     return "text-red-500";
  if (s === "moderate") return "text-yellow-500";
  return "text-blue-400";
}

function severityBg(s: string) {
  if (s === "high")     return "bg-red-500/10 text-red-500 border-red-500/20";
  if (s === "moderate") return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
  return "bg-blue-500/10 text-blue-400 border-blue-500/20";
}

function SeverityIcon({ severity, className }: { severity: string; className?: string }) {
  const cls = cn(severityColor(severity), className);
  if (severity === "high")     return <AlertCircle className={cls} />;
  if (severity === "moderate") return <AlertTriangle className={cls} />;
  return <Info className={cls} />;
}

function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const cls = cn("w-4 h-4 text-muted-foreground", className);
  if (category === "cost")          return <DollarSign className={cls} />;
  if (category === "performance")   return <Cpu className={cls} />;
  if (category === "security")      return <Shield className={cls} />;
  if (category === "configuration") return <Settings2 className={cls} />;
  if (category === "retrieval")     return <Database className={cls} />;
  return <Info className={cls} />;
}

const CATEGORY_LABELS: Record<string, string> = {
  cost:          "Økonomi",
  performance:   "Performance",
  security:      "Sikkerhed",
  configuration: "Konfiguration",
  retrieval:     "Vidensøgning",
};

const SEVERITY_LABELS: Record<string, string> = {
  high:     "Høj",
  moderate: "Moderat",
  low:      "Lav",
};

// ── Summary Cards ─────────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: InsightSummary }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <Card className="bg-card border-card-border" data-testid="insights-total-card">
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-muted-foreground mb-1">Aktive insights</p>
          <p className="text-2xl font-bold" data-testid="insights-total-count">{summary.total}</p>
        </CardContent>
      </Card>

      {[
        { key: "high",     label: "Høj prioritet",  color: "text-red-500" },
        { key: "moderate", label: "Moderat",         color: "text-yellow-500" },
        { key: "low",      label: "Lav",             color: "text-blue-400" },
      ].map(({ key, label, color }) => (
        <Card key={key} className="bg-card border-card-border" data-testid={`insights-severity-${key}`}>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className={cn("text-2xl font-bold", color)}
              data-testid={`insights-severity-count-${key}`}>
              {summary.severity[key as keyof typeof summary.severity] ?? 0}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Insight Card ──────────────────────────────────────────────────────────────

function InsightCard({
  insight,
  onDismiss,
  dismissPending,
}: {
  insight:        TenantInsight;
  onDismiss:      (id: string) => void;
  dismissPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const title       = t(insight.titleKey);
  const description = t(insight.descriptionKey);
  const recommendation = t(insight.recommendationKey);

  return (
    <div
      className="border border-border rounded-lg bg-card overflow-hidden"
      data-testid={`insight-card-${insight.id}`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <SeverityIcon severity={insight.severity} className="w-5 h-5 mt-0.5 shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <Badge
              variant="outline"
              className={cn("text-[10px] px-2 py-0 border", severityBg(insight.severity))}
              data-testid={`insight-severity-${insight.id}`}
            >
              {SEVERITY_LABELS[insight.severity] ?? insight.severity}
            </Badge>
            <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`insight-category-${insight.id}`}>
              <CategoryIcon category={insight.category} />
              {CATEGORY_LABELS[insight.category] ?? insight.category}
            </span>
          </div>
          <p className="text-sm font-medium leading-snug" data-testid={`insight-title-${insight.id}`}>{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5" data-testid={`insight-description-${insight.id}`}>{description}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((e) => !e)}
            data-testid={`insight-expand-${insight.id}`}
            aria-label={expanded ? "Skjul detaljer" : "Vis detaljer"}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => onDismiss(insight.id)}
            disabled={dismissPending}
            data-testid={`insight-dismiss-${insight.id}`}
            aria-label="Afvis insight"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Expanded: recommendation + metadata */}
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
          <div className="flex gap-2">
            <Lightbulb className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
            <p className="text-xs text-foreground/80" data-testid={`insight-recommendation-${insight.id}`}>
              {recommendation}
            </p>
          </div>

          {insight.metadata && Object.keys(insight.metadata).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(insight.metadata).map(([k, v]) => (
                <span
                  key={k}
                  className="text-[11px] bg-muted rounded px-2 py-0.5 text-muted-foreground font-mono"
                  data-testid={`insight-meta-${insight.id}-${k}`}
                >
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground/60">
            Opdaget:{" "}
            {new Date(insight.firstDetectedAt).toLocaleDateString("da-DK", {
              day: "numeric", month: "short", year: "numeric",
            })}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: summary, isLoading: summaryLoading } = useQuery<InsightSummary>({
    queryKey: ["/api/insights/summary"],
    ...QUERY_POLICY.dashboard,
  });

  const { data: insights = [], isLoading: insightsLoading } = useQuery<TenantInsight[]>({
    queryKey: ["/api/insights"],
    ...QUERY_POLICY.dashboard,
  });

  const runMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/insights/run"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/insights"] });
      qc.invalidateQueries({ queryKey: ["/api/insights/summary"] });
      toast({ title: "Insights opdateret", description: "Alle regler er evalueret." });
    },
    onError: () => {
      toast({ title: "Fejl", description: "Kunne ikke opdatere insights.", variant: "destructive" });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/insights/${id}/dismiss`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/insights"] });
      qc.invalidateQueries({ queryKey: ["/api/insights/summary"] });
      toast({ title: "Afvist", description: "Insight er afvist." });
    },
    onError: () => {
      toast({ title: "Fejl", description: "Kunne ikke afvise insight.", variant: "destructive" });
    },
  });

  const isLoading = summaryLoading || insightsLoading;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="insights-heading">
            Insights
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Handlingsrettede anbefalinger til din organisation baseret på realtidsdata.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          data-testid="insights-run-btn"
          className="shrink-0"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", runMutation.isPending && "animate-spin")} />
          {runMutation.isPending ? "Analyserer…" : "Analyser nu"}
        </Button>
      </div>

      {/* ── Summary Cards ─────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : summary ? (
        <SummaryCards summary={summary} />
      ) : null}

      {/* ── Insight List ──────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {isLoading ? (
          [...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))
        ) : insights.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-16 text-center"
            data-testid="insights-empty"
          >
            <CheckCircle2 className="w-10 h-10 text-green-500 mb-3 opacity-70" />
            <p className="text-sm font-medium">Alt ser godt ud</p>
            <p className="text-xs text-muted-foreground mt-1">
              Ingen aktive insights. Klik "Analyser nu" for at køre en ny analyse.
            </p>
          </div>
        ) : (
          insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onDismiss={(id) => dismissMutation.mutate(id)}
              dismissPending={dismissMutation.isPending}
            />
          ))
        )}
      </div>
    </div>
  );
}
