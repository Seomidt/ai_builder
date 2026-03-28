import { useQuery } from "@tanstack/react-query";
import { Zap, TrendingUp, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

interface UsageSummary {
  tenantId:         string;
  period:           { start: string; end: string };
  usedUsd:          number;
  budgetUsd:        number | null;
  remainingUsd:     number | null;
  usagePercent:     number;
  requestCount:     number;
  usageState:       "normal" | "budget_mode" | "blocked";
  isSoftExceeded:   boolean;
  isHardExceeded:   boolean;
  softLimitPercent: number;  // threshold for warning state (default 80%)
  hardLimitPercent: number;  // threshold for blocked state (default 100%)
  retrievedAt:      string;
}

function formatUsd(val: number): string {
  if (val >= 1)    return `$${val.toFixed(2)}`;
  if (val >= 0.01) return `$${val.toFixed(4)}`;
  return `$${val.toFixed(6)}`;
}

function StateChip({ state }: { state: UsageSummary["usageState"] }) {
  if (state === "blocked") {
    return (
      <Badge className="text-[10px] h-4 px-1.5 bg-destructive/15 text-destructive border-destructive/25 gap-1" variant="outline">
        <XCircle className="w-2.5 h-2.5" />
        Blokeret
      </Badge>
    );
  }
  if (state === "budget_mode") {
    return (
      <Badge className="text-[10px] h-4 px-1.5 bg-orange-500/15 text-orange-400 border-orange-500/25 gap-1" variant="outline">
        <AlertTriangle className="w-2.5 h-2.5" />
        Advarsel
      </Badge>
    );
  }
  return (
    <Badge className="text-[10px] h-4 px-1.5 bg-green-500/15 text-green-400 border-green-500/25 gap-1" variant="outline">
      <CheckCircle className="w-2.5 h-2.5" />
      Aktiv
    </Badge>
  );
}

function progressColor(state: UsageSummary["usageState"]): string {
  if (state === "blocked")     return "[&>div]:bg-destructive";
  if (state === "budget_mode") return "[&>div]:bg-orange-500";
  return "[&>div]:bg-primary";
}

export function AiUsageCard() {
  const { data, isLoading } = useQuery<UsageSummary>({
    queryKey: ["/api/usage/summary"],
    staleTime: 60_000,
    gcTime: 120_000,
  });

  const periodStart = data?.period?.start ? new Date(data.period.start) : null;
  const periodEnd   = data?.period?.end   ? new Date(data.period.end)   : null;
  const monthLabel  = periodStart
    ? periodStart.toLocaleDateString("da-DK", { month: "long", year: "numeric" })
    : null;

  // Soft limit marker position on progress bar (default 80%)
  const softMarkerPct = data?.softLimitPercent ?? 80;

  return (
    <Card className="bg-card border-card-border" data-testid="card-ai-usage">
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Zap className="w-4 h-4 text-primary" />
            AI Forbrug
          </div>
          {data && <StateChip state={data.usageState} />}
        </CardTitle>
        {monthLabel && (
          <p className="text-[11px] text-muted-foreground mt-0.5">{monthLabel}</p>
        )}
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !data ? (
          <p className="text-xs text-muted-foreground">Kunne ikke hente forbrugsdata.</p>
        ) : (
          <>
            {data.budgetUsd !== null ? (
              <div className="space-y-2">
                <div className="flex justify-between items-end">
                  <span className="text-xs text-muted-foreground">Brugt</span>
                  <span className="text-xs font-mono text-foreground" data-testid="text-usage-percent">
                    {data.usagePercent}%
                  </span>
                </div>

                {/* Progress bar with soft-limit marker */}
                <div className="relative">
                  <Progress
                    value={Math.min(100, data.usagePercent)}
                    className={`h-1.5 bg-muted/40 ${progressColor(data.usageState)}`}
                    data-testid="progress-ai-budget"
                  />
                  {/* Soft limit threshold marker */}
                  <div
                    className="absolute top-0 h-1.5 w-px bg-orange-400/60"
                    style={{ left: `${softMarkerPct}%` }}
                    title={`Advarselstærskel: ${softMarkerPct}%`}
                    data-testid="marker-soft-limit"
                  />
                </div>

                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span data-testid="text-usage-used">{formatUsd(data.usedUsd)}</span>
                  <span data-testid="text-usage-budget">Budget: {formatUsd(data.budgetUsd)}</span>
                </div>

                {/* Soft limit warning */}
                {data.isSoftExceeded && !data.isHardExceeded && (
                  <div className="rounded-md border border-orange-500/25 bg-orange-500/8 px-2.5 py-2" data-testid="banner-soft-limit">
                    <p className="text-[11px] text-orange-400 flex items-center gap-1.5">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span>
                        Du nærmer dig budgetgrænsen ({data.usagePercent}% brugt).
                        AI-ydelserne fungerer, men afkort lange beskeder for at spare budget.
                      </span>
                    </p>
                  </div>
                )}

                {/* Hard limit block message */}
                {data.isHardExceeded && (
                  <div className="rounded-md border border-destructive/25 bg-destructive/8 px-2.5 py-2" data-testid="banner-hard-limit">
                    <p className="text-[11px] text-destructive flex items-center gap-1.5">
                      <XCircle className="w-3 h-3 shrink-0" />
                      <span>
                        AI-adgangen er blokeret for denne måned.
                        Kontakt din administrator for at øge budgettet.
                      </span>
                    </p>
                  </div>
                )}

                {/* Approaching limit hint (not yet in soft mode) */}
                {!data.isSoftExceeded && !data.isHardExceeded && data.remainingUsd !== null && data.usagePercent >= 65 && (
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1" data-testid="text-approaching-limit">
                    <AlertTriangle className="w-3 h-3 text-yellow-500" />
                    {formatUsd(data.remainingUsd)} tilbage dette modul.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Ingen budgetgrænse konfigureret</p>
                <p className="text-sm font-mono text-foreground" data-testid="text-usage-used-no-budget">
                  {formatUsd(data.usedUsd)} brugt i denne måned
                </p>
              </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-border/40">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <TrendingUp className="w-3 h-3" />
                <span data-testid="text-request-count">{data.requestCount} forespørgsler</span>
              </div>
              {periodEnd && (
                <span className="text-[11px] text-muted-foreground">
                  Nulstilles {periodEnd.toLocaleDateString("da-DK", { day: "numeric", month: "short" })}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
