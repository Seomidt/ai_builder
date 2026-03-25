/**
 * AI Eksperter — Ekspert-liste
 *
 * Viser alle AI eksperter for tenant-organisationen.
 * "Opret ekspert" navigerer direkte til den strukturerede editor-side (ikke wizard).
 * Admin-only: opret, rediger, arkivér.
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus, Brain, MoreHorizontal, ArrowRight, Archive, Edit2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";
import { useAuth } from "@/hooks/use-auth";
import { usePagePerf } from "@/lib/perf";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpertRow {
  id:             string;
  name:           string;
  slug:           string;
  status:         string;
  description:    string | null;
  goal:           string | null;
  outputStyle:    string | null;
  departmentId:   string | null;
  draftVersionId: string | null;
  updatedAt:      string;
}

interface DeptRow { id: string; name: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdminRole(role?: string) {
  return role === "tenant_admin" || role === "platform_admin" || role === "owner";
}

// ─── Expert Card ──────────────────────────────────────────────────────────────

function ExpertCard({ expert, depts, isAdmin, onArchive }: {
  expert:   ExpertRow;
  depts:    DeptRow[];
  isAdmin:  boolean;
  onArchive: (id: string) => void;
}) {
  const [, navigate] = useLocation();
  const dept         = depts.find((d) => d.id === expert.departmentId);

  return (
    <Card
      data-testid={`expert-card-${expert.id}`}
      className="bg-card border-card-border hover:border-primary/30 transition-all duration-200 hover:-translate-y-0.5 relative overflow-hidden cursor-pointer"
      onClick={() => navigate(`/ai-eksperter/${expert.id}`)}
    >
      <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full bg-primary/40" />
      <CardContent className="pt-4 pb-4 pl-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 shrink-0">
              <Brain className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{expert.name}</p>
              {expert.goal && (
                <p className="text-xs text-muted-foreground/70 truncate">{expert.goal}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Badge variant="outline" className={`text-xs border ${
              expert.status === "active"   ? "text-green-400 border-green-500/30 bg-green-500/10" :
              expert.status === "paused"   ? "text-amber-400 border-amber-500/30 bg-amber-500/10" :
              expert.status === "draft"    ? "text-slate-400 border-slate-500/30" :
                                             "text-muted-foreground"
            }`}>
              {expert.status === "active"   ? "Aktiv" :
               expert.status === "paused"   ? "Pauset" :
               expert.status === "draft"    ? "Kladde" :
               expert.status === "archived" ? "Arkiveret" :
               expert.status}
            </Badge>
            {expert.draftVersionId && (
              <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/5">
                Kladde
              </Badge>
            )}
            {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    data-testid={`expert-menu-${expert.id}`}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => navigate(`/ai-eksperter/${expert.id}`)}
                    data-testid={`open-expert-${expert.id}`}
                  >
                    <Brain className="w-3.5 h-3.5 mr-2" />
                    Åbn ekspert
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => navigate(`/ai-eksperter/${expert.id}/rediger`)}
                    data-testid={`edit-expert-${expert.id}`}
                  >
                    <Edit2 className="w-3.5 h-3.5 mr-2" />
                    Rediger
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onArchive(expert.id)}
                    data-testid={`archive-expert-${expert.id}`}
                  >
                    <Archive className="w-3.5 h-3.5 mr-2" />
                    Arkivér
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {expert.description && (
          <p className="text-xs text-muted-foreground mt-2.5 line-clamp-2">{expert.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          {dept && (
            <Badge variant="outline" className="text-xs border-border/40 text-muted-foreground/60">
              {dept.name}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs border-muted/20 text-muted-foreground/40">
            AI runtime platform-styret
          </Badge>
        </div>

        <div className="flex items-center justify-between mt-2.5">
          <p className="text-xs text-muted-foreground/40">
            Opdateret {new Date(expert.updatedAt).toLocaleDateString("da-DK")}
          </p>
          <span className="text-xs text-primary/50 flex items-center gap-1">
            Åbn <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiEksperter() {
  usePagePerf("ai-eksperter");
  const { toast }    = useToast();
  const [, navigate] = useLocation();
  const { user }     = useAuth();
  const isAdmin      = isAdminRole(user?.role);

  const { data: experts, isLoading } = useQuery<ExpertRow[]>({
    queryKey: ["/api/experts"],
    ...QUERY_POLICY.staticList,
  });

  const { data: depts = [] } = useQuery<DeptRow[]>({
    queryKey: ["/api/tenant/departments"],
    ...QUERY_POLICY.staticList,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/experts/${id}/archive`, {}),
    onSuccess:  () => { toast({ title: "Ekspert arkiveret" }); invalidate.afterArchMutation(); },
    onError:    (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const active   = experts?.filter((e) => e.status !== "archived") ?? [];
  const archived = experts?.filter((e) => e.status === "archived") ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-ai-eksperter">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.18)" }}
            >
              <Brain className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              AI Eksperter
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Opret og administrér AI eksperter, der arbejder ud fra jeres egne data, regler og processer.
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => navigate("/ai-eksperter/opret")}
            data-testid="button-create-expert"
            className="shrink-0"
          >
            <Plus className="w-4 h-4 mr-1.5" />Ny ekspert
          </Button>
        )}
      </div>

      {/* Expert list */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : active.length === 0 ? (
        <div className="text-center py-20 space-y-4" data-testid="empty-state">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}
          >
            <Brain className="w-7 h-7 text-primary/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">Ingen AI eksperter endnu</p>
            <p className="text-sm text-muted-foreground">
              Opret din første ekspert — f.eks. en{" "}
              <span className="text-primary/80">Forsikringsspecialist</span>
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => navigate("/ai-eksperter/opret")} data-testid="button-empty-create-expert">
              <Plus className="w-4 h-4 mr-1.5" />Opret AI ekspert
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {active.map((e) => (
              <ExpertCard
                key={e.id}
                expert={e}
                depts={depts}
                isAdmin={isAdmin}
                onArchive={(id) => archiveMutation.mutate(id)}
              />
            ))}
          </div>
          {archived.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground/50 uppercase tracking-widest font-bold mb-3">
                Arkiverede
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 opacity-50">
                {archived.map((e) => (
                  <ExpertCard
                    key={e.id}
                    expert={e}
                    depts={depts}
                    isAdmin={isAdmin}
                    onArchive={() => {}}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
