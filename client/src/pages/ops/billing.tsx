import { useQuery } from "@tanstack/react-query";
import { CreditCard, FileText, Package, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Plan {
  id?: string;
  name?: string;
  priceUsd?: number;
  features?: string[];
}

interface Invoice {
  id?: string;
  organizationId?: string;
  amountUsd?: number;
  status?: string;
  period?: string;
  createdAt?: string;
}

function invoiceStatusColor(s?: string) {
  if (s === "paid") return "bg-green-500/15 text-green-400 border-green-500/25";
  if (s === "pending") return "bg-secondary/15 text-secondary border-secondary/25";
  if (s === "overdue" || s === "failed") return "bg-destructive/15 text-destructive border-destructive/25";
  return "bg-muted text-muted-foreground border-border";
}

export default function OpsBilling() {
  const { data: plans, isLoading: plansLoading } = useQuery<Plan[]>({
    queryKey: ["/api/admin/plans"],
  });
  const { data: invoices, isLoading: invoicesLoading } = useQuery<Invoice[]>({
    queryKey: ["/api/admin/invoices"],
  });

  const planList: Plan[] = Array.isArray(plans) ? plans : [];
  const invoiceList: Invoice[] = Array.isArray(invoices) ? invoices : [];

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-billing-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.20)" }}
          >
            <CreditCard className="w-4 h-4 text-secondary" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-billing-title">Billing &amp; Subscriptions</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10">Platform plans, tenant subscriptions, and invoice management</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Plans */}
        <Card className="bg-card border-card-border" data-testid="ops-billing-plans-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Package className="w-4 h-4 text-primary" /> Available Plans
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {plansLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : planList.length ? (
              <div data-testid="billing-plans-list">
                {planList.map((p, i) => (
                  <div key={p.id ?? i} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`plan-row-${i}`}>
                    <div>
                      <p className="text-sm font-medium text-foreground" data-testid={`plan-name-${i}`}>{p.name ?? `Plan ${i + 1}`}</p>
                      {p.features?.length && (
                        <p className="text-xs text-muted-foreground">{p.features.slice(0, 2).join(", ")}</p>
                      )}
                    </div>
                    {p.priceUsd != null && (
                      <Badge variant="outline" className="text-xs" data-testid={`plan-price-${i}`}>
                        ${p.priceUsd}/mo
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-plans-msg">
                <Package className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No plans configured yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoices */}
        <Card className="bg-card border-card-border" data-testid="ops-billing-invoices-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" /> Recent Invoices
              {!invoicesLoading && <Badge variant="outline" className="ml-auto text-xs">{invoiceList.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {invoicesLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : invoiceList.length ? (
              <div data-testid="invoices-list">
                {invoiceList.slice(0, 10).map((inv, i) => (
                  <div key={inv.id ?? i} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`invoice-row-${i}`}>
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="text-xs font-mono text-muted-foreground truncate">{(inv.organizationId ?? "—").slice(0, 12)}</p>
                      <p className="text-xs text-foreground">{inv.period ?? "—"}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {inv.amountUsd != null && (
                        <span className="flex items-center gap-0.5 text-xs font-medium text-foreground">
                          <DollarSign className="w-3 h-3" />{inv.amountUsd.toFixed(2)}
                        </span>
                      )}
                      <Badge variant="outline" className={`text-xs ${invoiceStatusColor(inv.status)}`} data-testid={`invoice-status-${i}`}>
                        {inv.status ?? "unknown"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-invoices-msg">
                <FileText className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No invoices generated yet</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
