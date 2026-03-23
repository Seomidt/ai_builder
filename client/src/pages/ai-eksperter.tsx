/**
 * AI Eksperter — Tenant Product Page
 *
 * Create and manage AI experts/specialists.
 * Backed by architecture_profiles in the database.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Brain, MoreHorizontal, Tag, Sparkles } from "lucide-react";
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

interface ExpertRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  category: string | null;
  currentVersionId: string | null;
  createdAt: string;
}

const createSchema = z.object({
  name: z.string().min(1, "Navn er påkrævet"),
  slug: z
    .string()
    .min(1, "Slug er påkrævet")
    .regex(/^[a-z0-9-]+$/, "Kun små bogstaver, tal og bindestreger"),
  description: z.string().optional(),
  category: z.string().optional(),
});

type CreateValues = z.infer<typeof createSchema>;

const EXPERT_EXAMPLES = [
  "Forsikringsspecialist",
  "Supportekspert",
  "Compliance Ekspert",
  "Salgsassistent",
  "Dokumentanalytiker",
];

function ExpertCard({
  expert,
  onArchive,
}: {
  expert: ExpertRow;
  onArchive: (id: string) => void;
}) {
  return (
    <Card
      data-testid={`expert-card-${expert.id}`}
      className="bg-card border-card-border hover:border-primary/30 transition-all duration-200 hover:-translate-y-0.5 relative overflow-hidden"
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
              <p className="text-xs text-muted-foreground font-mono truncate">{expert.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="outline"
              className={`text-xs border capitalize ${
                expert.status === "active"
                  ? "text-green-400 border-green-500/30 bg-green-500/10"
                  : "text-muted-foreground"
              }`}
            >
              {expert.status === "active" ? "Aktiv" : expert.status}
            </Badge>
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
                  className="text-destructive"
                  onClick={() => onArchive(expert.id)}
                  data-testid={`archive-expert-${expert.id}`}
                >
                  Arkivér
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {expert.description && (
          <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
            {expert.description}
          </p>
        )}

        {expert.category && (
          <div className="flex items-center gap-1.5 mt-3">
            <Tag className="w-3 h-3 text-muted-foreground/60" />
            <span className="text-xs text-muted-foreground/60">{expert.category}</span>
          </div>
        )}

        <p className="text-xs text-muted-foreground/40 mt-3">
          Oprettet {new Date(expert.createdAt).toLocaleDateString("da-DK")}
        </p>
      </CardContent>
    </Card>
  );
}

export default function AiEksperter() {
  usePagePerf("ai-eksperter");
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data: experts, isLoading } = useQuery<ExpertRow[]>({
    queryKey: ["/api/architectures"],
    ...QUERY_POLICY.list,
  });

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", slug: "", description: "", category: "" },
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
    mutationFn: (values: CreateValues) =>
      apiRequest("POST", "/api/architectures", values),
    onSuccess: () => {
      toast({ title: "AI ekspert oprettet" });
      invalidate(["/api/architectures"]);
      setShowCreate(false);
      form.reset();
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/architectures/${id}/archive`, {}),
    onSuccess: () => {
      toast({ title: "Ekspert arkiveret" });
      invalidate(["/api/architectures"]);
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const active = experts?.filter((e) => e.status === "active") ?? [];
  const archived = experts?.filter((e) => e.status !== "active") ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-ai-eksperter">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{
                background: "rgba(34,211,238,0.10)",
                border: "1px solid rgba(34,211,238,0.18)",
              }}
            >
              <Brain className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              AI Eksperter
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Opret og administrér AI eksperter, der bruger jeres egne data, regler og processer.
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          data-testid="button-create-expert"
          className="shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Opret ekspert
        </Button>
      </div>

      {/* Expert list */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : active.length === 0 ? (
        <div className="text-center py-20 space-y-4">
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
              <span className="text-primary/80">
                {EXPERT_EXAMPLES[Math.floor(Math.random() * EXPERT_EXAMPLES.length)]}
              </span>
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} data-testid="button-empty-create-expert">
            <Plus className="w-4 h-4 mr-1.5" />
            Opret AI ekspert
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {active.map((e) => (
              <ExpertCard key={e.id} expert={e} onArchive={(id) => archiveMutation.mutate(id)} />
            ))}
          </div>

          {archived.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground/50 uppercase tracking-widest font-bold mb-3">
                Arkiverede
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 opacity-50">
                {archived.map((e) => (
                  <ExpertCard key={e.id} expert={e} onArchive={() => {}} />
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
              <Sparkles className="w-4 h-4 text-primary" />
              Opret AI ekspert
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
                        placeholder="f.eks. Forsikringsspecialist"
                        data-testid="input-expert-name"
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
                        placeholder="forsikringsspecialist"
                        className="font-mono text-sm"
                        data-testid="input-expert-slug"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kategori (valgfri)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="f.eks. Support, Salg, Compliance"
                        data-testid="input-expert-category"
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
                        placeholder="Hvad gør denne AI ekspert?"
                        rows={3}
                        data-testid="input-expert-description"
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
                  data-testid="button-submit-create-expert"
                >
                  {createMutation.isPending ? "Opretter..." : "Opret ekspert"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
