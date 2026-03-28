/**
 * Storage — /storage
 * Tenant data source list with search, filter, sort, edit, archive, reactivate.
 */

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus, Database, MoreHorizontal, FileText, Archive, ChevronRight,
  BookOpen, AlertCircle, Search, Brain, RefreshCw, Pencil,
  RotateCcw, SlidersHorizontal,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { usePagePerf } from "@/lib/perf";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeBaseRow {
  id:           string;
  name:         string;
  slug:         string;
  description:  string | null;
  status:       string;
  assetCount:   number;
  expertCount:  number;
  createdAt:    string;
  updatedAt:    string;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name:        z.string().min(1, "Navn er påkrævet"),
  slug:        z.string().min(1, "Slug er påkrævet").regex(/^[a-z0-9-]+$/, "Kun små bogstaver, tal og bindestreger"),
  description: z.string().optional(),
});
const editSchema = z.object({
  name:        z.string().min(1, "Navn er påkrævet"),
  description: z.string().optional(),
});
type CreateValues = z.infer<typeof createSchema>;
type EditValues   = z.infer<typeof editSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)   return "Lige nu";
  if (mins < 60)  return `${mins} min. siden`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} t. siden`;
  const days = Math.floor(hrs / 24);
  if (days < 30)  return `${days} d. siden`;
  return d.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
}

// ─── Source Card ──────────────────────────────────────────────────────────────

function SourceCard({
  source,
  onOpen,
  onEdit,
  onArchive,
  onReactivate,
}: {
  source:       KnowledgeBaseRow;
  onOpen:       () => void;
  onEdit:       () => void;
  onArchive:    () => void;
  onReactivate: () => void;
}) {
  const archived = source.status === "archived";

  return (
    <Card
      data-testid={`datasource-card-${source.id}`}
      className={`group border-border transition-all duration-200 relative overflow-hidden ${
        archived
          ? "opacity-60 bg-muted/20"
          : "bg-card hover:border-primary/30 cursor-pointer"
      }`}
      onClick={archived ? undefined : onOpen}
    >
      <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${archived ? "bg-muted-foreground/20" : "bg-amber-500/40"}`} />
      <CardContent className="pt-4 pb-4 pl-5 pr-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-md shrink-0"
              style={{
                background: archived ? "rgba(100,100,100,0.08)" : "rgba(245,158,11,0.10)",
                border:     archived ? "1px solid rgba(100,100,100,0.15)" : "1px solid rgba(245,158,11,0.18)",
              }}
            >
              <Database className={`w-4 h-4 ${archived ? "text-muted-foreground" : "text-amber-400"}`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{source.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{source.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {archived ? (
              <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/30">Arkiveret</Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-green-400 border-green-500/30 bg-green-500/10">Aktiv</Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  data-testid={`datasource-menu-${source.id}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!archived && (
                  <>
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpen(); }}>
                      <ChevronRight className="w-3.5 h-3.5 mr-2" /> Åbn
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
                      <Pencil className="w-3.5 h-3.5 mr-2" /> Rediger
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={(e) => { e.stopPropagation(); onArchive(); }}
                      data-testid={`archive-datasource-${source.id}`}
                    >
                      <Archive className="w-3.5 h-3.5 mr-2" /> Arkivér
                    </DropdownMenuItem>
                  </>
                )}
                {archived && (
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onReactivate(); }}>
                    <RotateCcw className="w-3.5 h-3.5 mr-2" /> Genaktivér
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {source.description && (
          <p className="text-xs text-muted-foreground mt-3 line-clamp-2">{source.description}</p>
        )}

        <div className="flex items-center justify-between mt-3 gap-2">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="w-3 h-3" />
              {source.assetCount} {source.assetCount === 1 ? "fil" : "filer"}
            </span>
            {source.expertCount > 0 && (
              <span className="flex items-center gap-1">
                <Brain className="w-3 h-3" />
                {source.expertCount} {source.expertCount === 1 ? "ekspert" : "eksperter"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground/50">{relativeDate(source.updatedAt)}</span>
            {!archived && (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground/60 group-hover:text-primary transition-colors">
                Åbn <ChevronRight className="w-3 h-3" />
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VidenData() {
  usePagePerf("viden-data");
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [showCreate, setShowCreate]   = useState(false);
  const [editTarget, setEditTarget]   = useState<KnowledgeBaseRow | null>(null);
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [sort, setSort]               = useState<"newest" | "name" | "files">("newest");
  const queryClient = useQueryClient();

  const { data: sources, isLoading, isError } = useQuery<KnowledgeBaseRow[]>({
    queryKey: ["/api/kb", { status: statusFilter }],
    queryFn: () =>
      fetch(`/api/kb?status=${statusFilter}`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.staticList,
  });

  // ── Create form ──────────────────────────────────────────────────────────────
  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", slug: "", description: "" },
  });
  const watchedName = createForm.watch("name");
  useEffect(() => {
    if (!watchedName) return;
    createForm.setValue("slug", genSlug(watchedName), { shouldValidate: false });
  }, [watchedName]);

  const createMutation = useMutation({
    mutationFn: (values: CreateValues) => apiRequest("POST", "/api/kb", values),
    onSuccess: () => {
      toast({ title: "Datakilde oprettet" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setShowCreate(false);
      createForm.reset();
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Edit form ────────────────────────────────────────────────────────────────
  const editForm = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: "", description: "" },
  });
  useEffect(() => {
    if (!editTarget) return;
    editForm.reset({ name: editTarget.name, description: editTarget.description ?? "" });
  }, [editTarget]);

  const editMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: EditValues }) =>
      apiRequest("PATCH", `/api/kb/${id}`, values),
    onSuccess: () => {
      toast({ title: "Datakilde opdateret" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setEditTarget(null);
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Archive ──────────────────────────────────────────────────────────────────
  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/kb/${id}/archive`, {}),
    onSuccess: () => {
      toast({ title: "Datakilde arkiveret" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Reactivate ───────────────────────────────────────────────────────────────
  const reactivateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/kb/${id}/reactivate`, {}),
    onSuccess: () => {
      toast({ title: "Datakilde genaktiveret" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Client-side filter + sort ────────────────────────────────────────────────
  const displayed = useMemo(() => {
    let list = sources ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (sort === "name")   return a.name.localeCompare(b.name, "da");
      if (sort === "files")  return b.assetCount - a.assetCount;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [sources, search, sort]);

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl" data-testid="page-viden-data">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)" }}
            >
              <BookOpen className="w-4 h-4 text-amber-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              Storage
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Upload dokumenter, billeder og video som AI eksperter arbejder ud fra.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="button-add-datasource" className="shrink-0">
          <Plus className="w-4 h-4 mr-1.5" />
          Ny datakilde
        </Button>
      </div>

      {/* Toolbar: search + filter + sort */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Søg på navn eller slug…"
            className="pl-8 h-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-datasources"
          />
        </div>
        <div className="flex gap-2 shrink-0">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="h-8 text-xs w-32" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Aktive</SelectItem>
              <SelectItem value="archived">Arkiverede</SelectItem>
              <SelectItem value="all">Alle</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as any)}>
            <SelectTrigger className="h-8 text-xs w-36" data-testid="select-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Senest opdateret</SelectItem>
              <SelectItem value="name">Navn A–Å</SelectItem>
              <SelectItem value="files">Flest filer</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
          <p className="text-sm text-destructive">Kunne ikke hente datakilder. Prøv igen.</p>
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-20 space-y-4">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)" }}
          >
            <Database className="w-7 h-7 text-amber-400/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">
              {search ? "Ingen resultater" : statusFilter === "archived" ? "Ingen arkiverede datakilder" : "Ingen datakilder endnu"}
            </p>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {search
                ? `Ingen datakilder matcher "${search}"`
                : "Opret din første datakilde — upload dokumenter, billeder og video til AI eksperterne."}
            </p>
          </div>
          {!search && statusFilter === "active" && (
            <Button onClick={() => setShowCreate(true)} data-testid="button-empty-add-datasource">
              <Plus className="w-4 h-4 mr-1.5" />
              Ny datakilde
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {displayed.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              onOpen={() => navigate(`/storage/${s.id}`)}
              onEdit={() => setEditTarget(s)}
              onArchive={() => archiveMutation.mutate(s.id)}
              onReactivate={() => reactivateMutation.mutate(s.id)}
            />
          ))}
        </div>
      )}

      {/* ── Create Dialog ──────────────────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-4 h-4 text-amber-400" />
              Opret datakilde
            </DialogTitle>
          </DialogHeader>
          <Form {...createForm}>
            <form onSubmit={createForm.handleSubmit((v) => createMutation.mutate(v))} className="space-y-4">
              <FormField control={createForm.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Navn</FormLabel>
                  <FormControl>
                    <Input placeholder="f.eks. Forsikringsvilkår 2024" data-testid="input-datasource-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={createForm.control} name="slug" render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input placeholder="forsikringsvilkaar-2024" className="font-mono text-sm" data-testid="input-datasource-slug" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={createForm.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Beskrivelse (valgfri)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Hvad indeholder denne datakilde?" rows={3} data-testid="input-datasource-description" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => { setShowCreate(false); createForm.reset(); }}>Annuller</Button>
                <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-add-datasource">
                  {createMutation.isPending ? "Opretter…" : "Opret datakilde"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ────────────────────────────────────────────────────────── */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4 text-amber-400" />
              Rediger datakilde
            </DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form
              onSubmit={editForm.handleSubmit((v) => editTarget && editMutation.mutate({ id: editTarget.id, values: v }))}
              className="space-y-4"
            >
              <FormField control={editForm.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Navn</FormLabel>
                  <FormControl>
                    <Input data-testid="input-edit-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Slug</p>
                <p className="text-sm font-mono bg-muted/40 rounded px-3 py-2 text-muted-foreground">
                  {editTarget?.slug}
                </p>
                <p className="text-xs text-muted-foreground">Slug kan ikke ændres efter oprettelse.</p>
              </div>
              <FormField control={editForm.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Beskrivelse</FormLabel>
                  <FormControl>
                    <Textarea rows={3} data-testid="input-edit-description" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditTarget(null)}>Annuller</Button>
                <Button type="submit" disabled={editMutation.isPending} data-testid="button-submit-edit">
                  {editMutation.isPending ? "Gemmer…" : "Gem ændringer"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
