/**
 * Viden & Data — Tenant Product Page
 *
 * Upload and manage knowledge/data sources used by AI experts.
 * Backed by projects in the database.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, BookOpen, MoreHorizontal, FileText, Archive } from "lucide-react";
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
import { invalidate } from "@/lib/invalidations";
import { usePagePerf } from "@/lib/perf";

interface DataSourceRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  createdAt: string;
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

function DataSourceCard({
  source,
  onArchive,
}: {
  source: DataSourceRow;
  onArchive: (id: string) => void;
}) {
  return (
    <Card
      data-testid={`datasource-card-${source.id}`}
      className="bg-card border-card-border hover:border-primary/30 transition-all duration-200 hover:-translate-y-0.5 relative overflow-hidden"
    >
      <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full bg-secondary/40" />
      <CardContent className="pt-4 pb-4 pl-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-secondary/10 shrink-0">
              <FileText className="w-4 h-4 text-secondary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{source.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{source.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="outline"
              className={`text-xs border capitalize ${
                source.status === "active"
                  ? "text-green-400 border-green-500/30 bg-green-500/10"
                  : "text-muted-foreground"
              }`}
            >
              {source.status === "active" ? "Aktiv" : source.status}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  data-testid={`datasource-menu-${source.id}`}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onArchive(source.id)}
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
        <p className="text-xs text-muted-foreground/40 mt-3">
          Tilføjet {new Date(source.createdAt).toLocaleDateString("da-DK")}
        </p>
      </CardContent>
    </Card>
  );
}

export default function VidenData() {
  usePagePerf("viden-data");
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data: sources, isLoading } = useQuery<DataSourceRow[]>({
    queryKey: ["/api/projects"],
    ...QUERY_POLICY.list,
  });

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", slug: "", description: "" },
  });

  const watchedName = form.watch("name");
  useEffect(() => {
    if (!watchedName) return;
    const slug = watchedName
      .toLowerCase()
      .replace(/[æ]/g, "ae")
      .replace(/[ø]/g, "oe")
      .replace(/[å]/g, "aa")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    form.setValue("slug", slug, { shouldValidate: false });
  }, [watchedName]);

  const createMutation = useMutation({
    mutationFn: (values: CreateValues) => apiRequest("POST", "/api/projects", values),
    onSuccess: () => {
      toast({ title: "Datakilde tilføjet" });
      invalidate(["/api/projects"]);
      setShowCreate(false);
      form.reset();
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/projects/${id}/archive`, {}),
    onSuccess: () => {
      toast({ title: "Datakilde arkiveret" });
      invalidate(["/api/projects"]);
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const active = sources?.filter((s) => s.status === "active") ?? [];
  const archived = sources?.filter((s) => s.status !== "active") ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-viden-data">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{
                background: "rgba(245,158,11,0.10)",
                border: "1px solid rgba(245,158,11,0.18)",
              }}
            >
              <BookOpen className="w-4 h-4 text-secondary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              Viden & Data
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Upload dokumenter, billeder og intern viden, som jeres AI eksperter kan arbejde ud fra.
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          data-testid="button-add-datasource"
          className="shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Tilføj datakilde
        </Button>
      </div>

      {/* Source list */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : active.length === 0 ? (
        <div className="text-center py-20 space-y-4">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)" }}
          >
            <BookOpen className="w-7 h-7 text-secondary/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">Ingen datakilder endnu</p>
            <p className="text-sm text-muted-foreground">
              Tilføj din første datakilde — f.eks. en intern vidensbase, et regelsæt eller et dokument.
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} data-testid="button-empty-add-datasource">
            <Plus className="w-4 h-4 mr-1.5" />
            Tilføj datakilde
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {active.map((s) => (
              <DataSourceCard
                key={s.id}
                source={s}
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
                {archived.map((s) => (
                  <DataSourceCard key={s.id} source={s} onArchive={() => {}} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-secondary" />
              Tilføj datakilde
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
                        placeholder="forsikringsvilkar-2024"
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
                  {createMutation.isPending ? "Tilføjer..." : "Tilføj datakilde"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
