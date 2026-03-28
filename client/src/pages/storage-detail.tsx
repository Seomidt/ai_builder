/**
 * Storage Detail — /storage/:id
 *
 * Complete tenant-facing data source management:
 * - Source header + health badge + edit
 * - Summary metrics (total/indexed/processing/failed/linked experts)
 * - Expert linking (list/add/remove)
 * - Asset list with search/filter/sort
 * - Retry failed assets
 * - Upload zone
 */

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Upload, FileText, Image, Video, File, Loader2,
  Database, CheckCircle2, Clock, AlertTriangle, RefreshCw,
  Link2, Brain, Plus, X, Search, SlidersHorizontal,
  Pencil, RotateCcw, Archive, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

interface KnowledgeBase {
  id:          string;
  name:        string;
  slug:        string;
  description: string | null;
  status:      string;
  assetCount:  number;
  createdAt:   string;
  updatedAt:   string;
}

interface AssetRow {
  id:               string;
  title:            string;
  documentType:     string;
  status:           string;
  mimeType:         string | null;
  fileSizeBytes:    number | null;
  versionNumber:    number;
  chunkCount:       number;
  embeddingCount:   number;
  latestJobStatus:  string | null;
  latestJobType:    string | null;
  parseStatus:      string | null;
  pipeline:         { jobType: string; status: string; failureReason: string | null }[];
  createdAt:        string;
  updatedAt:        string;
}

interface LinkedExpert {
  id:              string;
  expertId:        string;
  knowledgeBaseId: string;
  expertName:      string;
  expertSlug:      string | null;
  expertStatus:    string | null;
  createdAt:       string;
}

interface ExpertOption {
  id:     string;
  name:   string;
  slug:   string;
  status: string;
}

// ─── Edit schema ──────────────────────────────────────────────────────────────

const editSchema = z.object({
  name:        z.string().min(1, "Navn er påkrævet"),
  description: z.string().optional(),
});
type EditValues = z.infer<typeof editSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function relDate(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400_000);
  if (d === 0) return "I dag";
  if (d === 1) return "I går";
  if (d < 30)  return `${d} d. siden`;
  return new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" });
}

// ─── Source health badge ──────────────────────────────────────────────────────

function deriveHealth(assets: AssetRow[] | undefined, archived: boolean): {
  label: string; cls: string; icon: typeof CheckCircle2;
} {
  if (archived) return { label: "Arkiveret", cls: "text-muted-foreground border-muted-foreground/30", icon: Archive as any };
  if (!assets || assets.length === 0) return { label: "Tom", cls: "text-slate-400 border-slate-500/30 bg-slate-500/8", icon: Clock };
  const failed      = assets.filter((a) => a.status === "failed").length;
  const processing  = assets.filter((a) => ["processing","queued","draft"].includes(a.status)).length;
  const indexed     = assets.filter((a) => ["indexed","ready"].includes(a.status)).length;
  if (failed > 0 && indexed === 0) return { label: "Fejlet",      cls: "text-rose-400 border-rose-500/30 bg-rose-500/8",     icon: AlertTriangle };
  if (failed > 0)                  return { label: "Delvist fejl",cls: "text-amber-400 border-amber-500/30 bg-amber-500/8",  icon: AlertTriangle };
  if (processing > 0)              return { label: "Behandler",   cls: "text-sky-400 border-sky-500/30 bg-sky-500/8",        icon: Loader2 };
  if (indexed > 0)                 return { label: "Klar",        cls: "text-green-400 border-green-500/30 bg-green-500/8",  icon: CheckCircle2 };
  return { label: "Uploading", cls: "text-sky-400 border-sky-500/30 bg-sky-500/8", icon: Loader2 };
}

function HealthBadge({ assets, archived }: { assets: AssetRow[] | undefined; archived: boolean }) {
  const h = deriveHealth(assets, archived);
  const Icon = h.icon;
  return (
    <Badge variant="outline" className={`text-xs gap-1 ${h.cls}`}>
      <Icon className="w-2.5 h-2.5" />
      {h.label}
    </Badge>
  );
}

