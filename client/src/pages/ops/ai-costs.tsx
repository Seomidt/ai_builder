import { useState } from "react";
import { QUERY_POLICY } from "@/lib/query-policy";
import { useQuery } from "@tanstack/react-query";
import {
  DollarSign, TrendingUp, Receipt, Building2, Cpu,
  Calendar, ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ModelUsageRow {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCostUsd: string;
  customerRevUsd: string;
  marginUsd: string;
}

interface TenantUsageRow {
  tenantId: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: string;
  customerRevUsd: string;
  marginUsd: string;
}

interface DailySpendRow {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: string;
  customerRevUsd: string;
  marginUsd: string;
}

const USD_TO_DKK = 7.0;

function formatCost(val: string | number, currency: "USD" | "DKK"): string {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n) || n === 0) {
    return currency === "DKK" ? "0,00 kr" : "$0.00";
  }
  if (currency === "DKK") {
    const dkk = n * USD_TO_DKK;
    return `${dkk.toFixed(2).replace(".", ",")} kr`;
  }
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function pct(cost: string | number, rev: string | number): string {
  const c = typeof cost === "string" ? parseFloat(cost) : cost;
  const r = typeof rev === "string" ? parseFloat(rev) : rev;
  if (!c || c === 0) return "—";
  return `${(((r - c) / c) * 100).toFixed(0)}%`;
}

