import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { FolderKanban, PlayCircle, Cpu, Plug, Plus, ArrowRight, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label, value, icon: Icon, color,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <Card className="bg-card border-card-border">
      <CardContent className="flex items-center gap-4 pt-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p
            className="text-2xl font-bold text-card-foreground"
            data-testid={`stat-${label.toLowerCase().replace(/\s/g, "-")}`}
          >
            {value}
          </p>
          <p className="text-xs text-muted-foreground">{label}</p>
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

// ─── Dashboard ────────────────────────────────────────────────────────────────
// Critical path: ONE direct Supabase RPC — no server hop → ~50-120ms.
// Client calls supabase.rpc("get_dashboard_summary") with user JWT.
// RLS + SECURITY INVOKER derives org from auth.uid() — no tenant_id from client.
// Quick Actions section renders immediately with zero query dependency.
// Governance / analytics / heavy data is NOT loaded here — deferred to own pages.

export default function Dashboard() {
  const { data, isLoading } = useQuery<BootstrapData>({
    queryKey: ["dashboard-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_dashboard_summary");
      if (error) throw new Error(error.message);
      return data as BootstrapData;
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">

      {/* Header — renders before bootstrap resolves */}
      <div>
        <h1 className="text-xl font-semibold text-foreground" data-testid="dashboard-title">
          Dashboard
        </h1>
        {isLoading ? (
          <Skeleton className="h-4 w-44 mt-1" />
        ) : (
          <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5" />
            {data?.orgName ?? "AI Builder Platform"}
          </p>
        )}
      </div>

      {/* ── LEVEL 1: Stat cards — all 4 appear together once bootstrap resolves */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        ) : (
          <>
            <StatCard
              label="Total Projects"
              value={data?.projectCount ?? 0}
              icon={FolderKanban}
              color="bg-primary/15 text-primary"
            />
            <StatCard
              label="Active Runs"
              value={data?.activeRunCount ?? 0}
              icon={PlayCircle}
              color="bg-green-500/15 text-green-400"
            />
            <StatCard
              label="Architectures"
              value={data?.architectureCount ?? 0}
              icon={Cpu}
              color="bg-secondary/15 text-secondary"
            />
            <StatCard
              label="Integrations"
              value={`${data?.configuredIntegrationCount ?? 0}/5`}
              icon={Plug}
              color="bg-purple-500/15 text-purple-400"
            />
          </>
        )}
      </div>

      {/* ── LEVEL 1: Recent lists — from the same bootstrap payload */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Recent Projects */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Recent Projects
            </CardTitle>
            <Link
              href="/projects"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
              data-testid="link-all-projects"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentProjects?.length ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No projects yet</p>
                <Link href="/projects">
                  <Button size="sm" variant="outline" className="mt-2" data-testid="btn-create-first-project">
                    <Plus className="w-3 h-3 mr-1" /> Create project
                  </Button>
                </Link>
              </div>
            ) : (
              data.recentProjects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`}>
                  <div
                    data-testid={`project-row-${p.id}`}
                    className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 ml-2 text-xs capitalize border border-border"
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
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Recent Runs
            </CardTitle>
            <Link
              href="/runs"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
              data-testid="link-all-runs"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              <SkeletonRows count={3} />
            ) : !data?.recentRuns?.length ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No runs yet</p>
              </div>
            ) : (
              data.recentRuns.map((r) => (
                <div
                  key={r.id}
                  data-testid={`run-row-${r.id}`}
                  className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-foreground truncate">
                      {r.id.slice(0, 8)}…
                    </p>
                    <p className="text-xs text-muted-foreground">
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

      {/* Quick Actions — static, no query needed, always renders instantly */}
      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-card-foreground">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/projects">
            <Button size="sm" data-testid="btn-new-project">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Project
            </Button>
          </Link>
          <Link href="/architectures">
            <Button size="sm" variant="outline" data-testid="btn-new-architecture">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Architecture
            </Button>
          </Link>
          <Link href="/runs">
            <Button size="sm" variant="outline" data-testid="btn-new-run">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Run
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
