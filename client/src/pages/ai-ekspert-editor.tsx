/**
 * AI Ekspert Editor — /ai-eksperter/opret og /ai-eksperter/:id/rediger
 *
 * V2: UX + AI hardening.
 * Sektioner: A Identitet · B AI Adfærd · C Datagrundlag · D AI Hjælp
 * AI-assistance rutes via tenant runtime (runAiCall) — metered + logged.
 */

import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Brain, Sparkles, Loader2, Save, Pause, Play,
  Archive, Copy, ChevronDown, ChevronUp, Database,
  CheckCircle2, Wand2, RefreshCw, Scissors, Zap, Plus,
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
  restrictions:           string;
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

// ─── Smart templates ──────────────────────────────────────────────────────────

const SMART_TEMPLATES = {
  support: {
    label:        "+ Support ekspert",
    name:         "Support Specialist",
    goal:         "Besvarer kundespørgsmål præcist ud fra virksomhedens egne produkter, politikker og processer.",
    instructions: "- Analyser brugerens spørgsmål og find relevant information i de tilkoblede datakilder\n- Giv klare, konkrete svar baseret udelukkende på virksomhedens dokumentation\n- Henvis til specifikke sektioner eller dokumenter, når det er muligt\n- Tilbyd næste skridt eller handlingsanvisninger ved komplekse sager\n- Eskalér til menneskelig support, hvis spørgsmålet er uden for ekspertens rækkevidde",
    restrictions: "- Gæt ikke på svar, der ikke er dokumenteret i datakilden\n- Foretag ikke antagelser om kundens kontosituation uden data\n- Udfør ikke handlinger på vegne af kunden (refunderinger, kontoændringer osv.)\n- Brug ikke eksterne søgeresultater eller generel viden som kilde",
    outputStyle:  "concise" as const,
  },
  salg: {
    label:        "+ Salg ekspert",
    name:         "Salgs Assistent",
    goal:         "Hjælper sælgere med at finde relevante argumenter, produktinformation og konkurrencemæssige fordele.",
    instructions: "- Identificér relevante produkter og fordele ud fra kundens behov og de tilkoblede salgsdata\n- Fremhæv unikke salgsargumenter baseret på virksomhedens egne materialer\n- Foreslå konkrete next steps og handlingsorienterede anbefalinger\n- Brug virksomhedens pristrapper og kampagner korrekt\n- Giv svar i et overbevisende, professionelt sprog tilpasset salgssituationen",
    restrictions: "- Lov ikke noget, der ikke fremgår af de godkendte salgsmaterialer\n- Angiv ikke priser uden at tjekke aktuelle prisdata\n- Undgå spekulativ sammenligning med konkurrenter uden dokumentation\n- Gæt ikke på tekniske specifikationer — henvis til produktdatablade",
    outputStyle:  "advisory" as const,
  },
  compliance: {
    label:        "+ Compliance ekspert",
    name:         "Compliance Rådgiver",
    goal:         "Vurderer situationer op mod interne regler, lovgivning og politikker og giver præcise compliance-svar.",
    instructions: "- Analyser den beskrevne situation op mod de relevante regler og politikker i datakilderne\n- Identificér potentielle compliance-risici og angiv regelreferencer\n- Giv strukturerede vurderinger med klar konklusion (godkendt / afvist / kræver review)\n- Fremhæv, hvilke specifikke politikker eller lovparagraffer der er relevante\n- Anbefal eskalering til legal team ved tvivlstilfælde",
    restrictions: "- Giv aldrig juridisk rådgivning uden forbehold\n- Gæt ikke på lovgivning eller regler, der ikke er i datakilderne\n- Udlæg ikke situationer til brugerens fordel uden dækning\n- Foretag ikke endelige beslutninger — kun vurderinger til menneskelig godkendelse",
    outputStyle:  "formal" as const,
  },
};

function isAdminRole(role?: string) {
  return role === "tenant_admin" || role === "platform_admin" || role === "owner";
}

// ─── Field style constants ─────────────────────────────────────────────────────

