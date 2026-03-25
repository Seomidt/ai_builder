/**
 * AI Ekspert Editor — /ai-eksperter/opret og /ai-eksperter/:id/rediger
 *
 * Struktureret editor (ikke wizard). Admin-only.
 * Sektioner: A Identitet · B AI Adfærd · C Datagrundlag · D AI Hjælp
 * AI-assistance rutes via tenant runtime (runAiCall) — metered + logged.
 */

import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Brain, Sparkles, Loader2, Save, Pause, Play,
  Archive, Copy, ChevronDown, ChevronUp, Database, AlertTriangle,
  CheckCircle2, Wand2, RefreshCw, Scissors, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useAuth } from "@/hooks/use-auth";
import { QUERY_POLICY } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpertDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  goal: string | null;
  instructions: string | null;
  outputStyle: string | null;
  departmentId: string | null;
  language: string | null;
  source_count: number;
  rule_count: number;
  currentVersionId: string | null;
  draftVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeptRow { id: string; name: string; }

interface AiSuggestion {
  suggested_name:         string;
  improved_description:   string;
  goal:                   string;
  instructions:           string;
  suggested_output_style: "concise" | "formal" | "advisory";
  warnings:               string[];
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const editorSchema = z.object({
  name:         z.string().min(1, "Navn er påkrævet"),
  goal:         z.string().min(1, "Kort formål er påkrævet"),
  instructions: z.string().optional(),
  description:  z.string().optional(),
  outputStyle:  z.enum(["advisory", "formal", "concise", "detailed"]).optional(),
  departmentId: z.string().optional(),
});
type EditorValues = z.infer<typeof editorSchema>;

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_STYLE_OPTIONS = [
  { value: "advisory",  label: "Rådgivende" },
  { value: "concise",   label: "Kort og præcis" },
  { value: "detailed",  label: "Detaljeret og forklarende" },
  { value: "formal",    label: "Formelt" },
];

const STATUS_META: Record<string, { label: string; color: string }> = {
  active:   { label: "Aktiv",     color: "text-green-400 border-green-500/30 bg-green-500/8" },
  paused:   { label: "Pauset",    color: "text-amber-400 border-amber-500/30 bg-amber-500/8" },
  draft:    { label: "Kladde",    color: "text-slate-400 border-slate-500/30 bg-slate-500/8" },
  archived: { label: "Arkiveret", color: "text-rose-400 border-rose-500/30 bg-rose-500/8" },
};

function isAdminRole(role?: string) {
  return role === "tenant_admin" || role === "platform_admin" || role === "owner";
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ letter, title, subtitle }: { letter: string; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div
        className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
        style={{ background: "rgba(34,211,238,0.10)", color: "rgba(34,211,238,0.8)", border: "1px solid rgba(34,211,238,0.18)" }}
      >
        {letter}
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {subtitle && <p className="text-xs text-muted-foreground/60 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

// ─── AI Refine Button ─────────────────────────────────────────────────────────

function RefineButton({
  field, currentValue, onRefined, disabled,
}: {
  field: string;
  currentValue: string;
  onRefined: (text: string) => void;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const refineMutation = useMutation({
    mutationFn: async (action: "improve" | "shorten" | "rewrite" | "more_precise") => {
      const res = await apiRequest("POST", "/api/experts/ai-refine", {
        field, currentValue, action,
      });
      return res.json() as Promise<{ refined: string }>;
    },
    onSuccess: (data) => {
      onRefined(data.refined);
      setOpen(false);
      toast({ title: "Tekst opdateret" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "AI fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const actions = [
    { id: "improve" as const,      label: "Forbedr",        icon: Wand2 },
    { id: "shorten" as const,      label: "Forkort",        icon: Scissors },
    { id: "rewrite" as const,      label: "Omskriv",        icon: RefreshCw },
    { id: "more_precise" as const, label: "Gør mere præcis", icon: Zap },
  ];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !currentValue?.trim()}
        className="flex items-center gap-1 text-[11px] text-primary/50 hover:text-primary/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        data-testid={`button-ai-refine-${field}`}
      >
        <Sparkles size={11} />
        AI hjælp
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {actions.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => refineMutation.mutate(id)}
          disabled={refineMutation.isPending}
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-primary/20 text-primary/70 hover:bg-primary/5 transition-colors disabled:opacity-50"
        >
          {refineMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : <Icon size={10} />}
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors px-1"
      >
        ×
      </button>
    </div>
  );
}

// ─── Main Editor ──────────────────────────────────────────────────────────────

export default function AiEkspertEditor() {
  const [, navigate]    = useLocation();
  const { toast }       = useToast();
  const qc              = useQueryClient();
  const { user }        = useAuth();
  const isAdmin         = isAdminRole(user?.role);

  // Route matching — edit mode has :id, create mode is /opret
  const [matchEdit, paramsEdit] = useRoute("/ai-eksperter/:id/rediger");
  const expertId = matchEdit ? paramsEdit?.id : undefined;
  const isNew    = !expertId;

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [aiPrompt, setAiPrompt]         = useState("");
  const [aiSuggestion, setAiSuggestion] = useState<AiSuggestion | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: expert, isLoading: expertLoading } = useQuery<ExpertDetail>({
    queryKey: ["/api/experts", expertId],
    enabled:  !!expertId,
    ...QUERY_POLICY.staticList,
  });

  const { data: depts = [] } = useQuery<DeptRow[]>({
    queryKey: ["/api/tenant/departments"],
    ...QUERY_POLICY.staticList,
  });

  // ── Form ───────────────────────────────────────────────────────────────────
  const form = useForm<EditorValues>({
    resolver: zodResolver(editorSchema),
    defaultValues: {
      name: "", goal: "", instructions: "", description: "",
      outputStyle: "advisory", departmentId: "",
    },
  });

  useEffect(() => {
    if (expert) {
      form.reset({
        name:         expert.name,
        goal:         expert.goal ?? "",
        instructions: expert.instructions ?? "",
        description:  expert.description ?? "",
        outputStyle:  (expert.outputStyle as EditorValues["outputStyle"]) ?? "advisory",
        departmentId: expert.departmentId ?? "",
      });
    }
  }, [expert]);

  useEffect(() => {
    if (isNew && depts.length === 1) {
      form.setValue("departmentId", depts[0].id, { shouldValidate: false });
    }
  }, [depts, isNew]);

  // ── Save (create or update) ────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (values: EditorValues) => {
      const payload = {
        name:         values.name,
        goal:         values.goal || undefined,
        instructions: values.instructions || undefined,
        description:  values.description || undefined,
        outputStyle:  values.outputStyle === "advisory" ? undefined : values.outputStyle,
        departmentId: values.departmentId === "none" || !values.departmentId ? undefined : values.departmentId,
      };
      if (isNew) {
        const res = await apiRequest("POST", "/api/experts", payload);
        return res.json() as Promise<ExpertDetail>;
      } else {
        const res = await apiRequest("PATCH", `/api/experts/${expertId}`, payload);
        return res.json() as Promise<ExpertDetail>;
      }
    },
    onSuccess: (data) => {
      invalidate.afterArchMutation();
      toast({ title: isNew ? "Ekspert oprettet" : "Kladde gemt", description: isNew ? "Eksperten er klar til konfiguration." : "Ændringer gemt som kladde." });
      if (isNew) navigate(`/ai-eksperter/${data.id}`);
      else qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Pause / Resume ─────────────────────────────────────────────────────────
  const pauseMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/pause`, {}),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ["/api/experts", expertId] }); invalidate.afterArchMutation(); toast({ title: "Ekspert pauset" }); },
    onError:    (err: ApiError | Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const resumeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/resume`, {}),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ["/api/experts", expertId] }); invalidate.afterArchMutation(); toast({ title: "Ekspert genoptaget" }); },
    onError:    (err: ApiError | Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Archive ────────────────────────────────────────────────────────────────
  const archiveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/archive`, {}),
    onSuccess:  () => { toast({ title: "Ekspert arkiveret" }); navigate("/ai-eksperter"); },
    onError:    (err: ApiError | Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── Duplicate ──────────────────────────────────────────────────────────────
  const duplicateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/experts/${expertId}/duplicate`, {});
      return res.json() as Promise<ExpertDetail>;
    },
    onSuccess: (data) => {
      invalidate.afterArchMutation();
      toast({ title: "Ekspert duplikeret", description: `"${data.name}" er oprettet som kladde.` });
      navigate(`/ai-eksperter/${data.id}/rediger`);
    },
    onError: (err: ApiError | Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  // ── AI Suggest (Section D) ─────────────────────────────────────────────────
  const aiSuggestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/experts/ai-suggest", {
        rawDescription: aiPrompt,
        departmentId:   form.watch("departmentId") || undefined,
      });
      return res.json() as Promise<AiSuggestion>;
    },
    onSuccess: (data) => setAiSuggestion(data),
    onError:   (err: ApiError | Error) =>
      toast({ title: "AI fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const applyAiSuggestion = () => {
    if (!aiSuggestion) return;
    form.setValue("name",         aiSuggestion.suggested_name);
    form.setValue("goal",         aiSuggestion.goal);
    form.setValue("instructions", aiSuggestion.instructions);
    if (aiSuggestion.suggested_output_style) {
      form.setValue("outputStyle", aiSuggestion.suggested_output_style);
    }
    setAiSuggestion(null);
    setAiPrompt("");
    toast({ title: "Forslag anvendt", description: "Felterne er udfyldt med AI-forslaget. Kontrollér og gem." });
  };

  // ── Access guard ────────────────────────────────────────────────────────────
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 p-6">
        <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <Brain className="w-5 h-5 text-red-400" />
        </div>
        <p className="text-sm font-semibold text-foreground">Adgang nægtet</p>
        <p className="text-xs text-muted-foreground text-center max-w-xs">Kun administratorer kan oprette og redigere AI eksperter.</p>
        <Button variant="ghost" size="sm" onClick={() => navigate("/ai-eksperter")}>
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />Tilbage
        </Button>
      </div>
    );
  }

  if (!isNew && expertLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-2xl">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const currentStatus = expert?.status ?? "draft";
  const statusMeta    = STATUS_META[currentStatus] ?? STATUS_META.draft;
  const isPaused      = currentStatus === "paused";
  const isArchived    = currentStatus === "archived";
  const anyPending    = saveMutation.isPending || pauseMutation.isPending || resumeMutation.isPending || archiveMutation.isPending || duplicateMutation.isPending;

  const nameValue         = form.watch("name");
  const goalValue         = form.watch("goal");
  const instructionsValue = form.watch("instructions") ?? "";
  const descriptionValue  = form.watch("description") ?? "";

  return (
    <div className="flex flex-col min-h-[100dvh]" data-testid="page-expert-editor">

      {/* ── Sticky top header ───────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/[0.07]"
        style={{ backgroundColor: "hsl(218 30% 10% / 0.97)", backdropFilter: "blur(8px)" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => navigate(expertId ? `/ai-eksperter/${expertId}` : "/ai-eksperter")}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
            data-testid="button-back"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate" data-testid="text-editor-title">
              {isNew ? "Ny ekspert" : (nameValue || expert?.name || "Redigér ekspert")}
            </p>
            {!isNew && (
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 mt-0.5 ${statusMeta.color}`}
                data-testid="badge-expert-status"
              >
                {statusMeta.label}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!isNew && !isArchived && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => duplicateMutation.mutate()}
                disabled={anyPending}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-muted-foreground"
                data-testid="button-duplicate"
              >
                <Copy size={13} className="mr-1" />
                <span className="hidden sm:inline">Duplikér</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => archiveMutation.mutate()}
                disabled={anyPending}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-muted-foreground"
                data-testid="button-archive"
              >
                <Archive size={13} className="mr-1" />
                <span className="hidden sm:inline">Arkivér</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => isPaused ? resumeMutation.mutate() : pauseMutation.mutate()}
                disabled={anyPending}
                className="h-7 px-2.5 text-xs border-white/10"
                data-testid="button-pause-resume"
              >
                {isPaused
                  ? <><Play size={12} className="mr-1" />Genoptag</>
                  : <><Pause size={12} className="mr-1" />Pause</>}
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            onClick={form.handleSubmit((v) => saveMutation.mutate(v))}
            disabled={anyPending}
            className="h-7 px-3 text-xs"
            data-testid="button-save"
          >
            {saveMutation.isPending
              ? <Loader2 size={12} className="animate-spin mr-1" />
              : <Save size={12} className="mr-1" />}
            Gem
          </Button>
        </div>
      </header>

      {/* ── Scrollable body ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <Form {...form}>
          <form
            onSubmit={(e) => e.preventDefault()}
            className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-8"
          >

            {/* ── Section A — Identitet ────────────────────────────────────── */}
            <section data-testid="section-identitet">
              <SectionHeader
                letter="A"
                title="Identitet"
                subtitle="Ekspertens navn og præcise formål."
              />
              <div className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs text-muted-foreground/70">Navn *</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="f.eks. Forsikringsspecialist"
                        data-testid="input-expert-name"
                        className="bg-white/[0.03] border-white/10 focus:border-primary/40"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="goal" render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-xs text-muted-foreground/70">Kort formål *</FormLabel>
                      <RefineButton
                        field="kort formål"
                        currentValue={goalValue}
                        onRefined={(t) => form.setValue("goal", t)}
                        disabled={!goalValue?.trim()}
                      />
                    </div>
                    <FormControl>
                      <Input
                        placeholder="Vurderer forsikringssager og forklarer dækning ud fra virksomhedens egne data."
                        data-testid="input-expert-goal"
                        className="bg-white/[0.03] border-white/10 focus:border-primary/40"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {depts.length > 1 && (
                  <FormField control={form.control} name="departmentId" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs text-muted-foreground/70">Afdeling</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger
                            className="bg-white/[0.03] border-white/10"
                            data-testid="select-expert-department"
                          >
                            <SelectValue placeholder="Vælg afdeling" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Ingen afdeling</SelectItem>
                          {depts.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                )}
              </div>
            </section>

            {/* ── Section B — AI Adfærd ─────────────────────────────────────── */}
            <section data-testid="section-ai-adfaerd">
              <SectionHeader
                letter="B"
                title="AI Adfærd"
                subtitle="Beskriv hvad AI'en skal gøre, hvad den ikke må, og hvordan svarene skal fremstå."
              />
              <div className="space-y-4">
                <FormField control={form.control} name="instructions" render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-xs text-muted-foreground/70">Hvad skal AI gøre? *</FormLabel>
                      <RefineButton
                        field="hvad skal AI gøre"
                        currentValue={instructionsValue}
                        onRefined={(t) => form.setValue("instructions", t)}
                        disabled={!instructionsValue.trim()}
                      />
                    </div>
                    <FormControl>
                      <Textarea
                        placeholder="Beskriv de opgaver eksperten skal løse. Brug gerne punktform."
                        rows={4}
                        data-testid="input-expert-instructions"
                        className="bg-white/[0.03] border-white/10 focus:border-primary/40 resize-none"
                        {...field}
                      />
                    </FormControl>
                  </FormItem>
                )} />

                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-xs text-muted-foreground/70">Hvad må AI ikke gøre?</FormLabel>
                      <RefineButton
                        field="hvad må AI ikke gøre"
                        currentValue={descriptionValue}
                        onRefined={(t) => form.setValue("description", t)}
                        disabled={!descriptionValue.trim()}
                      />
                    </div>
                    <FormControl>
                      <Textarea
                        placeholder="Beskriv begrænsninger, ting AI ikke må antage, eller handlinger den ikke må udføre."
                        rows={3}
                        data-testid="input-expert-restrictions"
                        className="bg-white/[0.03] border-white/10 focus:border-primary/40 resize-none"
                        {...field}
                      />
                    </FormControl>
                  </FormItem>
                )} />

                <FormField control={form.control} name="outputStyle" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs text-muted-foreground/70">Hvordan skal svarene være?</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? "advisory"}>
                      <FormControl>
                        <SelectTrigger
                          className="bg-white/[0.03] border-white/10"
                          data-testid="select-expert-outputstyle"
                        >
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {OUTPUT_STYLE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />

                {/* Advanced — collapsed by default */}
                <div className="border border-white/[0.06] rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((p) => !p)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors"
                    data-testid="button-toggle-advanced"
                  >
                    <span className="font-medium uppercase tracking-wide text-[10px]">Avanceret konfiguration</span>
                    {advancedOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {advancedOpen && (
                    <div className="px-3.5 pb-3.5 space-y-2 border-t border-white/[0.06]">
                      <p className="text-[11px] text-muted-foreground/40 pt-3">
                        Disse felter er til intern brug og viderekomne konfigurationer. Brug ikke som primær indgang til ekspert-opsætning.
                      </p>
                      {!isNew && expert && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-medium">Ekspert ID</p>
                          <code className="text-[10px] text-muted-foreground/40 font-mono">{expert.id}</code>
                        </div>
                      )}
                      {!isNew && expert && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-medium">Versioner</p>
                          <p className="text-[11px] text-muted-foreground/50">
                            Live: {expert.currentVersionId ? expert.currentVersionId.slice(0, 8) + "…" : "Ingen"} ·
                            Kladde: {expert.draftVersionId ? expert.draftVersionId.slice(0, 8) + "…" : "Ingen"}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* ── Section C — Datagrundlag (only for existing experts) ─────── */}
            {!isNew && (
              <section data-testid="section-datagrundlag">
                <SectionHeader
                  letter="C"
                  title="Datagrundlag"
                  subtitle="De datakilder eksperten arbejder ud fra."
                />
                <div
                  className="flex items-center justify-between rounded-xl border border-white/[0.07] px-4 py-3.5"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <div className="flex items-center gap-3">
                    <Database size={15} className="text-primary/50 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {expert?.source_count ?? 0} koblede datakilder
                      </p>
                      <p className="text-xs text-muted-foreground/50">
                        {expert?.rule_count ?? 0} regler konfigureret
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/ai-eksperter/${expertId}`)}
                    className="text-xs border-white/10 h-7 shrink-0"
                    data-testid="button-manage-sources"
                  >
                    Administrér
                  </Button>
                </div>
              </section>
            )}

            {/* ── Section D — AI Hjælp ─────────────────────────────────────── */}
            <section data-testid="section-ai-hjaelp">
              <SectionHeader
                letter="D"
                title="AI Hjælp"
                subtitle="Lad AI generere et komplet konfigurationsforslag — køres via din organisations AI runtime."
              />
              <div className="space-y-3">
                <Textarea
                  placeholder="f.eks. En ekspert der vurderer forsikringssager ud fra policer, skadeshistorik og interne dokumenter."
                  rows={3}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className="bg-white/[0.03] border-white/10 focus:border-primary/40 resize-none"
                  data-testid="input-ai-prompt"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => aiSuggestMutation.mutate()}
                  disabled={!aiPrompt.trim() || aiSuggestMutation.isPending}
                  className="w-full border-primary/20 text-primary/80 hover:bg-primary/5 text-xs h-8"
                  data-testid="button-ai-generate"
                >
                  {aiSuggestMutation.isPending
                    ? <><Loader2 size={13} className="mr-1.5 animate-spin" />Analyserer…</>
                    : <><Sparkles size={13} className="mr-1.5" />Generér forslag</>}
                </Button>

                {aiSuggestion && (
                  <div
                    className="rounded-xl border border-primary/15 p-4 space-y-3"
                    style={{ background: "rgba(34,211,238,0.03)" }}
                    data-testid="ai-suggestion-block"
                  >
                    <div className="flex items-center gap-2">
                      <Sparkles size={13} className="text-primary/70" />
                      <span className="text-xs font-semibold text-primary/80">AI konfigurationsforslag</span>
                    </div>

                    <div className="space-y-2">
                      <SuggRow label="Navn"         value={aiSuggestion.suggested_name} />
                      <SuggRow label="Kort formål"  value={aiSuggestion.goal} />
                      <SuggRow label="Instruktioner" value={aiSuggestion.instructions} multiline />
                      <SuggRow label="Outputstil"
                        value={OUTPUT_STYLE_OPTIONS.find((o) => o.value === aiSuggestion.suggested_output_style)?.label ?? aiSuggestion.suggested_output_style}
                      />
                    </div>

                    {(aiSuggestion.warnings ?? []).length > 0 && (
                      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/8 border border-amber-500/15">
                        <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                        <p className="text-xs text-amber-400">{aiSuggestion.warnings.join(" ")}</p>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={applyAiSuggestion}
                        className="text-xs h-7 flex-1"
                        data-testid="button-apply-suggestion"
                      >
                        <CheckCircle2 size={12} className="mr-1.5" />
                        Anvend forslag
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAiSuggestion(null)}
                        className="text-xs h-7 text-muted-foreground/50"
                      >
                        Afvis
                      </Button>
                    </div>
                  </div>
                )}

                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5"
                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
                >
                  <Brain size={12} className="text-primary/30 shrink-0" />
                  <p className="text-[11px] text-muted-foreground/40">
                    AI-kald faktureres til din organisations konto — brug og omkostninger logges automatisk.
                  </p>
                </div>
              </div>
            </section>

            {/* Bottom save button (convenience, mobile) */}
            <div className="pb-6">
              <Button
                type="button"
                onClick={form.handleSubmit((v) => saveMutation.mutate(v))}
                disabled={anyPending}
                className="w-full"
                data-testid="button-save-bottom"
              >
                {saveMutation.isPending
                  ? <><Loader2 size={14} className="animate-spin mr-2" />Gemmer…</>
                  : <><Save size={14} className="mr-2" />{isNew ? "Opret ekspert" : "Gem kladde"}</>}
              </Button>
            </div>

          </form>
        </Form>
      </div>
    </div>
  );
}

// ─── Suggestion row ────────────────────────────────────────────────────────────

function SuggRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/40 mb-0.5">{label}</p>
      {multiline
        ? <p className="text-xs text-foreground/75 whitespace-pre-wrap border-l-2 border-primary/20 pl-2">{value}</p>
        : <p className="text-xs text-foreground/75">{value}</p>
      }
    </div>
  );
}
