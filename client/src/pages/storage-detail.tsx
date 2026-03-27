/**
 * Storage Detail — /viden-data/:id
 *
 * Data source detail page: asset list, upload, expert linkage placeholder.
 */

import { useState, useRef, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Upload, FileText, Image, Video, File, Loader2,
  Database, CheckCircle2, Clock, AlertTriangle, RefreshCw,
  Link2, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { usePagePerf } from "@/lib/perf";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeBase {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AssetRow {
  id: string;
  title: string;
  documentType: string;
  status: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  versionNumber: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetTypeIcon({ type }: { type: string }) {
  const cls = "w-4 h-4 shrink-0";
  if (type === "image") return <Image className={`${cls} text-sky-400`} />;
  if (type === "video") return <Video className={`${cls} text-violet-400`} />;
  if (type === "document") return <FileText className={`${cls} text-amber-400`} />;
  return <File className={`${cls} text-muted-foreground`} />;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
    ready:      { label: "Klar",        cls: "text-green-400 border-green-500/30 bg-green-500/8",   icon: CheckCircle2 },
    processing: { label: "Behandler",   cls: "text-amber-400 border-amber-500/30 bg-amber-500/8",   icon: Clock },
    draft:      { label: "Uploading",   cls: "text-sky-400 border-sky-500/30 bg-sky-500/8",         icon: Loader2 },
    failed:     { label: "Fejlet",      cls: "text-rose-400 border-rose-500/30 bg-rose-500/8",      icon: AlertTriangle },
  };
  const meta = map[status] ?? { label: status, cls: "text-muted-foreground", icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`text-xs gap-1 ${meta.cls}`}>
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </Badge>
  );
}

// ─── Upload zone ──────────────────────────────────────────────────────────────

const ACCEPTED = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
];
const ACCEPT_STR = ACCEPTED.join(",");