function marginColor(val: string | number): string {
  const m = typeof val === "string" ? parseFloat(val) : val;
  if (m > 0) return "text-green-400";
  if (m < 0) return "text-destructive";
  return "text-muted-foreground";
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function OpsAiCosts() {
  const [days, setDays] = useState("30");
  const [currency, setCurrency] = useState<"USD" | "DKK">("DKK");

  const fromDate = new Date(Date.now() - parseInt(days) * 86400000).toISOString().slice(0, 10);
  const dateParams = `from=${fromDate}`;

  const { data: modelsRaw, isLoading: modelsLoading } = useQuery<{ data: ModelUsageRow[] }>({
    queryKey: [`/api/admin/ai/usage/models?${dateParams}`],
    ...QUERY_POLICY.opsSnapshot,
  });

  const { data: tenantsRaw, isLoading: tenantsLoading } = useQuery<{ data: TenantUsageRow[] }>({
    queryKey: [`/api/admin/ai/usage/tenants?${dateParams}`],
    ...QUERY_POLICY.opsSnapshot,
  });

  const { data: dailyRaw, isLoading: dailyLoading } = useQuery<{ data: DailySpendRow[] }>({
    queryKey: [`/api/admin/ai/usage/daily?days=${days}&${dateParams}`],
    ...QUERY_POLICY.opsSnapshot,
  });

  const models: ModelUsageRow[] = modelsRaw?.data ?? [];
  const tenants: TenantUsageRow[] = tenantsRaw?.data ?? [];
  const daily: DailySpendRow[] = dailyRaw?.data ?? [];

  const totals = models.reduce(
    (acc, m) => ({
      cost: acc.cost + parseFloat(m.providerCostUsd),
      rev: acc.rev + parseFloat(m.customerRevUsd),
      margin: acc.margin + parseFloat(m.marginUsd),
      calls: acc.calls + m.calls,
      tokens: acc.tokens + m.totalTokens,
    }),
    { cost: 0, rev: 0, margin: 0, calls: 0, tokens: 0 },
  );

  const tenantAgg = tenants.reduce<
    Record<string, { cost: number; rev: number; margin: number; calls: number }>
  >((acc, t) => {
    if (!acc[t.tenantId]) acc[t.tenantId] = { cost: 0, rev: 0, margin: 0, calls: 0 };
    acc[t.tenantId].cost += parseFloat(t.providerCostUsd);
    acc[t.tenantId].rev += parseFloat(t.customerRevUsd);
    acc[t.tenantId].margin += parseFloat(t.marginUsd);
    acc[t.tenantId].calls += t.calls;
    return acc;
  }, {});

  const tenantList = Object.entries(tenantAgg)
    .map(([id, v]) => ({ tenantId: id, ...v }))
    .sort((a, b) => b.rev - a.rev);

  const markupMultiplier = totals.cost > 0 ? (totals.rev / totals.cost) : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-ai-costs-page">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.20)" }}
            >
              <Receipt className="w-4 h-4 text-green-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ai-costs-title">
              AI Cost Tracking
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Platform cost, customer markup, and profit per tenant
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-[100px] h-8 text-xs" data-testid="select-period">
              <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 dage</SelectItem>
              <SelectItem value="14">14 dage</SelectItem>
              <SelectItem value="30">30 dage</SelectItem>
              <SelectItem value="90">90 dage</SelectItem>
            </SelectContent>
          </Select>

          <Select value={currency} onValueChange={(v) => setCurrency(v as "USD" | "DKK")}>
            <SelectTrigger className="w-[80px] h-8 text-xs" data-testid="select-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="DKK">DKK</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {modelsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[78px]" />)
        ) : (
          <>
            <Card className="bg-card border-card-border" data-testid="cost-card-platform">
              <CardContent className="flex items-center gap-4 pt-5 pb-5">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-blue-500/12 text-blue-400 shrink-0">
                  <DollarSign className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xl font-bold text-foreground tabular-nums">
                    {formatCost(totals.cost, currency)}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">Platform Cost</p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border" data-testid="cost-card-customer">
              <CardContent className="flex items-center gap-4 pt-5 pb-5">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-secondary/12 text-secondary shrink-0">
                  <Receipt className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xl font-bold text-foreground tabular-nums">
                    {formatCost(totals.rev, currency)}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">
                    Customer Revenue{markupMultiplier > 0 ? ` (${markupMultiplier.toFixed(1)}×)` : ""}
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border" data-testid="cost-card-profit">
              <CardContent className="flex items-center gap-4 pt-5 pb-5">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-green-500/12 text-green-400 shrink-0">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <p className={`text-xl font-bold tabular-nums ${marginColor(totals.margin)}`}>
                    {formatCost(totals.margin, currency)}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">Margin</p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border" data-testid="cost-card-requests">
              <CardContent className="flex items-center gap-4 pt-5 pb-5">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/12 text-primary shrink-0">
                  <Building2 className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xl font-bold text-foreground tabular-nums">
                    {totals.calls.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">
                    Total Calls · {formatNum(totals.tokens)} tokens
                  </p>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Per-model breakdown */}
        <Card className="bg-card border-card-border" data-testid="model-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary" /> Cost per Model
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {modelsLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : models.length ? (
              <div data-testid="model-usage-list">
                {models.map((m, i) => (
                  <div
                    key={`${m.provider}-${m.model}`}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`model-row-${i}`}
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <p className="text-sm font-medium text-foreground truncate">{m.model || "unknown"}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.provider || "—"} · {formatNum(m.calls)} calls · {formatNum(m.totalTokens)} tokens
                      </p>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5">
                      <p className="text-xs text-muted-foreground">Cost {formatCost(m.providerCostUsd, currency)}</p>
                      <p className="text-xs text-green-400">Rev {formatCost(m.customerRevUsd, currency)}</p>
                      <p className={`text-xs font-medium ${marginColor(m.marginUsd)}`}>
                        Margin {formatCost(m.marginUsd, currency)} ({pct(m.providerCostUsd, m.customerRevUsd)})
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-model-data">
                <Cpu className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No AI usage data yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Per-tenant breakdown */}
        <Card className="bg-card border-card-border" data-testid="tenant-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" /> Revenue per Tenant
              {!tenantsLoading && (
                <Badge variant="outline" className="ml-auto text-xs">{tenantList.length} tenants</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {tenantsLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : tenantList.length ? (
              <div data-testid="tenant-usage-list">
                {tenantList.slice(0, 10).map((t, i) => (
                  <div
                    key={t.tenantId}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`tenant-row-${i}`}
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <p className="text-xs font-mono text-muted-foreground truncate">{t.tenantId.slice(0, 16)}…</p>
                      <p className="text-xs text-muted-foreground">{formatNum(t.calls)} calls</p>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5">
                      <p className="text-xs text-muted-foreground">Cost {formatCost(t.cost, currency)}</p>
                      <p className="text-xs text-green-400">Rev {formatCost(t.rev, currency)}</p>
                      <p className={`text-xs font-medium ${marginColor(t.margin)}`}>
                        {formatCost(t.margin, currency)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-tenant-data">
                <Building2 className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No tenant usage data</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Daily spend table */}
      <Card className="bg-card border-card-border" data-testid="daily-spend-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" /> Daily Spend (last {days} days)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {dailyLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
            </div>
          ) : daily.length ? (
            <div className="overflow-x-auto" data-testid="daily-spend-list">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-right px-4 py-2 font-medium">Calls</th>
                    <th className="text-right px-4 py-2 font-medium">Tokens</th>
                    <th className="text-right px-4 py-2 font-medium">Cost</th>
                    <th className="text-right px-4 py-2 font-medium">Revenue</th>
                    <th className="text-right px-4 py-2 font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((d, i) => {
                    const m = parseFloat(d.marginUsd);
                    return (
                      <tr
                        key={d.day}
                        className="border-b border-border last:border-0 hover:bg-muted/30"
                        data-testid={`daily-row-${i}`}
                      >
                        <td className="px-4 py-2 text-foreground font-mono">{d.day}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatNum(d.calls)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {formatNum(d.inputTokens + d.outputTokens)}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {formatCost(d.providerCostUsd, currency)}
                        </td>
                        <td className="px-4 py-2 text-right text-green-400">
                          {formatCost(d.customerRevUsd, currency)}
                        </td>
                        <td className={`px-4 py-2 text-right font-medium ${marginColor(d.marginUsd)}`}>
                          <span className="inline-flex items-center gap-0.5">
                            {m > 0 ? <ArrowUpRight className="w-3 h-3" /> :
                             m < 0 ? <ArrowDownRight className="w-3 h-3" /> :
                             <Minus className="w-3 h-3" />}
                            {formatCost(d.marginUsd, currency)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-daily-data">
              <Calendar className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No daily spend data for this period</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
