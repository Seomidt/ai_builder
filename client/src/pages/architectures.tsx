import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Cpu, MoreHorizontal, Tag } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";
import { usePagePerf } from "@/lib/perf";

interface ArchRow {
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
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1, "Slug is required").regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens only"),
  description: z.string().optional(),
  category: z.string().optional(),
});

type CreateValues = z.infer<typeof createSchema>;

function ArchCard({ arch, onArchive }: { arch: ArchRow; onArchive: (id: string) => void }) {
  return (
    <Card data-testid={`arch-card-${arch.id}`} className="bg-card border-card-border hover:border-primary/30 transition-colors">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-secondary/10 shrink-0">
              <Cpu className="w-4 h-4 text-secondary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{arch.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{arch.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className={`text-xs border capitalize ${arch.status === "active" ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-muted-foreground"}`}>
              {arch.status}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" data-testid={`arch-menu-${arch.id}`}>
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onArchive(arch.id)}
                  data-testid={`archive-arch-${arch.id}`}
                >
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {arch.description && (
          <p className="text-xs text-muted-foreground mt-3 line-clamp-2">{arch.description}</p>
        )}

        <div className="flex items-center gap-2 mt-3">
          {arch.category && (
            <div className="flex items-center gap-1">
              <Tag className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-xs text-muted-foreground/70">{arch.category}</span>
            </div>
          )}
          {arch.currentVersionId ? (
            <Badge variant="outline" className="text-xs text-primary border-primary/25 bg-primary/8">
              Has published version
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-muted-foreground border-border">
              Draft
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground/50 mt-2">{new Date(arch.createdAt).toLocaleDateString()}</p>
      </CardContent>
    </Card>
  );
}

export default function Architectures() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const perf = usePagePerf("architectures");

  const { data: architectures = [], isLoading } = useQuery<ArchRow[]>({
    queryKey: ["architectures"],
    queryFn: () => apiRequest("GET", "/api/architectures").then((r) => r.json()),
    ...QUERY_POLICY.staticList,
  });

  useEffect(() => {
    if (architectures.length > 0 || !isLoading) perf.record(architectures.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [architectures.length, isLoading]);

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", slug: "", description: "", category: "" },
  });

  const createMutation = useMutation({
    mutationFn: async (values: CreateValues) => {
      await apiRequest("POST", "/api/architectures", values);
    },
    onSuccess: () => {
      invalidate.afterArchMutation();
      setOpen(false);
      form.reset();
      toast({ title: "Architecture created" });
    },
    onError: (e: Error) => {
      const code = e instanceof ApiError ? e.errorCode : null;
      const title =
        code === "DUPLICATE_SLUG" ? "Slug already in use" :
        code === "CONFLICT"       ? "Conflict" :
        code === "VALIDATION_ERROR" ? "Validation error" :
        "Could not create architecture";
      toast({ title, description: e.message, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/architectures/${id}/archive`);
    },
    onSuccess: () => {
      invalidate.afterArchMutation();
      toast({ title: "Architecture archived" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Architectures</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{architectures.length} architecture profile{architectures.length !== 1 ? "s" : ""}</p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="btn-new-architecture">
          <Plus className="w-3.5 h-3.5 mr-1.5" /> New Architecture
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : architectures.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Cpu className="w-10 h-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No architectures yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Create your first architecture profile</p>
          <Button size="sm" className="mt-4" onClick={() => setOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Create architecture
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {architectures.map((a) => (
            <ArchCard key={a.id} arch={a} onArchive={(id) => archiveMutation.mutate(id)} />
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Architecture</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => createMutation.mutate(v))} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="SaaS Builder Expert" data-testid="input-arch-name"
                      onChange={(e) => {
                        field.onChange(e);
                        if (!form.getValues("slug")) {
                          form.setValue("slug", e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="slug" render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="saas-builder-expert" data-testid="input-arch-slug" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem>
                  <FormLabel>Category <span className="text-muted-foreground">(optional)</span></FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="saas-builder" data-testid="input-arch-category" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-muted-foreground">(optional)</span></FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Describe this architecture…" rows={3} data-testid="input-arch-description" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending} data-testid="btn-create-arch">
                  {createMutation.isPending ? "Creating…" : "Create Architecture"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
