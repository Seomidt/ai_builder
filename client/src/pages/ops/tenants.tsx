import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search, ChevronRight, ChevronLeft, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";

interface TenantItem {
  organizationId: string;
  name?: string;
  plan?: string;
  status?: string;
  userCount?: number;
  projectCount?: number;
}

interface TenantsResponse {
  tenants: TenantItem[];
  pagination: { limit: number; hasMore: boolean };
  retrievedAt: string;
}

const PAGE_SIZE = 20;

function statusColor(status: string = "active") {
  return status === "active"
    ? "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-muted text-muted-foreground border-border";
}

export default function OpsTenants() {
  const [search,  setSearch]  = useState("");
  const [cursor,  setCursor]  = useState<string | undefined>(undefined);
  const [stack,   setStack]   = useState<(string | undefined)[]>([]);

  const queryKey = search
    ? [`/api/admin/platform/tenants?q=${encodeURIComponent(search)}`]
    : cursor
    ? [`/api/admin/platform/tenants?cursor=${cursor}`]
    : ["/api/admin/platform/tenants"];

  const { data, isLoading } = useQuery<TenantsResponse>({ queryKey });

  const tenants  = Array.isArray(data?.tenants) ? data!.tenants : [];
  const hasMore  = data?.pagination.hasMore ?? false;

  const nextPage = () => {
    if (!hasMore || !tenants.length) return;
    const lastId = tenants[tenants.length - 1]?.organizationId;
    if (lastId) { setStack((s) => [...s, cursor]); setCursor(lastId); }
  };
  const prevPage = () => {
    const s = [...stack]; const prev = s.pop();
    setStack(s); setCursor(prev);
  };

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-5 h-5 text-destructive" /> Tenant Inspector
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Platform-wide tenant overview, configuration, and usage
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search tenants by name or ID…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCursor(undefined); setStack([]); }}
            className="pl-9"
            data-testid="input-tenant-search"
          />
        </div>

        {/* Tenants Table */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-destructive" />
                Tenants ({tenants.length})
              </span>
              <span className="text-xs font-normal text-muted-foreground">Page {stack.length + 1}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : tenants.length > 0 ? (
              <div data-testid="ops-tenants-list">
                {tenants.map((t) => (
                  <div
                    key={t.organizationId}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 hover:bg-muted/20"
                    data-testid={`ops-tenant-row-${t.organizationId}`}
                  >
                    <div>
                      <p className="text-sm font-medium" data-testid={`ops-tenant-name-${t.organizationId}`}>
                        {t.name ?? t.organizationId}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">{t.organizationId}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {t.plan && (
                        <span className="text-xs text-muted-foreground capitalize">{t.plan}</span>
                      )}
                      {t.userCount != null && (
                        <span className="text-xs text-muted-foreground">{t.userCount} users</span>
                      )}
                      <Badge variant="outline" className={`text-xs ${statusColor(t.status ?? "active")}`}
                        data-testid={`ops-tenant-status-${t.organizationId}`}>
                        {t.status ?? "active"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <p className="text-sm text-muted-foreground" data-testid="ops-no-tenants-msg">
                  {search ? "No tenants match your search" : "No tenants registered"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        <div className="flex items-center justify-between" data-testid="ops-tenants-pagination">
          <Button variant="outline" size="sm" onClick={prevPage} disabled={stack.length === 0}
            className="gap-1.5" data-testid="button-tenants-prev">
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">{tenants.length} tenants shown</span>
          <Button variant="outline" size="sm" onClick={nextPage} disabled={!hasMore}
            className="gap-1.5" data-testid="button-tenants-next">
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
