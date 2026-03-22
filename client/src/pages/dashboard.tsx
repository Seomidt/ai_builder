import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { QUERY_POLICY } from "@/lib/query-policy";
import { FolderKanban, PlayCircle, Cpu, Plug, Plus, ArrowRight, Building2, Zap } from "lucide-react";
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
      <CardContent className="flex items-center gap-4 pt-5 pb-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${accentClass} shrink-0`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-card-foreground tabular-nums" data-testid={`stat-${label.toLowerCase().replace(/\s/g, "-")}`}>
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
    <div className="p-6 md:p-8 space-y-7 max-w-6xl">

      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/12 shrink-0" style={{ boxShadow: "0 0 12px rgba(34,211,238,0.15)" }}>
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="dashboard-title">
            Dashboard
          </h1>
        </div>
        {isLoading ? (
          <Skeleton className="h-4 w-44 ml-10" />
        ) : (
          <p className="text-sm text-muted-foreground ml-10 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 shrink-0" />
            {data?.orgName ?? "AI Builder Platform"}
          </p>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[78px]" />)
        ) : (
          <>
            <StatCard
              label="Total Projects"
              value={data?.projectCount ?? 0}
              icon={FolderKanban}
              accentClass="bg-primary/12 text-primary"
              barClass="bg-primary"
            />
            <StatCard
              label="Active Runs"
              value={data?.activeRunCount ?? 0}
              icon={PlayCircle}
              accentClass="bg-green-500/12 text-green-400"
              barClass="bg-green-500"
            />
            <StatCard
              label="Architectures"
              value={data?.architectureCount ?? 0}
              icon={Cpu}
              accentClass="bg-secondary/12 text-secondary"
              barClass="bg-secondary"
            />
            <StatCard
              label="Integrations"
              value={`${data?.configuredIntegrationCount ?? 0}/5`}
              icon={Plug}
              accentClass="bg-purple-500/12 text-purple-400"
              barClass="bg-purple-500"
            />
          </>
        )}
      </div>

      {/* Recent lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Recent Projects */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3 pt-5">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <FolderKanban className="w-3.5 h-3.5 text-primary" />
              Recent Projects
            </CardTitle>
            <Link
              href="/projects"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity font-medium"
              data-testid="link-all-projects"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5 pb-5">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentProjects?.length ? (
              <div className="text-center py-8">
                <FolderKanban className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No projects yet</p>
                <Link href="/projects">
                  <Button size="sm" variant="outline" className="mt-3" data-testid="btn-create-first-project">
                    <Plus className="w-3 h-3 mr-1" /> Create project
                  </Button>
                </Link>
              </div>
            ) : (
              data.recentProjects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`}>
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

        {/* Recent Runs */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3 pt-5">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <PlayCircle className="w-3.5 h-3.5 text-primary" />
              Recent Runs
            </CardTitle>
            <Link
              href="/runs"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity font-medium"
              data-testid="link-all-runs"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5 pb-5">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentRuns?.length ? (
              <div className="text-center py-8">
                <PlayCircle className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No runs yet</p>
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

      {/* Quick Actions */}
      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3 pt-5">
          <CardTitle className="text-sm font-semibold text-card-foreground">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pb-5">
          <Link href="/projects">
            <Button size="sm" data-testid="btn-new-project">
              <Plus className="w-3.5 h-3.5" /> New Project
            </Button>
          </Link>
          <Link href="/architectures">
            <Button size="sm" variant="outline" data-testid="btn-new-architecture">
              <Plus className="w-3.5 h-3.5" /> New Architecture
            </Button>
          </Link>
          <Link href="/runs">
            <Button size="sm" variant="outline" data-testid="btn-new-run">
              <Plus className="w-3.5 h-3.5" /> New Run
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
