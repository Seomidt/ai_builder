import { useState } from "react";
import { QUERY_POLICY } from "@/lib/query-policy";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  DollarSign, TrendingUp, Receipt, Building2, Percent,
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
import { Input } from "@/components/ui/input";

interface TenantCost {
  organizationId: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  platformCostUsd: number;
  customerCostUsd: number;
  profitUsd: number;
}

interface AiCostsResponse {
  period: string;
  markupMultiplier: number;
  summary: {
    totalPlatformCostUsd: number;
    totalCustomerCostUsd: number;
    totalProfitUsd: number;
    totalRequests: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
  };
  tenants: TenantCost[];
  retrievedAt: string;
}

const USD_TO_DKK = 7.0;

function formatCost(usd: number, currency: "USD" | "DKK") {
  if (currency === "DKK") {
    const dkk = usd * USD_TO_DKK;
    return `${dkk.toFixed(2)} kr`;
  }
  return `$${usd.toFixed(4)}`;
}

export default function OpsAiCosts() {
  const [period, setPeriod] = useState("30d");
  const [markup, setMarkup] = useState("2.5");
  const [currency, setCurrency] = useState<"USD" | "DKK">("DKK");

  const markupNum = parseFloat(markup) || 2.5;

  const { data, isLoading } = useQuery<AiCostsResponse>({
    queryKey: ["/api/admin/ai-costs", period, markupNum],
    ...QUERY_POLICY.opsSnapshot,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/ai-costs?period=${period}&markup=${markupNum}`);
      return res.json();
    },
  });

  const summary = data?.summary;
  const tenants = data?.tenants ?? [];

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
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[100px] h-8 text-xs" data-testid="select-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">7 dage</SelectItem>
              <SelectItem value="30d">30 dage</SelectItem>
              <SelectItem value="90d">90 dage</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5">
            <Percent className="w-3.5 h-3.5 text-muted-foreground" />
            <Input
              type="number"
              step="0.1"
              min="1"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              className="w-[70px] h-8 text-xs"
              data-testid="input-markup"
            />
            <span className="text-xs text-muted-foreground">×</span>
          </div>

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
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
                    {formatCost(summary?.totalPlatformCostUsd ?? 0, currency)}
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
                    {formatCost(summary?.totalCustomerCostUsd ?? 0, currency)}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">
                    Customer Price ({markupNum}×)
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
                  <p className="text-xl font-bold text-foreground tabular-nums">
                    {formatCost(summary?.totalProfitUsd ?? 0, currency)}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">Profit</p>
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
                    {(summary?.totalRequests ?? 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">Total Requests</p>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Card className="bg-card border-card-border" data-testid="tenant-costs-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" /> Per Tenant Breakdown
            {!isLoading && <Badge variant="outline" className="ml-auto text-xs">{tenants.length} tenants</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : tenants.length ? (
            <div className="overflow-x-auto" data-testid="tenant-costs-table">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Tenant</th>
                    <th className="text-right px-4 py-2.5 font-medium">Requests</th>
                    <th className="text-right px-4 py-2.5 font-medium">Platform Cost</th>
                    <th className="text-right px-4 py-2.5 font-medium">Customer Price</th>
                    <th className="text-right px-4 py-2.5 font-medium">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t, i) => (
                    <tr
                      key={t.organizationId}
                      className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                      data-testid={`tenant-cost-row-${i}`}
                    >
                      <td className="px-4 py-3 font-mono text-muted-foreground truncate max-w-[160px]">
                        {t.organizationId.slice(0, 16)}…
                      </td>
                      <td className="px-4 py-3 text-right text-foreground tabular-nums">
                        {t.requestCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-foreground tabular-nums">
                        {formatCost(t.platformCostUsd, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-foreground tabular-nums font-medium">
                        {formatCost(t.customerCostUsd, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-green-400 tabular-nums font-medium">
                        {formatCost(t.profitUsd, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-tenant-costs-msg">
              <DollarSign className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No AI usage recorded in this period</p>
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground/40">
          <span>
            Pricing: {formatCost(summary?.costPer1kInputTokens ?? 0, "USD")}/1K input,{" "}
            {formatCost(summary?.costPer1kOutputTokens ?? 0, "USD")}/1K output × {markupNum} markup
          </span>
          <span data-testid="costs-retrieved-at">
            Retrieved {new Date(data.retrievedAt).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
