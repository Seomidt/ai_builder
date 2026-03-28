import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Send, Bot, User, ChevronDown, ChevronUp, ShieldAlert, BookOpen,
  AlertTriangle, CheckCircle2, HelpCircle, Paperclip, X,
  FileText, Image, Video, Sparkles,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiRequest, apiRequestForm } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatSource { id: string; name: string; sourceType?: string }
interface ChatRule   { id: string; title: string }
type ConfidenceBand  = "high" | "medium" | "low" | "unknown";

interface ChatResponse {
  answer: string;
  document_validation?: string | null;
  conversation_id: string;
  expert: { id: string; name: string; category: string | null };
  source?: { type: "expert" | "system"; name?: string };
  used_sources: ChatSource[];
  used_rules: ChatRule[];
  warnings: string[];
  latency_ms: number;
  confidence_band: ConfidenceBand;
  needs_manual_review: boolean;
  routing_explanation: string;
}

interface AttachedFile {
  id: string;
  file: File;
  type: "document" | "image" | "video";
  status: "ready" | "uploading" | "processing" | "done" | "failed";
  previewUrl?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: AttachedFile[];
  response?: ChatResponse;
  timestamp: Date;
  isError?: boolean;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const MAX_SIZE_MB = 25;
const ACCEPT_DOCS  = ".pdf,.doc,.docx,.txt,.csv,.xlsx,.xls";
const ACCEPT_IMG   = "image/jpeg,image/png,image/gif,image/webp";
const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/x-msvideo";
const ACCEPT_ALL   = `${ACCEPT_DOCS},${ACCEPT_IMG},${ACCEPT_VIDEO}`;

function fileType(f: File): AttachedFile["type"] {
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("video/")) return "video";
  return "document";
}

function fileIcon(type: AttachedFile["type"]) {
  if (type === "image") return <Image className="w-3.5 h-3.5 text-blue-400" />;
  if (type === "video") return <Video className="w-3.5 h-3.5 text-purple-400" />;
  return <FileText className="w-3.5 h-3.5 text-primary" />;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Confidence Badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ band }: { band: ConfidenceBand }) {
  const map: Record<ConfidenceBand, { label: string; color: string; icon: typeof CheckCircle2 }> = {
    high:    { label: "Høj sikkerhed",    color: "text-green-400 border-green-400/30 bg-green-400/10",   icon: CheckCircle2  },
    medium:  { label: "Middel sikkerhed", color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10", icon: HelpCircle   },
    low:     { label: "Lav sikkerhed",    color: "text-red-400 border-red-400/30 bg-red-400/10",          icon: AlertTriangle },
    unknown: { label: "Ukendt",           color: "text-muted-foreground border-border bg-muted/20",       icon: HelpCircle   },
  };
  const { label, color, icon: Icon } = map[band];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", color)}>
      <Icon className="w-3 h-3" />{label}
    </span>
  );
}

// ─── Validation parser ────────────────────────────────────────────────────────

// Raw struct parsed from backend text
interface ParsedValidation {
  status: "ok" | "warning" | "review_required";
  code: string | null;       // classification code set by backend (LOW_CONFIDENCE, PARSE_ERROR, …)
  completeness_summary: string;
  trust_summary: string;
  issues: string[];
  recommendation: string;
}

