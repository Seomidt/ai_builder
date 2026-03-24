import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { QUERY_POLICY } from "@/lib/query-policy";
import { Brain, BookOpen, PlayCircle, Plug, Plus, ArrowRight, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

interface BootstrapData {
  orgName: string;
  projectCount: number;
  activeRunCount: number;
  architectureCount: number;
  configuredIntegrationCount: number;
  recentRuns: Array<{ id: string; status: string; createdAt: string }>;
  recentProjects: Array<{ id: string; name: string; status: string; updatedAt: string }>;
}

type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

function StatCard({
  label, value, icon: Icon, accentClass, barClass,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  accentClass: string;
  barClass?: string;
}) {
  return (
    <Card className="bg-card border-card-border relative overflow-hidden transition-all duration-200 hover:border-primary/25 hover:-translate-y-0.5">
      {barClass && (
        <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${barClass}`} style={{ boxShadow: barClass.includes("primary") || barClass.includes("cyan") ? "0 0 8px rgba(34,211,238,0.5)" : barClass.includes("secondary") ? "0 0 8px rgba(245,158,11,0.5)" : "0 0 8px rgba(34,197,94,0.5)" }} />
      )}
      <CardContent className="flex items-center gap-3 pt-3 pb-3">
        <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${accentClass} shrink-0`}>
          <Icon className="w-4 h-4" />
        </div>
        <div>
          <p className="text-xl font-bold text-card-foreground tabular-nums" data-testid={`stat-${label.toLowerCase().replace(/\s/g, "-")}`}>
            {value}
          </p>
          <p className="text-xs text-muted-foreground font-medium mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function runStatusColor(status: RunStatus): string {
  const map: Record<RunStatus, string> = {
    pending:   "bg-secondary/15 text-secondary border-secondary/25",
    running:   "bg-primary/15 text-primary border-primary/25",
    completed: "bg-green-500/15 text-green-400 border-green-500/25",
    failed:    "bg-destructive/15 text-destructive border-destructive/25",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return map[status] ?? map.pending;
}

function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </>
  );
}

export default function Dashboard() {
  const { data, isLoading } = useQuery<BootstrapData>({
    queryKey: ["dashboard-summary"],
    queryFn: () => apiRequest("GET", "/api/dashboard").then((r) => r.json()),
    ...QUERY_POLICY.dashboard,
  });

  return (
    <div className="p-5 md:p-7 space-y-6 max-w-6xl">

      {/* Header */}
      <div className="space-y-0.5">
        <h1 className="text-lg font-semibold text-foreground tracking-tight" data-testid="dashboard-title">
          Dashboard
        </h1>
        {isLoading ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Building2 className="w-3 h-3 shrink-0" />
            {data?.orgName ?? "AI Builder Platform"}
          </p>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[62px]" />)
        ) : (
          <>
            <StatCard
              label="Datakilder"
              value={data?.projectCount ?? 0}
              icon={BookOpen}
              accentClass="bg-primary/12 text-primary"
              barClass="bg-primary"
            />
            <StatCard
              label="Aktive kørsler"
              value={data?.activeRunCount ?? 0}
              icon={PlayCircle}
              accentClass="bg-green-500/12 text-green-400"
              barClass="bg-green-500"
            />
            <StatCard
              label="AI Eksperter"
              value={data?.architectureCount ?? 0}
              icon={Brain}
              accentClass="bg-secondary/12 text-secondary"
              barClass="bg-secondary"
            />
            <StatCard
              label="Integrationer"
              value={`${data?.configuredIntegrationCount ?? 0}/5`}
              icon={Plug}
              accentClass="bg-purple-500/12 text-purple-400"
              barClass="bg-purple-500"
            />
          </>
        )}
      </div>

      {/* Recent lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Seneste datakilder */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3 pt-4">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <BookOpen className="w-3.5 h-3.5 text-primary" />
              Seneste datakilder
            </CardTitle>
            <Link
              href="/viden-data"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity font-medium"
              data-testid="link-all-projects"
            >
              Se alle <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5 pb-4">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentProjects?.length ? (
              <div className="text-center py-6">
                <BookOpen className="w-7 h-7 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mb-3">Ingen datakilder endnu</p>
                <Link href="/viden-data">
                  <Button size="sm" variant="outline" data-testid="btn-create-first-project">
                    <Plus className="w-3 h-3 mr-1" /> Tilføj datakilde
                  </Button>
                </Link>
              </div>
            ) : (
              data.recentProjects.map((p) => (
                <Link key={p.id} href={`/viden-data`}>
                  <div
                    data-testid={`project-row-${p.id}`}
                    className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-transparent hover:border-border/50 transition-all duration-150 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`shrink-0 ml-2 text-xs capitalize ${p.status === "active" ? "bg-green-500/10 text-green-400 border-green-500/25" : "border-border text-muted-foreground"}`}
                    >
                      {p.status}
                    </Badge>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* Seneste kørsler */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3 pt-4">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <PlayCircle className="w-3.5 h-3.5 text-primary" />
              Seneste kørsler
            </CardTitle>
            <Link
              href="/koerseler"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity font-medium"
              data-testid="link-all-runs"
            >
              Se alle <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5 pb-4">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentRuns?.length ? (
              <div className="text-center py-6">
                <PlayCircle className="w-7 h-7 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Ingen kørsler endnu</p>
              </div>
            ) : (
              data.recentRuns.map((r) => (
                <div
                  key={r.id}
                  data-testid={`run-row-${r.id}`}
                  className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-transparent hover:border-border/50 transition-all duration-150"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-foreground truncate">
                      {r.id.slice(0, 8)}…
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`shrink-0 ml-2 text-xs capitalize border ${runStatusColor(r.status as RunStatus)}`}
                  >
                    {r.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions — lightweight inline section */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium shrink-0">Hurtig adgang</p>
        <Link href="/viden-data">
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground" data-testid="btn-new-project">
            <Plus className="w-3 h-3 mr-1" /> Tilføj datakilde
          </Button>
        </Link>
        <Link href="/ai-eksperter">
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground" data-testid="btn-new-architecture">
            <Plus className="w-3 h-3 mr-1" /> Opret AI ekspert
          </Button>
        </Link>
        <Link href="/koerseler">
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground" data-testid="btn-new-run">
            <PlayCircle className="w-3 h-3 mr-1" /> Se kørsler
          </Button>
        </Link>
      </div>
    </div>
  );
}
