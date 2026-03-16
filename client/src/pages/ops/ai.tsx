import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, DollarSign, TrendingUp, ShieldAlert, BarChart2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";

interface AiResponse {
  governance: {
    healthy?: boolean;
    totalBudgets?: number;
    activePolicies?: number;
    runawayEvents?: number;
  };
  usageByTenant: {
    tenant_id: string;
    requests: number;
    cost_usd: number;
    total_tokens: number;
  }[];
  budgets: {
    tenant_id: string;
    monthly_budget_usd: string | number;
    soft_limit_percent: number;
    hard_limit_percent: number;
  }[];
  retrievedAt: string;
}

function utilizationColor(pct: number) {
  return pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-secondary" : "bg-primary";
}

export default function OpsAi() {
  const { data, isLoading } = useQuery<AiResponse>({
    queryKey: ["/api/admin/platform/ai"],
  });

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-destructive" /> AI Governance Monitor
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Token usage, budget consumption, and governance health across all tenants
          </p>
        </div>

        {/* Governance Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Healthy", value: data?.governance?.healthy ? "Yes" : "No", testId: "healthy" },
                { label: "Budgets Active", value: data?.governance?.totalBudgets ?? "—", testId: "budgets" },
                { label: "AI Policies",   value: data?.governance?.activePolicies ?? "—", testId: "policies" },
                { label: "Runaway Events", value: data?.governance?.runawayEvents ?? "—", testId: "runaway" },
              ].map(({ label, value, testId }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-ai-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <p className="text-xs text-muted-foreground mb-1">{label}</p>
                    <p className="text-2xl font-bold" data-testid={`ops-ai-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Usage by Tenant */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-destructive" /> AI Usage by Tenant (30 days)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : data?.usageByTenant?.length ? (
              <div data-testid="ops-ai-usage-list">
                {data.usageByTenant.map((u) => (
                  <div key={u.tenant_id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-ai-usage-${u.tenant_id}`}>
                    <div>
                      <p className="text-sm font-mono text-foreground">{u.tenant_id}</p>
                      <p className="text-xs text-muted-foreground">{u.total_tokens.toLocaleString()} tokens</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-sm font-medium">${u.cost_usd.toFixed(4)}</p>
                        <p className="text-xs text-muted-foreground">{u.requests} reqs</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <p className="text-sm text-muted-foreground" data-testid="ops-no-ai-usage-msg">No AI usage recorded in the last 30 days</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Budget Consumption */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-destructive" /> Budget Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : data?.budgets?.length ? (
              <div data-testid="ops-ai-budgets-list">
                {data.budgets.map((b) => (
                  <div key={b.tenant_id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-ai-budget-${b.tenant_id}`}>
                    <p className="text-sm font-mono">{b.tenant_id}</p>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">${Number(b.monthly_budget_usd).toFixed(2)}/mo</span>
                      <Badge variant="outline" className="text-xs bg-muted text-muted-foreground border-border">
                        soft {b.soft_limit_percent}%
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <p className="text-sm text-muted-foreground" data-testid="ops-no-ai-budgets-msg">No budgets configured</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
