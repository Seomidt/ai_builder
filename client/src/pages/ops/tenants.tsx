import { useQuery } from "@tanstack/react-query";
import { Users, Building2, Search, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useState } from "react";

interface Tenant {
  id: string;
  name?: string;
  slug?: string;
  plan?: string;
  status?: string;
  memberCount?: number;
  createdAt?: string;
}

function planColor(plan?: string) {
  if (!plan) return "bg-muted text-muted-foreground border-border";
  if (plan === "enterprise") return "bg-primary/15 text-primary border-primary/25";
  if (plan === "pro") return "bg-secondary/15 text-secondary border-secondary/25";
  return "bg-muted text-muted-foreground border-border";
}

export default function OpsTenants() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<{ tenants?: Tenant[]; total?: number }>({
    queryKey: ["/api/admin/tenants"],
  });

  const tenants: Tenant[] = Array.isArray(data) ? data : (data?.tenants ?? []);
  const filtered = tenants.filter((t) =>
    !search ||
    (t.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (t.slug ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6 max-w-6xl" data-testid="ops-tenants-page">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
            >
              <Building2 className="w-4 h-4 text-destructive" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-tenants-title">
              Tenant Management
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">All tenants on the platform</p>
        </div>
        <Badge variant="outline" className="text-xs shrink-0" data-testid="tenants-total-badge">
          <Users className="w-3 h-3 mr-1" />
          {isLoading ? "…" : tenants.length} tenants
        </Badge>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or slug…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-tenants-search"
        />
      </div>

      <Card className="bg-card border-card-border" data-testid="ops-tenants-table">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" /> Tenant List
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : filtered.length ? (
            <div data-testid="tenants-list">
              {filtered.map((t, i) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30"
                  data-testid={`tenant-row-${t.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground" data-testid={`tenant-name-${i}`}>{t.name ?? t.id}</p>
                    <p className="text-xs text-muted-foreground font-mono">{t.slug ?? t.id.slice(0, 12)}</p>
                  </div>
                  <div className="flex items-center gap-3 ml-4">
                    {t.memberCount != null && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Users className="w-3 h-3" /> {t.memberCount}
                      </span>
                    )}
                    <Badge variant="outline" className={`text-xs ${planColor(t.plan)}`} data-testid={`tenant-plan-${i}`}>
                      {t.plan ?? "free"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-tenants-msg">
              <Building2 className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {search ? "No tenants match your search" : "No tenants registered yet"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