function parseValidationText(text: string): ParsedValidation | null {
  if (!text.startsWith("**Valideringsstatus:**")) return null;
  const field = (label: string) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`);
    return (text.match(re)?.[1] ?? "").trim();
  };
  const statusRaw = field("Valideringsstatus");
  const status: ParsedValidation["status"] =
    statusRaw.includes("OK") ? "ok" :
    statusRaw.includes("Advarsel") ? "warning" :
    "review_required";
  const problemsRaw = field("Problemer");
  const issues = problemsRaw
    .split("\n")
    .map(l => l.replace(/^\s*[•·\-]\s*/, "").trim())
    .filter(l => l && !l.toLowerCase().includes("ingen problemer"));
  const codeRaw = field("ClassificationCode");
  return {
    status,
    code: codeRaw || null,
    completeness_summary: field("Fuldstændighed"),
    trust_summary: field("Troværdighed"),
    issues,
    recommendation: field("Anbefaling"),
  };
}

// ─── Validation view-model ────────────────────────────────────────────────────

interface ValidationCardViewModel {
  status: "ok" | "warning" | "review_required";
  summary: string;
  primaryAction: string;
  secondaryAction: string | null;
  trustText: string | null;
  issueItems: string[];
  detailsLabel: string;
}

function mapValidationToViewModel(parsed: ParsedValidation): ValidationCardViewModel {
  const issueItems = parsed.issues ?? [];
  const n = issueItems.length;
  const detailsLabel = n > 0 ? `Se detaljer (${n} ${n === 1 ? "forhold" : "forhold"})` : "Se detaljer";

  if (parsed.code === "LOW_CONFIDENCE") {
    return {
      status: "review_required",
      summary: "Dokumentet kan læses, men kan ikke verificeres som en officiel eller autentisk kilde.",
      primaryAction: "Send til manuel gennemgang",
      secondaryAction: null,
      trustText: parsed.trust_summary || null,
      issueItems,
      detailsLabel,
    };
  }

  if (parsed.code === "PARSE_ERROR") {
    return {
      status: "review_required",
      summary: "Dokumentet kunne ikke behandles pålideligt.",
      primaryAction: "Kontrollér dokumentets format",
      secondaryAction: "Send til manuel gennemgang",
      trustText: parsed.trust_summary || null,
      issueItems,
      detailsLabel,
    };
  }

  // Default: use raw AI result — backend is the source of truth
  return {
    status: parsed.status,
    summary: parsed.completeness_summary || "Dokumentet er behandlet.",
    primaryAction: parsed.recommendation || "Send til manuel gennemgang",
    secondaryAction: null,
    trustText: parsed.trust_summary || null,
    issueItems,
    detailsLabel,
  };
}

// ─── Validation Card ──────────────────────────────────────────────────────────

const VALIDATION_STATUS_CONFIG: Record<ValidationCardViewModel["status"], { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  ok:               { label: "Godkendt",         color: "text-green-400 border-green-400/30 bg-green-400/10",    Icon: CheckCircle2 },
  warning:          { label: "Advarsel",          color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10", Icon: AlertTriangle },
  review_required:  { label: "Kræver gennemgang", color: "text-red-400 border-red-400/30 bg-red-400/10",     Icon: ShieldAlert   },
};

function ValidationCard({ vm, warnings }: { vm: ValidationCardViewModel; warnings: string[] }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { label, color, Icon } = VALIDATION_STATUS_CONFIG[vm.status];
  const hasDetails = !!(vm.trustText || vm.issueItems.length > 0);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Dokumentvalidering</span>
        <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", color)}>
          <Icon className="w-3 h-3" />{label}
        </span>
      </div>

      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
        </div>
      ))}

      {/* Summary */}
      <p className="text-sm font-medium text-foreground leading-relaxed" data-testid="text-chat-answer">
        {vm.summary}
      </p>

      {/* Primary action — inline text button, no box, no icon */}
      <button className="mt-2 text-sm font-medium text-primary hover:underline text-left" data-testid="button-primary-action">
        → {vm.primaryAction}
      </button>

      {/* Secondary action — muted, smaller */}
      {vm.secondaryAction && (
        <p className="text-xs text-muted-foreground mt-1">
          {vm.secondaryAction}
        </p>
      )}

      {/* Details toggle */}
      {hasDetails && (
        <>
          <button
            onClick={() => setDetailsOpen(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            data-testid="button-toggle-details"
          >
            {detailsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {detailsOpen ? "Skjul detaljer" : vm.detailsLabel}
          </button>
          {detailsOpen && (
            <div className="mt-2 space-y-2 border-l-2 border-border/40 pl-3" data-testid="panel-chat-details">
              {vm.trustText && (
                <p className="text-xs text-muted-foreground">{vm.trustText}</p>
              )}
              {vm.issueItems.length > 0 && (
                <ul className="space-y-0.5">
                  {vm.issueItems.map((item, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5">•</span>{item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Status Badge (non-validation cards) ──────────────────────────────────────

function StatusBadge({ response }: { response: ChatResponse }) {
  if (response.needs_manual_review) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded-full px-2 py-0.5 font-medium">
        <ShieldAlert className="w-3 h-3" />Kræver gennemgang
      </span>
    );
  }
  if (response.confidence_band === "unknown" || response.confidence_band === "low") return null;
  return <ConfidenceBadge band={response.confidence_band} />;
}

// ─── Answer Card ──────────────────────────────────────────────────────────────

function AnswerCard({ response, text }: { response: ChatResponse; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isExpert = response.source?.type === "expert";

  // Ny arkitektur: document_validation-feltet bærer valideringsresultat separat fra svaret.
  // Legacy: text starter med "**Valideringsstatus:**" (gamle beskeder uden doc QA).
  const docValidation = response.document_validation
    ? parseValidationText(response.document_validation)
    : null;
  const legacyValidation = !docValidation ? parseValidationText(text) : null;

  // Legacy: kun validering, intet svar → vis kun ValidationCard
  if (legacyValidation) {
    return <ValidationCard vm={mapValidationToViewModel(legacyValidation)} warnings={response.warnings} />;
  }

  // Normal grounded Q&A card (med evt. validering ovenover)
  const hasDetails = response.used_sources.length > 0 || response.used_rules.length > 0;
  return (
    <div className="space-y-3">
      {/* Valideringskort — vises øverst når dokumentet er valideret */}
      {docValidation && (
        <ValidationCard vm={mapValidationToViewModel(docValidation)} warnings={[]} />
      )}

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {docValidation
              ? "Dokumentsvar"
              : isExpert
                ? (response.source?.name ?? response.expert.name)
                : "Systemsvar"}
          </span>
          <StatusBadge response={response} />
        </div>

        {response.warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
          </div>
        ))}

        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground" data-testid="text-chat-answer">
          {text}
        </div>

        {(hasDetails || response.used_sources.length > 0) && (
        <div className="flex items-center justify-between pt-0.5">
          {response.used_sources.length > 0 && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <BookOpen className="w-3 h-3 shrink-0" />
              {response.used_sources.slice(0, 2).map(s => s.name).join(", ")}
              {response.used_sources.length > 2 && ` +${response.used_sources.length - 2}`}
            </p>
          )}
          {hasDetails && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
              data-testid="button-toggle-details"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? "Skjul" : "Detaljer"}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-2 text-xs" data-testid="panel-chat-details">
          {response.expert.name && (
            <p className="text-muted-foreground">
              <span className="text-foreground/70 font-medium">Ekspert: </span>{response.expert.name}
              {response.expert.category && ` · ${response.expert.category}`}
            </p>
          )}
          {response.used_sources.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1">Kilder</p>
              {response.used_sources.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-foreground/80 mb-0.5">
                  <BookOpen className="w-3 h-3 text-primary/70 shrink-0" />{s.name}
                </div>
              ))}
            </div>
          )}
          {response.used_rules.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1">Regler</p>
              {response.used_rules.map(r => (
                <div key={r.id} className="flex items-center gap-2 text-foreground/80 mb-0.5">
                  <ShieldAlert className="w-3 h-3 text-primary/70 shrink-0" />{r.title}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Attachment Chip ──────────────────────────────────────────────────────────

function AttachmentChip({ file, onRemove }: { file: AttachedFile; onRemove?: () => void }) {
  const statusColors: Record<AttachedFile["status"], string> = {
    ready:      "border-border/60 bg-muted/30",
    uploading:  "border-yellow-400/30 bg-yellow-400/5",
    processing: "border-blue-400/30 bg-blue-400/5",
    done:       "border-green-400/30 bg-green-400/5",
    failed:     "border-red-400/30 bg-red-400/5",
  };
  const statusLabel: Record<AttachedFile["status"], string> = {
    ready: "", uploading: "Uploader…", processing: "Behandler…", done: "Klar", failed: "Fejl",
  };

  return (
    <div className={cn("flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs max-w-[200px]", statusColors[file.status])}>
      {fileIcon(file.type)}
      <span className="truncate text-foreground/80">{file.file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.file.size)}</span>
      {statusLabel[file.status] && (
        <span className="text-muted-foreground shrink-0">{statusLabel[file.status]}</span>
      )}
      {onRemove && file.status === "ready" && (
        <button onClick={onRemove} className="shrink-0 hover:text-red-400 transition-colors" data-testid="button-remove-attachment">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="mb-6 last:mb-0 flex justify-end" data-testid={`msg-user-${msg.id}`}>
        <div className="flex items-end gap-2 max-w-[80%]">
          <div className="space-y-1.5">
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {msg.attachments.map(a => <AttachmentChip key={a.id} file={a} />)}
              </div>
            )}
            <div className="bg-primary/15 border border-primary/20 rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-foreground">
              {msg.text}
            </div>
          </div>
          <div className="shrink-0 w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center mb-0.5">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 last:mb-0 flex justify-start" data-testid={`msg-assistant-${msg.id}`}>
      <div className="flex items-end gap-2 max-w-[88%]">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center mb-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className={cn(
          "rounded-2xl border bg-card px-4 py-3 shadow-sm rounded-bl-sm",
          msg.isError && "border-red-400/30 bg-red-400/5"
        )}>
          {msg.isError ? (
            <div className="flex items-start gap-2 text-sm text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{msg.text}
            </div>
          ) : msg.response ? (
            <AnswerCard response={msg.response} text={msg.text} />
          ) : (
            <p className="text-sm text-foreground">{msg.text}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="mb-6 flex justify-start">
      <div className="flex items-end gap-2">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="rounded-2xl border bg-card px-4 py-3 shadow-sm rounded-bl-sm flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center text-center gap-1.5" data-testid="empty-state-chat">
      <h2 className="text-base font-semibold text-foreground tracking-tight">
        Hvad vil du analysere?
      </h2>
      <p className="text-sm text-muted-foreground/60 max-w-xs">
        Stil et spørgsmål eller upload et dokument for at komme i gang.
      </p>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiChatPage() {
  const { toast } = useToast();
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [attachments, setAttachments]     = useState<AttachedFile[]>([]);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── File picker ──────────────────────────────────────────────────────────────

  const openPicker = useCallback(() => {
    setTimeout(() => fileInputRef.current?.click(), 0);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const tooBig = files.filter(f => f.size > MAX_SIZE_MB * 1024 * 1024);
    if (tooBig.length) {
      toast({ title: "Fil for stor", description: `Maksimum størrelse er ${MAX_SIZE_MB} MB.`, variant: "destructive" });
    }
    const valid = files.filter(f => f.size <= MAX_SIZE_MB * 1024 * 1024);
    const newFiles: AttachedFile[] = valid.map(f => ({
      id: crypto.randomUUID(),
      file: f,
      type: fileType(f),
      status: "ready",
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
    }));
    setAttachments(prev => [...prev, ...newFiles]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const a = prev.find(x => x.id === id);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter(x => x.id !== id);
    });
  };

  // ── Send ─────────────────────────────────────────────────────────────────────

  const chatMutation = useMutation({
    mutationFn: async (payload: { text: string; attachments: AttachedFile[]; useCase?: string }) => {
      const traceId = crypto.randomUUID().slice(0, 8);

      // ── TRACE STAGE 1: FRONTEND SEND ─────────────────────────────────────
      const docFiles = payload.attachments.filter(a => a.type === "document");
      const imgFiles = payload.attachments.filter(a => a.type === "image");
      console.log(`[TRACE-1][${traceId}] use_case="${payload.useCase ?? "grounded_chat"}" attachments_total=${payload.attachments.length} doc_files=${docFiles.length} img_files=${imgFiles.length} names=[${docFiles.map(a=>a.file.name).join(",")}]`);

      // ── Step A: Ekstraher dokumentindhold ──────────────────────────────────
      let documentContext: any[] = [];

      if (docFiles.length > 0) {
        const form = new FormData();
        docFiles.forEach(a => form.append("file", a.file, a.file.name));
        try {
          console.log(`[TRACE-2a][${traceId}] calling /api/extract for ${docFiles.length} file(s)`);
          const extractRes = await apiRequestForm("POST", "/api/extract", form);
          console.log(`[TRACE-2b][${traceId}] extract HTTP status=${extractRes.status}`);
          if (!extractRes.ok) {
            console.error(`[HARD-STOP][${traceId}] EXTRACT_FAILED HTTP ${extractRes.status}`);
            throw Object.assign(new Error("Dokument kunne ikke læses."), { errorCode: "DOCUMENT_UNREADABLE" });
          }
          const extractData = await extractRes.json() as { results: any[] };
          documentContext = extractData.results ?? [];
          console.log(`[TRACE-2c][${traceId}] extract results=${documentContext.length} statuses=[${documentContext.map((r:any)=>r.status).join(",")}] chars=[${documentContext.map((r:any)=>r.extracted_text?.length??0).join(",")}]`);
          if (documentContext.length > 0) {
            console.log(`[TRACE-2d][${traceId}] first200="${(documentContext[0] as any).extracted_text?.slice(0,200)?.replace(/\n/g," ")}"`);
          }
          // HARD STOP: extract returnerede 0 gyldige dokumenter
          const validEntries = documentContext.filter((r: any) => r.status === "ok" && r.extracted_text?.trim());
          if (validEntries.length === 0) {
            console.error(`[HARD-STOP][${traceId}] DOCUMENT_CONTEXT_MISSING: 0 valid entries after extract`);
            throw Object.assign(new Error("Dokument kunne ikke læses."), { errorCode: "DOCUMENT_UNREADABLE" });
          }
        } catch (e: any) {
          if (e?.errorCode) throw e; // re-throw hard-stops
          console.error(`[HARD-STOP][${traceId}] EXTRACT_FAILED:`, e);
          throw Object.assign(new Error("Dokument kunne ikke læses."), { errorCode: "DOCUMENT_UNREADABLE" });
        }
      } else {
        console.log(`[TRACE-2-SKIP][${traceId}] no doc files — skipping extract`);
      }

      // ── Step B: Byg besked-tekst ───────────────────────────────────────────
      const fullMessage = payload.text || "Analysér venligst det uploadede dokument.";

      // ── TRACE STAGE 3: CHAT REQUEST ───────────────────────────────────────
      console.log(`[TRACE-3][${traceId}] sending /api/chat message_len=${fullMessage.length} document_context_len=${documentContext.length}`);

      // ── Step C: Send til /api/chat med dokument-kontekst ───────────────────
      const res = await apiRequest("POST", "/api/chat", {
        message: fullMessage,
        conversation_id: conversationId ?? null,
        document_context: documentContext,
        context: {
          document_ids: [],
          preferred_expert_id: null,
          attachment_count: payload.attachments.length,
          attachment_types: Array.from(new Set(payload.attachments.map(a => a.type))),
          use_case: (payload.useCase ?? "grounded_chat") as any,
        },
        _trace_id: traceId,
      });
      const data = await res.json() as ChatResponse & { _trace?: any };

      // ── TRACE STAGE 5: SERVER RESPONSE ────────────────────────────────────
      console.log(`[TRACE-5][${traceId}] server _trace:`, JSON.stringify((data as any)._trace ?? "none"));
      console.log(`[TRACE-5][${traceId}] final_answer_first100="${data.answer?.slice(0,100)}"`);

      return data;
    },
    onSuccess: (data) => {
      setConversationId(data.conversation_id);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.answer,
        response: data,
        timestamp: new Date(),
      }]);
    },
    onError: (err: any) => {
      const code = err?.errorCode ?? err?.code ?? "";
      const serverMsg = err?.message ?? "";

      // Business blocks — render as normal assistant message, no red toast
      const businessBlockMsg =
        code === "DOCUMENT_REQUIRED" || serverMsg.includes("DOCUMENT_REQUIRED")
          ? "Du skal uploade et dokument for at kunne validere."
          : code === "NO_INTERNAL_DATA" || serverMsg.includes("NO_INTERNAL_DATA")
          ? "Jeg kan ikke finde det i jeres interne data."
          : null;

      if (businessBlockMsg) {
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: businessBlockMsg, timestamp: new Date() }]);
        return;
      }

      // Real errors — show red toast
      const msg = code === "NO_EXPERTS_AVAILABLE" || serverMsg.includes("NO_EXPERTS_AVAILABLE")
        ? "Ingen AI-eksperter er tilgængelige. Aktivér mindst én ekspert til chat i indstillingerne."
        : code === "NO_RELEVANT_EXPERT" || serverMsg.includes("NO_RELEVANT_EXPERT")
        ? "Ingen relevant ekspert fundet. Prøv at omformulere dit spørgsmål."
        : code === "AI_EXECUTION_FAILED"
        ? "AI-eksperten kunne ikke svare i øjeblikket. Prøv igen om lidt."
        : code === "UNAUTHENTICATED"
        ? "Du er ikke logget ind. Genindlæs siden og log ind igen."
        : code === "DOCUMENT_UNREADABLE" || code === "DOCUMENT_CONTEXT_MISSING"
        ? "Dokument kunne ikke læses."
        : serverMsg || "Der opstod en fejl. Prøv igen.";
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: msg, timestamp: new Date(), isError: true }]);
      toast({ title: "Chat fejl", description: msg, variant: "destructive" });
    },
  });

  const handleSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chatMutation.isPending) return;
    const displayText = text || (attachments.length === 1 ? `[${attachments[0].file.name}]` : `[${attachments.length} filer vedhæftet]`);
    // Dokument-upload → grounded_chat: svarer spørgsmål direkte fra dokumentindholdet.
    // "validation" bruges kun hvis eksperten eksplicit er en valideringsekspert.
    const useCase = "grounded_chat";
    console.log(`[TRACE-SEND] use_case="${useCase}" attachments=${attachments.length}`);
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: "user",
      text: displayText,
      attachments: [...attachments],
      timestamp: new Date(),
    }]);
    chatMutation.mutate({ text: text || "Analysér venligst det uploadede dokument.", attachments, useCase });
    setInput("");
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const isEmpty = messages.length === 0 && !chatMutation.isPending;
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !chatMutation.isPending;

  return (
    <div className="flex flex-col h-full" data-testid="page-ai-chat">

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_ALL}
        className="hidden"
        onChange={handleFileChange}
        data-testid="input-file-upload"
      />

      {/* Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border/40 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
          style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}>
          <Sparkles className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-medium text-foreground">AI Ekspert</h1>
          <p className="text-xs text-muted-foreground/60 truncate">Få svar baseret på jeres egne data, dokumenter og regler.</p>
        </div>
        {conversationId && (
          <Badge variant="outline" className="ml-auto shrink-0 text-xs text-muted-foreground">Aktiv samtale</Badge>
        )}
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl sm:max-w-4xl min-h-full flex flex-col">
          {isEmpty ? (
            <div className="flex-1 flex items-center justify-center py-8 -translate-y-[10%]">
              <EmptyState />
            </div>
          ) : (
            <div className="pt-6">
              {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
              {chatMutation.isPending && <TypingIndicator />}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer area */}
      <div className="shrink-0 border-t border-border px-4 pt-3" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-3xl sm:max-w-4xl space-y-2">

          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1" data-testid="attachment-preview-area">
              {attachments.map(a => (
                <AttachmentChip key={a.id} file={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
          )}

          {/* Input row — crisp enterprise style */}
          <div className="flex items-center gap-1.5 bg-background border border-foreground/12 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/40 transition-all shadow-sm">
            <button
              onClick={() => openPicker()}
              disabled={chatMutation.isPending}
              data-testid="button-attach-file"
              className="shrink-0 h-8 w-8 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted transition-all disabled:opacity-30"
              title="Vedhæft fil"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <Textarea
              id="chat-input"
              placeholder="Stil et spørgsmål eller upload et dokument…"
              className="flex-1 min-h-[36px] max-h-[140px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm placeholder:text-muted-foreground/40 py-1.5 px-1"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={chatMutation.isPending}
              data-testid="input-chat-message"
            />

            <button
              onClick={handleSend}
              disabled={!canSend}
              data-testid="button-chat-send"
              className={cn(
                "shrink-0 h-8 w-8 flex items-center justify-center rounded transition-all",
                canSend
                  ? "text-primary hover:bg-primary/10"
                  : "text-muted-foreground/30 cursor-not-allowed"
              )}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-muted-foreground/30 text-center">
            Understøtter dokumenter, billeder og tekst · Max {MAX_SIZE_MB} MB
          </p>

        </div>{/* /max-w */}
      </div>
    </div>
  );
}