// ─── Asset type icon ──────────────────────────────────────────────────────────

function AssetTypeIcon({ type }: { type: string }) {
  const cls = "w-4 h-4 shrink-0";
  if (type === "image")    return <Image    className={`${cls} text-sky-400`} />;
  if (type === "video")    return <Video    className={`${cls} text-violet-400`} />;
  if (type === "document") return <FileText className={`${cls} text-amber-400`} />;
  return <File className={`${cls} text-muted-foreground`} />;
}

// ─── Asset status badge ───────────────────────────────────────────────────────

const STATUS_MAP: Record<string, { label: string; cls: string; icon: any; spin?: boolean }> = {
  indexed:    { label: "Indekseret", cls: "text-green-400 border-green-500/30 bg-green-500/8",  icon: CheckCircle2 },
  ready:      { label: "Klar",       cls: "text-green-400 border-green-500/30 bg-green-500/8",  icon: CheckCircle2 },
  processing: { label: "Behandler",  cls: "text-amber-400 border-amber-500/30 bg-amber-500/8",  icon: Loader2, spin: true },
  queued:     { label: "I kø",       cls: "text-slate-400 border-slate-500/30 bg-slate-500/8",  icon: Clock },
  draft:      { label: "Uploader",   cls: "text-sky-400 border-sky-500/30 bg-sky-500/8",        icon: Loader2, spin: true },
  failed:     { label: "Fejlet",     cls: "text-rose-400 border-rose-500/30 bg-rose-500/8",     icon: AlertTriangle },
};

function AssetStatusBadge({ status }: { status: string }) {
  const m = STATUS_MAP[status] ?? { label: status, cls: "text-muted-foreground border-border", icon: Clock };
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={`text-xs gap-1 shrink-0 ${m.cls}`}>
      <Icon className={`w-2.5 h-2.5 ${m.spin ? "animate-spin" : ""}`} />
      {m.label}
    </Badge>
  );
}

// ─── Upload zone ──────────────────────────────────────────────────────────────

const ACCEPTED = [
  "application/pdf","application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain","text/csv","image/png","image/jpeg","image/webp","video/mp4",
];