function UploadZone({
  kbId,
  onUploaded,
}: {
  kbId: string;
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch(`/api/kb/${kbId}/upload`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          errors.push(`${file.name}: ${j.message ?? resp.statusText}`);
        }
      } catch (e) {
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
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  }, [upload]);

  return (
    <div
      className={`relative rounded-xl border-2 border-dashed transition-colors duration-150 px-6 py-8 text-center ${
        dragging
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-border/80 hover:bg-muted/30"
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="upload-zone"
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_STR}
        className="sr-only"
        data-testid="input-file-upload"
        onChange={(e) => upload(e.target.files)}
      />

      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Uploader...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.18)" }}
          >
            <Upload className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Træk filer hertil</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              PDF, DOCX, TXT, CSV, PNG, JPG, WEBP, MP4 — op til 100 MB
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => inputRef.current?.click()}
            data-testid="button-choose-files"
          >
            Vælg filer
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Asset row ────────────────────────────────────────────────────────────────

function AssetRow({ asset }: { asset: AssetRow }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors rounded-lg"
      data-testid={`asset-row-${asset.id}`}
    >
      <AssetTypeIcon type={asset.documentType} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{asset.title}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(asset.fileSizeBytes)} · v{asset.versionNumber} ·{" "}
          {new Date(asset.createdAt).toLocaleDateString("da-DK")}
        </p>
      </div>
      <StatusBadge status={asset.status} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StorageDetail() {
  usePagePerf("storage-detail");
  const [, params] = useRoute("/viden-data/:id");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const kbId = params?.id ?? "";

  const { data: kb, isLoading: kbLoading } = useQuery<KnowledgeBase>({
    queryKey: ["/api/kb", kbId],
    queryFn: () => fetch(`/api/kb/${kbId}`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.detail, // D: stable single-record read
    enabled: !!kbId,
  });

  const {
    data: assets,
    isLoading: assetsLoading,
    refetch: refetchAssets,
  } = useQuery<AssetRow[]>({
    queryKey: ["/api/kb", kbId, "assets"],
    queryFn: () => fetch(`/api/kb/${kbId}/assets`, { credentials: "include" }).then((r) => r.json()),
    ...QUERY_POLICY.semiLive,
    enabled: !!kbId,
    refetchInterval: 8000, // Poll every 8s for processing status updates
  });

  const handleUploaded = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/kb", kbId, "assets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
  }, [queryClient, kbId]);

  const documents = assets?.filter((a) => a.documentType === "document") ?? [];
  const images    = assets?.filter((a) => a.documentType === "image") ?? [];
  const videos    = assets?.filter((a) => a.documentType === "video") ?? [];
  const others    = assets?.filter((a) => !["document","image","video"].includes(a.documentType)) ?? [];

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6" data-testid="page-storage-detail">
      {/* Breadcrumb + header */}
      <div className="space-y-3">
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => navigate("/viden-data")}
          data-testid="button-back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Storage
        </button>

        {kbLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : kb ? (
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)" }}>
                  <Database className="w-4 h-4 text-amber-400" />
                </div>
                <h1 className="text-xl font-bold text-foreground">{kb.name}</h1>
                <Badge variant="outline" className="text-xs text-green-400 border-green-500/30 bg-green-500/8">Aktiv</Badge>
              </div>
              <p className="text-xs text-muted-foreground font-mono mt-1 ml-10">{kb.slug}</p>
              {kb.description && (
                <p className="text-sm text-muted-foreground mt-2 ml-10">{kb.description}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-foreground">{kb.assetCount}</p>
              <p className="text-xs text-muted-foreground">{kb.assetCount === 1 ? "fil" : "filer"}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-destructive">Datakilde ikke fundet.</p>
        )}
      </div>

      {/* Upload */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3">Upload filer</h2>
        <UploadZone kbId={kbId} onUploaded={handleUploaded} />
      </section>

      {/* Asset list */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Filer</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => refetchAssets()}
            data-testid="button-refresh-assets"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Opdater
          </Button>
        </div>

        {assetsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : !assets?.length ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">Ingen filer endnu — upload din første fil ovenfor.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
            {/* Documents */}
            {documents.length > 0 && (
              <>
                <div className="px-4 py-2 bg-muted/30 flex items-center gap-1.5">
                  <FileText className="w-3 h-3 text-amber-400" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Dokumenter ({documents.length})
                  </span>
                </div>
                {documents.map((a) => <AssetRow key={a.id} asset={a} />)}
              </>
            )}
            {/* Images */}
            {images.length > 0 && (
              <>
                <div className="px-4 py-2 bg-muted/30 flex items-center gap-1.5">
                  <Image className="w-3 h-3 text-sky-400" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Billeder ({images.length})
                  </span>
                </div>
                {images.map((a) => <AssetRow key={a.id} asset={a} />)}
              </>
            )}
            {/* Videos */}
            {videos.length > 0 && (
              <>
                <div className="px-4 py-2 bg-muted/30 flex items-center gap-1.5">
                  <Video className="w-3 h-3 text-violet-400" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Video ({videos.length})
                  </span>
                </div>
                {videos.map((a) => <AssetRow key={a.id} asset={a} />)}
              </>
            )}
            {/* Others */}
            {others.map((a) => <AssetRow key={a.id} asset={a} />)}
          </div>
        )}
      </section>

      {/* Expert linkage placeholder */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Link2 className="w-4 h-4 text-muted-foreground" />
          Tilknyttede AI eksperter
        </h2>
        <div className="rounded-lg border border-border bg-muted/10 px-4 py-5 text-center">
          <p className="text-xs text-muted-foreground">
            Tilknytning af AI eksperter til denne datakilde konfigureres i eksperten.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 text-xs"
            onClick={() => navigate("/ai-eksperter")}
            data-testid="button-go-to-experts"
          >
            Gå til AI Eksperter <ChevronRight className="w-3 h-3 ml-1" />
          </Button>
        </div>
      </section>
    </div>
  );
}