const FIELD_CLS  = [
  "bg-white/[0.08] border-white/25",
  "focus:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0",
  "placeholder:text-white/20 text-white/90",
  "transition-colors duration-150",
].join(" ");
const LABEL_CLS  = "text-xs font-medium text-white/70 mb-1";
const HELPER_CLS = "text-[11px] text-white/30 mt-2 leading-relaxed";

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ letter, title, subtitle }: { letter: string; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3 mb-5">
      <div
        className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
        style={{ background: "rgba(34,211,238,0.10)", color: "rgba(34,211,238,0.8)", border: "1px solid rgba(34,211,238,0.18)" }}
      >
        {letter}
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {subtitle && <p className="text-xs text-muted-foreground/55 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

// ─── AI Refine Button — med preview før replace ───────────────────────────────

function RefineButton({
  field, currentValue, onAccept, disabled,
}: {
  field: string;
  currentValue: string;
  onAccept: (text: string, mode: "replace" | "insert") => void;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen]         = useState(false);
  const [preview, setPreview]   = useState<string | null>(null);

  const refineMutation = useMutation({
    mutationFn: async (action: "improve" | "shorten" | "rewrite" | "more_precise") => {
      const res = await apiRequest("POST", "/api/experts/ai-refine", {
        field, currentValue, action,
      });
      return res.json() as Promise<{ refined: string }>;
    },
    onSuccess: (data) => setPreview(data.refined),
    onError: (err: ApiError | Error) =>
      toast({ title: "AI fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const handleAccept = (mode: "replace" | "insert") => {
    if (!preview) return;
    onAccept(preview, mode);
    setPreview(null);
    setOpen(false);
    toast({ title: mode === "replace" ? "Tekst erstattet" : "Tekst tilføjet" });
  };

  const handleCancel = () => {
    setPreview(null);
    setOpen(false);
  };

  const actions = [
    { id: "improve" as const,      label: "Forbedr",         icon: Wand2 },
    { id: "shorten" as const,      label: "Forkort",         icon: Scissors },
    { id: "rewrite" as const,      label: "Omskriv",         icon: RefreshCw },
    { id: "more_precise" as const, label: "Gør mere præcis", icon: Zap },
  ];

  if (!open && !preview) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !currentValue?.trim()}
        className="flex items-center gap-1 text-[10px] text-white/30 hover:text-primary/60 transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
        data-testid={`button-ai-refine-${field}`}
      >
        <Sparkles size={10} />
        AI hjælp
      </button>
    );
  }

  if (preview) {
    return (
      <div
        className="mt-2 rounded-lg border border-primary/20 bg-primary/[0.04] p-3 space-y-2"
        data-testid="panel-ai-preview"
      >
        <p className="text-[10px] text-primary/50 uppercase tracking-wider font-medium">AI forslag</p>
        <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{preview}</p>
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => handleAccept("replace")}
            className="h-6 px-2.5 text-[11px]"
            data-testid="button-preview-replace"
          >
            <CheckCircle2 size={11} className="mr-1" />
            Erstat
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => handleAccept("insert")}
            className="h-6 px-2.5 text-[11px] border-white/10"
            data-testid="button-preview-insert"
          >
            <Plus size={11} className="mr-1" />
            Tilføj
          </Button>
          <button
            type="button"
            onClick={handleCancel}
            className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors px-1"
            data-testid="button-preview-cancel"
          >
            Annullér
          </button>
        </div>
      </div>
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
      toast({
        title: isNew ? "Ekspert oprettet" : "Ændringer gemt",
        description: isNew ? "Eksperten er klar til konfiguration." : "Ændringer er gemt.",
      });
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
    form.setValue("description",  aiSuggestion.restrictions || aiSuggestion.improved_description);
    if (aiSuggestion.suggested_output_style) {
      form.setValue("outputStyle", aiSuggestion.suggested_output_style);
    }
    setAiSuggestion(null);
    setAiPrompt("");
    toast({ title: "Forslag anvendt", description: "Alle felter er udfyldt. Kontrollér og gem." });
  };

  // ── Smart template fill ────────────────────────────────────────────────────
  const applyTemplate = (key: keyof typeof SMART_TEMPLATES) => {
    const t = SMART_TEMPLATES[key];
    form.setValue("name",         t.name);
    form.setValue("goal",         t.goal);
    form.setValue("instructions", t.instructions);
    form.setValue("description",  t.restrictions);
    form.setValue("outputStyle",  t.outputStyle);
    toast({ title: `${t.name} skabelon anvendt`, description: "Ret felterne til din virksomhed og gem." });
  };

  // ── Refine helpers ─────────────────────────────────────────────────────────
  const handleRefinedInstructions = (text: string, mode: "replace" | "insert") => {
    const current = form.getValues("instructions") ?? "";
    form.setValue("instructions", mode === "replace" ? text : `${current}\n${text}`.trim());
  };

  const handleRefinedGoal = (text: string, mode: "replace" | "insert") => {
    const current = form.getValues("goal") ?? "";
    form.setValue("goal", mode === "replace" ? text : `${current} ${text}`.trim());
  };

  const handleRefinedDescription = (text: string, mode: "replace" | "insert") => {
    const current = form.getValues("description") ?? "";
    form.setValue("description", mode === "replace" ? text : `${current}\n${text}`.trim());
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

          {/* PRIMARY ACTION — kun ét knap, label afhænger af mode */}
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
            {isNew ? "Opret ekspert" : "Gem ændringer"}
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
                  <FormItem className="space-y-1.5">
                    <FormLabel className={LABEL_CLS}>Navn *</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="f.eks. Forsikringsspecialist"
                        data-testid="input-expert-name"
                        className={FIELD_CLS}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="goal" render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <FormLabel className={LABEL_CLS}>Kort formål *</FormLabel>
                      <RefineButton
                        field="kort formål"
                        currentValue={goalValue}
                        onAccept={handleRefinedGoal}
                        disabled={!goalValue?.trim()}
                      />
                    </div>
                    <FormControl>
                      <Input
                        placeholder="Vurderer forsikringssager og forklarer dækning ud fra virksomhedens egne data."
                        data-testid="input-expert-goal"
                        className={FIELD_CLS}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {depts.length > 1 && (
                  <FormField control={form.control} name="departmentId" render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className={LABEL_CLS}>Afdeling</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger
                            className={FIELD_CLS}
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
              <div className="space-y-5">

                {/* Smart templates — secondary emphasis */}
                <div data-testid="panel-smart-templates" className="pb-1">
                  <p className="text-[10px] text-muted-foreground/30 uppercase tracking-wider font-medium mb-2">Hurtig skabelon</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(SMART_TEMPLATES) as (keyof typeof SMART_TEMPLATES)[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => applyTemplate(key)}
                        className="text-[11px] px-2.5 py-1 rounded border border-white/[0.08] text-muted-foreground/40 hover:text-muted-foreground/70 hover:border-white/20 hover:bg-white/[0.03] transition-colors"
                        data-testid={`button-template-${key}`}
                      >
                        {SMART_TEMPLATES[key].label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Hvad skal AI gøre */}
                <FormField control={form.control} name="instructions" render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <FormLabel className={LABEL_CLS}>Hvad skal AI gøre?</FormLabel>
                      <RefineButton
                        field="hvad skal AI gøre"
                        currentValue={instructionsValue}
                        onAccept={handleRefinedInstructions}
                        disabled={!instructionsValue.trim()}
                      />
                    </div>
                    <FormControl>
                      <Textarea
                        placeholder={"Brug gerne punktform:\n- Analyser data fra tilkoblede kilder\n- Besvar spørgsmål baseret på interne regler\n- Følg virksomhedens egne processer"}
                        rows={5}
                        data-testid="input-expert-instructions"
                        className={`${FIELD_CLS} resize-none min-h-[120px]`}
                        {...field}
                      />
                    </FormControl>
                    <p className={HELPER_CLS}>
                      Eksempler: Analysér data · Besvar spørgsmål · Følg interne regler · Giv strukturerede anbefalinger
                    </p>
                  </FormItem>
                )} />

                {/* Hvad må AI ikke gøre */}
                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <FormLabel className={LABEL_CLS}>Hvad må AI ikke gøre?</FormLabel>
                      <RefineButton
                        field="hvad må AI ikke gøre"
                        currentValue={descriptionValue}
                        onAccept={handleRefinedDescription}
                        disabled={!descriptionValue.trim()}
                      />
                    </div>
                    <FormControl>
                      <Textarea
                        placeholder={"Brug gerne punktform:\n- Gæt ikke — svar kun baseret på tilgængelig data\n- Anta ikke noget om ekstern viden\n- Udfør ikke handlinger uden dokumentation"}
                        rows={4}
                        data-testid="input-expert-restrictions"
                        className={`${FIELD_CLS} resize-none min-h-[100px]`}
                        {...field}
                      />
                    </FormControl>
                    <p className={HELPER_CLS}>
                      Eksempler: Ingen gætteri · Ingen eksterne antagelser · Ingen handlinger uden data
                    </p>
                  </FormItem>
                )} />

                <FormField control={form.control} name="outputStyle" render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel className={LABEL_CLS}>Hvordan skal svarene være?</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? "advisory"}>
                      <FormControl>
                        <SelectTrigger
                          className={FIELD_CLS}
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

                {/* Advanced — collapsed */}
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
                    <div className="border-t border-white/[0.06]">
                      {isNew ? (
                        <div className="px-3.5 py-4">
                          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-3.5 text-center">
                            <p className="text-xs text-white/30 font-medium">Ingen avancerede indstillinger endnu</p>
                            <p className="text-[11px] text-white/20 mt-1">Tilgængeligt efter oprettelse af eksperten</p>
                          </div>
                        </div>
                      ) : (
                        <div className="px-3.5 pb-3.5 pt-3 space-y-3">
                          {expert && (
                            <>
                              <div className="space-y-1">
                                <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium">Ekspert ID</p>
                                <code className="text-[10px] text-white/35 font-mono">{expert.id}</code>
                              </div>
                              <div className="space-y-1">
                                <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium">Versioner</p>
                                <p className="text-[11px] text-white/40">
                                  Live: {expert.currentVersionId ? expert.currentVersionId.slice(0, 8) + "…" : "Ingen"} ·
                                  Kladde: {expert.draftVersionId ? expert.draftVersionId.slice(0, 8) + "…" : "Ingen"}
                                </p>
                              </div>
                            </>
                          )}
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
                subtitle="Beskriv eksperten med dine egne ord — AI udfylder alle felter automatisk."
              />
              <div className="space-y-3">
                <Textarea
                  placeholder="f.eks. En ekspert der vurderer forsikringssager ud fra policer, skadeshistorik og interne dokumenter — giver strukturerede vurderinger og anbefaler videre behandling."
                  rows={4}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className={`${FIELD_CLS} resize-none min-h-[100px]`}
                  data-testid="input-ai-prompt"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => aiSuggestMutation.mutate()}
                  disabled={!aiPrompt.trim() || aiSuggestMutation.isPending}
                  className="w-full border-primary/20 text-primary/80 hover:bg-primary/5 text-xs h-9"
                  data-testid="button-ai-generate"
                >
                  {aiSuggestMutation.isPending
                    ? <><Loader2 size={13} className="mr-1.5 animate-spin" />Analyserer…</>
                    : <><Sparkles size={13} className="mr-1.5" />Generér fuldt forslag</>}
                </Button>

                {aiSuggestion && (
                  <div
                    className="rounded-xl border border-primary/20 bg-primary/[0.04] p-4 space-y-3"
                    data-testid="panel-ai-suggestion"
                  >
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-primary/60" />
                      <p className="text-xs font-semibold text-foreground">AI forslag klar</p>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-0.5">Navn</p>
                        <p className="text-foreground/80">{aiSuggestion.suggested_name}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-0.5">Formål</p>
                        <p className="text-foreground/80">{aiSuggestion.goal}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-0.5">Hvad AI skal gøre</p>
                        <p className="text-foreground/80 whitespace-pre-line">{aiSuggestion.instructions}</p>
                      </div>
                      {(aiSuggestion.restrictions || aiSuggestion.improved_description) && (
                        <div>
                          <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-0.5">Hvad AI ikke må</p>
                          <p className="text-foreground/80 whitespace-pre-line">
                            {aiSuggestion.restrictions || aiSuggestion.improved_description}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-0.5">Svarstil</p>
                        <p className="text-foreground/80 capitalize">{aiSuggestion.suggested_output_style}</p>
                      </div>
                    </div>

                    {aiSuggestion.warnings.length > 0 && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-2.5">
                        {aiSuggestion.warnings.map((w, i) => (
                          <p key={i} className="text-[11px] text-amber-400/80">{w}</p>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={applyAiSuggestion}
                        className="h-7 px-3 text-xs flex-1"
                        data-testid="button-apply-suggestion"
                      >
                        <CheckCircle2 size={12} className="mr-1.5" />
                        Anvend alle felter
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setAiSuggestion(null)}
                        className="h-7 px-2 text-xs text-muted-foreground/50"
                        data-testid="button-dismiss-suggestion"
                      >
                        Afvis
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>

          </form>
        </Form>
      </div>
    </div>
  );
}