function UploadZone({ kbId, onUploaded }: { kbId: string; onUploaded: () => void }) {
  const { toast } = useToast();
  const inputRef  = useRef<HTMLInputElement>(null);
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch(`/api/kb/${kbId}/upload`, { method: "POST", body: fd, credentials: "include" });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          errors.push(`${file.name}: ${j.message ?? resp.statusText}`);
        }
      } catch {
        errors.push(`${file.name}: Netværksfejl`);
      }
    }
    setUploading(false);
    if (errors.length) {
      toast({ title: "Upload fejl", description: errors.join("; "), variant: "destructive" });
    } else {
      toast({ title: files.length === 1 ? "1 fil uploadet" : `${files.length} filer uploadet` });
    }
    onUploaded();
  }, [kbId, onUploaded, toast]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false); upload(e.dataTransfer.files);
  }, [upload]);

  return (
    <div
      className={`relative rounded-xl border-2 border-dashed transition-colors duration-150 px-6 py-6 text-center ${
        dragging ? "border-primary/60 bg-primary/5" : "border-border hover:border-border/80 hover:bg-muted/30"
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="upload-zone"
    >
      <input ref={inputRef} type="file" multiple accept={ACCEPTED.join(",")} className="sr-only"
        data-testid="input-file-upload" onChange={(e) => upload(e.target.files)} />
      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-7 h-7 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Uploader…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.18)" }}>
            <Upload className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Træk filer hertil</p>
            <p className="text-xs text-muted-foreground mt-0.5">PDF, DOCX, TXT, CSV, PNG, JPG, WEBP, MP4 — op til 100 MB</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="text-xs"
            onClick={() => inputRef.current?.click()} data-testid="button-choose-files">
            Vælg filer
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Expert Link Panel ────────────────────────────────────────────────────────

function ExpertLinkPanel({ kbId, orgId }: { kbId: string; orgId?: string }) {
  const { toast } = useToast();
  const qc        = useQueryClient();
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);

  const { data: linked = [], isLoading: linkedLoading } = useQuery<LinkedExpert[]>({
    queryKey: ["/api/kb", kbId, "experts"],
    queryFn:  () => fetch(`/api/kb/${kbId}/experts`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.detail,
  });

  const { data: allExperts = [] } = useQuery<ExpertOption[]>({
    queryKey: ["/api/experts"],
    ...QUERY_POLICY.staticList,
    enabled: picking,
  });

  const linkedIds = new Set(linked.map((l) => l.expertId));
  const available = useMemo(() =>
    allExperts.filter((e) =>
      !linkedIds.has(e.id) &&
      (search === "" || e.name.toLowerCase().includes(search.toLowerCase()))
    ), [allExperts, linkedIds, search]);

  const linkMutation = useMutation({
    mutationFn: (expertId: string) => apiRequest("POST", `/api/kb/${kbId}/experts`, { expertId }),
    onSuccess: () => {
      toast({ title: "Ekspert tilknyttet" });
      qc.invalidateQueries({ queryKey: ["/api/kb", kbId, "experts"] });
      qc.invalidateQueries({ queryKey: ["/api/kb"] });
      setPicking(false);
      setSearch("");
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const unlinkMutation = useMutation({
    mutationFn: (expertId: string) =>
      fetch(`/api/kb/${kbId}/experts/${expertId}`, { method: "DELETE", credentials: "include" })
        .then((r) => { if (!r.ok && r.status !== 204) throw new Error("Fejl"); }),
    onSuccess: () => {
      toast({ title: "Ekspert fjernet" });
      qc.invalidateQueries({ queryKey: ["/api/kb", kbId, "experts"] });
      qc.invalidateQueries({ queryKey: ["/api/kb"] });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  return (
    <section data-testid="section-expert-links">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Link2 className="w-4 h-4 text-muted-foreground" />
          Tilknyttede AI eksperter
          {linked.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">({linked.length})</span>
          )}
        </h2>
        <Button
          variant="outline" size="sm" className="h-7 px-2.5 text-xs"
          onClick={() => setPicking((v) => !v)}
          data-testid="button-add-expert"
        >
          <Plus className="w-3 h-3 mr-1" />
          Tilknyt ekspert
        </Button>
      </div>

      {/* Picker */}
      {picking && (
        <div className="mb-3 rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <Input
              className="pl-7 h-7 text-xs"
              placeholder="Søg ekspert…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-expert-search"
              autoFocus
            />
          </div>
          {available.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              {allExperts.length === 0 ? "Ingen eksperter oprettet endnu" : "Alle eksperter er allerede tilknyttet"}
            </p>
          ) : (
            <div className="max-h-40 overflow-y-auto divide-y divide-border">
              {available.map((e) => (
                <button
                  key={e.id}
                  className="w-full flex items-center gap-2 px-2 py-2 hover:bg-muted/40 transition-colors text-left"
                  onClick={() => linkMutation.mutate(e.id)}
                  disabled={linkMutation.isPending}
                  data-testid={`expert-option-${e.id}`}
                >
                  <Brain className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium text-foreground">{e.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{e.status === "active" ? "Aktiv" : e.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Linked list */}
      {linkedLoading ? (
        <div className="space-y-1.5">{Array.from({length:2}).map((_,i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : linked.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/10 px-4 py-5 text-center">
          <p className="text-xs text-muted-foreground">
            Ingen eksperter tilknyttet endnu. Tilknyt en ekspert for at aktivere hentning fra denne datakilde.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
          {linked.map((l) => (
            <div key={l.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/20 transition-colors"
              data-testid={`linked-expert-${l.expertId}`}>
              <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                style={{ background: "rgba(99,102,241,0.10)", border: "1px solid rgba(99,102,241,0.15)" }}>
                <Brain className="w-3 h-3 text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">{l.expertName}</p>
                {l.expertSlug && <p className="text-xs text-muted-foreground font-mono">{l.expertSlug}</p>}
              </div>
              <Button
                variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={() => unlinkMutation.mutate(l.expertId)}
                disabled={unlinkMutation.isPending}
                data-testid={`unlink-expert-${l.expertId}`}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Asset list item ──────────────────────────────────────────────────────────

function AssetItem({ asset, kbId, onRetried }: { asset: AssetRow; kbId: string; onRetried: () => void }) {
  const { toast } = useToast();

  const retryMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/kb/${kbId}/assets/${asset.id}/retry`, { method: "POST", credentials: "include" })
        .then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Genbehandling startet" });
      onRetried();
    },
    onError: () => toast({ title: "Fejl", description: "Kunne ikke starte genbehandling", variant: "destructive" }),
  });

  const failureReason = asset.pipeline.find((j) => j.status === "failed")?.failureReason;

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors rounded-lg"
      data-testid={`asset-row-${asset.id}`}>
      <AssetTypeIcon type={asset.documentType} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{asset.title}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
          <span className="text-xs text-muted-foreground">{formatBytes(asset.fileSizeBytes)}</span>
          {asset.chunkCount > 0 && (
            <span className="text-xs text-muted-foreground">{asset.chunkCount} chunks</span>
          )}
          {asset.embeddingCount > 0 && (
            <span className="text-xs text-muted-foreground">{asset.embeddingCount} embeddings</span>
          )}
          <span className="text-xs text-muted-foreground">{relDate(asset.createdAt)}</span>
        </div>
        {failureReason && (
          <p className="text-xs text-rose-400 mt-1 line-clamp-1" title={failureReason}>
            Fejl: {failureReason}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <AssetStatusBadge status={asset.status} />
        {asset.status === "failed" && (
          <Button
            variant="ghost" size="sm" className="h-6 px-2 text-xs text-amber-400 hover:text-amber-300"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
            data-testid={`retry-asset-${asset.id}`}
          >
            {retryMutation.isPending
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <><RotateCcw className="w-3 h-3 mr-1" />Forsøg igen</>
            }
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StorageDetail() {
  usePagePerf("storage-detail");
  const params    = useParams();
  const [, navigate] = useLocation();
  const search    = useSearch();
  const qc        = useQueryClient();
  const { toast } = useToast();
  const kbId      = params.id ?? "";

  // Detect redirect from "just created" flow
  const isNew = new URLSearchParams(search).get("new") === "1";
  const [showNewBanner, setShowNewBanner] = useState(isNew);
  const uploadSectionRef = useRef<HTMLElement>(null);

  // Auto-scroll to upload zone when arriving from create flow
  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => {
      uploadSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 400);
    return () => clearTimeout(t);
  }, [isNew]);

  const [assetSearch, setAssetSearch]     = useState("");
  const [typeFilter,  setTypeFilter]      = useState("all");
  const [statusFilter, setStatusFilter]   = useState("all");
  const [assetSort,   setAssetSort]       = useState<"newest"|"oldest"|"name"|"status">("newest");
  const [showEdit, setShowEdit]           = useState(false);
  const [showFilters, setShowFilters]     = useState(false);

  const { data: kb, isLoading: kbLoading } = useQuery<KnowledgeBase>({
    queryKey: ["/api/kb", kbId],
    queryFn:  () => fetch(`/api/kb/${kbId}`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.detail,
    enabled: !!kbId,
  });

  const {
    data: assets,
    isLoading: assetsLoading,
    refetch: refetchAssets,
  } = useQuery<AssetRow[]>({
    queryKey: ["/api/kb", kbId, "assets"],
    queryFn:  () => fetch(`/api/kb/${kbId}/assets`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.semiLive,
    enabled: !!kbId,
    refetchInterval: 8000,
  });

  // ── Derived metrics ───────────────────────────────────────────────────────────
  const safeAssets: AssetRow[] = Array.isArray(assets) ? assets : [];

  const metrics = useMemo(() => ({
    total:      safeAssets.length,
    indexed:    safeAssets.filter((a) => ["indexed","ready"].includes(a.status)).length,
    processing: safeAssets.filter((a) => ["processing","queued","draft"].includes(a.status)).length,
    failed:     safeAssets.filter((a) => a.status === "failed").length,
  }), [safeAssets]);

  // ── Filtered + sorted assets ─────────────────────────────────────────────────
  const displayed = useMemo(() => {
    let list: AssetRow[] = [...safeAssets];
    if (assetSearch.trim()) {
      const q = assetSearch.toLowerCase();
      list = list.filter((a) => a.title.toLowerCase().includes(q));
    }
    if (typeFilter !== "all")   list = list.filter((a) => a.documentType === typeFilter);
    if (statusFilter !== "all") list = list.filter((a) => a.status === statusFilter);
    return list.sort((a, b) => {
      if (assetSort === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (assetSort === "name")   return a.title.localeCompare(b.title, "da");
      if (assetSort === "status") return a.status.localeCompare(b.status);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [safeAssets, assetSearch, typeFilter, statusFilter, assetSort]);

  const handleUploaded = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/kb", kbId, "assets"] });
    qc.invalidateQueries({ queryKey: ["/api/kb"] });
  }, [qc, kbId]);

  // ── Edit form ─────────────────────────────────────────────────────────────────
  const editForm = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: kb?.name ?? "", description: kb?.description ?? "" },
    values: { name: kb?.name ?? "", description: kb?.description ?? "" },
  });

  const editMutation = useMutation({
    mutationFn: (values: EditValues) => apiRequest("PATCH", `/api/kb/${kbId}`, values),
    onSuccess: () => {
      toast({ title: "Datakilde opdateret" });
      qc.invalidateQueries({ queryKey: ["/api/kb", kbId] });
      qc.invalidateQueries({ queryKey: ["/api/kb"] });
      setShowEdit(false);
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const archived = kb?.status === "archived";

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6" data-testid="page-storage-detail">

      {/* Breadcrumb */}
      <button
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => navigate("/storage")}
        data-testid="button-back"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Storage
      </button>

      {/* Source header */}
      {kbLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : kb ? (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)" }}>
                <Database className="w-4 h-4 text-amber-400" />
              </div>
              <h1 className="text-xl font-bold text-foreground">{kb.name}</h1>
              <HealthBadge assets={safeAssets} archived={archived} />
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-1 ml-10">{kb.slug}</p>
            {kb.description && (
              <p className="text-sm text-muted-foreground mt-2 ml-10">{kb.description}</p>
            )}
          </div>
          <Button
            variant="ghost" size="sm" className="h-8 px-2.5 text-xs shrink-0"
            onClick={() => setShowEdit(true)}
            data-testid="button-edit-source"
          >
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Rediger
          </Button>
        </div>
      ) : (
        <p className="text-sm text-destructive">Datakilde ikke fundet.</p>
      )}

      {/* Summary metrics */}
      {!assetsLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "Filer i alt",  value: metrics.total,      color: "text-foreground" },
            { label: "Indekseret",   value: metrics.indexed,    color: "text-green-400" },
            { label: "Behandler",    value: metrics.processing,  color: "text-sky-400" },
            { label: "Fejlet",       value: metrics.failed,     color: "text-rose-400" },
          ].map((m) => (
            <div key={m.label} className="rounded-lg border border-border bg-card px-3 py-2.5 text-center">
              <p className={`text-xl font-bold ${m.color}`}>{m.value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{m.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Upload */}
      {!archived && (
        <section ref={uploadSectionRef}>
          <h2 className="text-sm font-semibold text-foreground mb-3">Upload filer</h2>
          {showNewBanner && (
            <div className="mb-3 flex items-start gap-3 rounded-lg border border-sky-500/25 bg-sky-500/8 px-4 py-3"
              data-testid="banner-new-source">
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <p className="text-sm text-sky-300 flex-1">
                Datakilde oprettet. Upload første fil for at aktivere den.
              </p>
              <button
                className="text-sky-400/60 hover:text-sky-300 transition-colors"
                onClick={() => setShowNewBanner(false)}
                aria-label="Luk"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <UploadZone kbId={kbId} onUploaded={handleUploaded} />
        </section>
      )}

      {/* Asset list */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="text-sm font-semibold text-foreground">Filer</h2>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
              onClick={() => setShowFilters((v) => !v)} data-testid="button-toggle-filters">
              <SlidersHorizontal className="w-3 h-3 mr-1" />
              Filter
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
              onClick={() => refetchAssets()} data-testid="button-refresh-assets">
              <RefreshCw className="w-3 h-3 mr-1" />
              Opdater
            </Button>
          </div>
        </div>

        {/* Search + filters row */}
        <div className="space-y-2 mb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Søg på filnavn…"
              value={assetSearch}
              onChange={(e) => setAssetSearch(e.target.value)}
              data-testid="input-asset-search"
            />
          </div>
          {showFilters && (
            <div className="flex flex-wrap gap-2">
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-7 text-xs w-32" data-testid="select-type-filter">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle typer</SelectItem>
                  <SelectItem value="document">Dokumenter</SelectItem>
                  <SelectItem value="image">Billeder</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-7 text-xs w-36" data-testid="select-status-filter">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle status</SelectItem>
                  <SelectItem value="indexed">Indekseret</SelectItem>
                  <SelectItem value="processing">Behandler</SelectItem>
                  <SelectItem value="queued">I kø</SelectItem>
                  <SelectItem value="failed">Fejlet</SelectItem>
                </SelectContent>
              </Select>
              <Select value={assetSort} onValueChange={(v) => setAssetSort(v as any)}>
                <SelectTrigger className="h-7 text-xs w-40" data-testid="select-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Nyeste først</SelectItem>
                  <SelectItem value="oldest">Ældste først</SelectItem>
                  <SelectItem value="name">Navn A–Å</SelectItem>
                  <SelectItem value="status">Status</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {assetsLoading ? (
          <div className="space-y-2">{Array.from({length:3}).map((_,i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
        ) : displayed.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {safeAssets.length === 0
                ? "Ingen filer endnu — upload din første fil ovenfor."
                : `Ingen filer matcher dine filtre.`}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
            {displayed.map((a) => (
              <AssetItem key={a.id} asset={a} kbId={kbId} onRetried={() => {
                qc.invalidateQueries({ queryKey: ["/api/kb", kbId, "assets"] });
              }} />
            ))}
          </div>
        )}
      </section>

      {/* Expert linking */}
      <ExpertLinkPanel kbId={kbId} />

      {/* ── Edit dialog ─────────────────────────────────────────────────────────── */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4 text-amber-400" />
              Rediger datakilde
            </DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit((v) => editMutation.mutate(v))} className="space-y-4">
              <FormField control={editForm.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Navn</FormLabel>
                  <FormControl><Input data-testid="input-edit-name" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Slug</p>
                <p className="text-sm font-mono bg-muted/40 rounded px-3 py-2 text-muted-foreground">{kb?.slug}</p>
                <p className="text-xs text-muted-foreground">Slug kan ikke ændres efter oprettelse.</p>
              </div>
              <FormField control={editForm.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Beskrivelse</FormLabel>
                  <FormControl><Textarea rows={3} data-testid="input-edit-description" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowEdit(false)}>Annuller</Button>
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
