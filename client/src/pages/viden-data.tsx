/**
 * Viden & Data — Storage list page
 * Lists tenant knowledge bases (data sources).
 * Backed by /api/kb
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus, Database, MoreHorizontal, FileText, Archive, ChevronRight,
  BookOpen, AlertCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { usePagePerf } from "@/lib/perf";

interface KnowledgeBaseRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

const createSchema = z.object({
  name: z.string().min(1, "Navn er påkrævet"),
  slug: z
    .string()
    .min(1, "Slug er påkrævet")
    .regex(/^[a-z0-9-]+$/, "Kun små bogstaver, tal og bindestreger"),
  description: z.string().optional(),
});

type CreateValues = z.infer<typeof createSchema>;

function genSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[æ]/g, "ae")
    .replace(/[ø]/g, "oe")
    .replace(/[å]/g, "aa")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function SourceCard({
  source,
  onOpen,
  onArchive,
}: {
  source: KnowledgeBaseRow;
  onOpen: () => void;
  onArchive: () => void;
}) {
  return (
    <Card
      data-testid={`datasource-card-${source.id}`}
      className="group bg-card border-border hover:border-primary/30 transition-all duration-200 cursor-pointer relative overflow-hidden"
      onClick={onOpen}
    >
      <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full bg-amber-500/40" />
      <CardContent className="pt-4 pb-4 pl-5 pr-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md shrink-0"
              style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)" }}>
              <Database className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{source.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{source.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge variant="outline" className="text-xs text-green-400 border-green-500/30 bg-green-500/10">
              Aktiv
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  data-testid={`datasource-menu-${source.id}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => { e.stopPropagation(); onArchive(); }}
                  data-testid={`archive-datasource-${source.id}`}
                >
                  <Archive className="w-3.5 h-3.5 mr-2" /> Arkivér
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {source.description && (
          <p className="text-xs text-muted-foreground mt-3 line-clamp-2">{source.description}</p>
        )}

        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileText className="w-3 h-3" />
            <span>{source.assetCount} {source.assetCount === 1 ? "fil" : "filer"}</span>
          </div>
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground/60 group-hover:text-primary transition-colors">
            Åbn <ChevronRight className="w-3 h-3" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VidenData() {
  usePagePerf("viden-data");
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();

  const { data: sources, isLoading, isError } = useQuery<KnowledgeBaseRow[]>({
    queryKey: ["/api/kb"],
    ...QUERY_POLICY.staticList,
  });

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", slug: "", description: "" },
  });

  const watchedName = form.watch("name");
  useEffect(() => {
    if (!watchedName) return;
    form.setValue("slug", genSlug(watchedName), { shouldValidate: false });
  }, [watchedName]);

  const createMutation = useMutation({
    mutationFn: (values: CreateValues) => apiRequest("POST", "/api/kb", values),
    onSuccess: () => {
      toast({ title: "Datakilde oprettet" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setShowCreate(false);
      form.reset();
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/kb/${id}/archive`, {}),
    onSuccess: () => {
      toast({ title: "Datakilde arkiveret" });
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-viden-data">
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
        <Button
          onClick={() => setShowCreate(true)}
          data-testid="button-add-datasource"
          className="shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Ny datakilde
        </Button>
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
      ) : !sources?.length ? (
        <div className="text-center py-20 space-y-4">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)" }}
          >
            <Database className="w-7 h-7 text-amber-400/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">Ingen datakilder endnu</p>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              Opret din første datakilde — upload dokumenter, billeder og video til AI eksperterne.
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} data-testid="button-empty-add-datasource">
            <Plus className="w-4 h-4 mr-1.5" />
            Ny datakilde
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sources.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              onOpen={() => navigate(`/storage/${s.id}`)}
              onArchive={() => archiveMutation.mutate(s.id)}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-4 h-4 text-amber-400" />
              Opret datakilde
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((v) => createMutation.mutate(v))}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Navn</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="f.eks. Forsikringsvilkår 2024"
                        data-testid="input-datasource-name"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="forsikringsvilkaar-2024"
                        className="font-mono text-sm"
                        data-testid="input-datasource-slug"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Beskrivelse (valgfri)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Hvad indeholder denne datakilde?"
                        rows={3}
                        data-testid="input-datasource-description"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => { setShowCreate(false); form.reset(); }}
                >
                  Annuller
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending}
                  data-testid="button-submit-add-datasource"
                >
                  {createMutation.isPending ? "Opretter..." : "Opret datakilde"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
