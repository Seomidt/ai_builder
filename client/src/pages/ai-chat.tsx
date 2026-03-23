import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Send, Bot, User, ChevronDown, ChevronUp, ShieldAlert, BookOpen,
  AlertTriangle, Clock, CheckCircle2, HelpCircle, Paperclip, X,
  FileText, Image, Video, Zap, Search, BarChart3, Shield, MessageSquare,
  ArrowRight, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatSource { id: string; name: string; sourceType?: string }
interface ChatRule   { id: string; title: string }
type ConfidenceBand  = "high" | "medium" | "low" | "unknown";

interface ChatResponse {
  answer: string;
  conversation_id: string;
  expert: { id: string; name: string; category: string | null };
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

// ─── Answer Card ──────────────────────────────────────────────────────────────

function AnswerCard({ response, text }: { response: ChatResponse; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = response.used_sources.length > 0 || response.used_rules.length > 0 || response.warnings.length > 0;

  return (
    <div className="space-y-3">
      {/* Expert + confidence row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary bg-primary/10 border border-primary/20 rounded-full px-2.5 py-1">
          <Sparkles className="w-3 h-3" />
          Svar fra: {response.expert.name}
        </span>
        <ConfidenceBadge band={response.confidence_band} />
        {response.needs_manual_review && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded-full px-2 py-0.5 font-medium">
            <ShieldAlert className="w-3 h-3" />
            Kræver manuel gennemgang
          </span>
        )}
      </div>

      {/* Baseret på */}
      {response.used_sources.length > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <BookOpen className="w-3 h-3 shrink-0" />
          Baseret på: {response.used_sources.slice(0, 2).map(s => s.name).join(", ")}
          {response.used_sources.length > 2 && ` +${response.used_sources.length - 2} mere`}
        </p>
      )}

      {/* Warnings */}
      {response.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
        </div>
      ))}

      {/* Answer */}
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground" data-testid="text-chat-answer">
        {text}
      </div>

      {/* Anbefaling */}
      {response.needs_manual_review && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
          <ArrowRight className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
          <p className="text-xs text-foreground/80">
            <span className="font-medium text-primary">Anbefaling:</span> Send til manuel gennemgang af relevant sagsbehandler.
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {response.used_sources.length > 0 && (
            <span className="flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              {response.used_sources.length} {response.used_sources.length === 1 ? "kilde" : "kilder"}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />{response.latency_ms}ms
          </span>
        </div>
        {hasDetails && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-toggle-details"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Skjul detaljer" : "Se detaljer"}
          </button>
        )}
      </div>

      {/* Details panel */}
      {expanded && (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-3 text-xs" data-testid="panel-chat-details">
          <div className="space-y-0.5 text-muted-foreground">
            <p><span className="text-foreground/70 font-medium">Valgt ekspert:</span> {response.expert.name}</p>
            {response.expert.category && <p><span className="text-foreground/70 font-medium">Domæne:</span> {response.expert.category}</p>}
            {response.routing_explanation && <p><span className="text-foreground/70 font-medium">Udvælgelse:</span> {response.routing_explanation}</p>}
          </div>
          {response.used_sources.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1.5">Kilder brugt</p>
              {response.used_sources.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-foreground/80 mb-1">
                  <BookOpen className="w-3 h-3 text-primary/70 shrink-0" />{s.name}
                </div>
              ))}
            </div>
          )}
          {response.used_rules.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1.5">Vigtige forhold</p>
              {response.used_rules.map(r => (
                <div key={r.id} className="flex items-center gap-2 text-foreground/80 mb-1">
                  <ShieldAlert className="w-3 h-3 text-primary/70 shrink-0" />{r.title}
                </div>
              ))}
            </div>
          )}
          <div className="pt-1 border-t border-border/40 text-muted-foreground">
            Svartid: {response.latency_ms}ms
          </div>
        </div>
      )}
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
      <div className="flex justify-end" data-testid={`msg-user-${msg.id}`}>
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
    <div className="flex justify-start" data-testid={`msg-assistant-${msg.id}`}>
      <div className="flex items-end gap-2 max-w-[88%]">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center mb-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <Card className={cn("border-border/60 bg-card rounded-2xl rounded-bl-sm", msg.isError && "border-red-400/30 bg-red-400/5")}>
          <CardContent className="p-4">
            {msg.isError ? (
              <div className="flex items-start gap-2 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{msg.text}
              </div>
            ) : msg.response ? (
              <AnswerCard response={msg.response} text={msg.text} />
            ) : (
              <p className="text-sm text-foreground">{msg.text}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-end gap-2">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <Card className="border-border/60 bg-card rounded-2xl rounded-bl-sm">
          <CardContent className="p-3 flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  "Hvad dækker vores bilforsikring ved stenslag?",
  "Er denne dokumentation tilstrækkelig?",
  "Hvilke regler gælder for denne sag?",
  "Lav en analyse af denne måneds regnskab",
  "Find lignende tidligere sager",
];

const CAPABILITY_CARDS = [
  { icon: MessageSquare, label: "Besvar spørgsmål",     desc: "Fra dokumenter og politikker" },
  { icon: Shield,        label: "Dokumentvalidering",   desc: "Tjek ægthed og fuldstændighed" },
  { icon: BarChart3,     label: "Regnskabsanalyse",     desc: "Tal, afvigelser og tendenser" },
  { icon: Search,        label: "Find lignende sager",  desc: "Sammenlign med tidligere sager" },
];

function EmptyState({ onPrompt }: { onPrompt: (p: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 py-8 px-4" data-testid="empty-state-chat">
      {/* Header */}
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
        style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
      >
        <Sparkles className="w-7 h-7 text-primary" />
      </div>
      <h2 className="text-xl font-bold text-foreground mb-1 tracking-tight">AI Ekspert</h2>
      <p className="text-sm text-muted-foreground mb-2 max-w-sm text-center">
        Få svar baseret på jeres egne data, dokumenter og regler.
      </p>
      <div className="flex items-center gap-4 text-xs text-muted-foreground/70 mb-7">
        <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-400" />Svar baseres på jeres egne data</span>
        <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-400" />Følger jeres regler og politikker</span>
      </div>

      {/* Capability cards */}
      <div className="grid grid-cols-2 gap-2 w-full max-w-md mb-7">
        {CAPABILITY_CARDS.map((c) => (
          <div key={c.label} className="flex items-start gap-2.5 p-3 rounded-xl border border-border/60 bg-card/40">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <c.icon className="w-3.5 h-3.5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">{c.label}</p>
              <p className="text-xs text-muted-foreground">{c.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Upload hint */}
      <p className="text-xs text-muted-foreground/60 mb-4 flex items-center gap-1.5">
        <Paperclip className="w-3 h-3" />
        Vedhæft dokumenter, billeder eller video til din besked
      </p>

      {/* Example prompts */}
      <div className="w-full max-w-md space-y-1.5">
        <p className="text-xs text-muted-foreground font-medium mb-2">Prøv f.eks.:</p>
        {EXAMPLE_PROMPTS.map((ex, i) => (
          <button
            key={i}
            className="w-full text-xs text-left px-3.5 py-2.5 rounded-xl border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-primary/5 transition-all flex items-center justify-between group"
            data-testid={`suggestion-${i}`}
            onClick={() => onPrompt(ex)}
          >
            {ex}
            <ArrowRight className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-primary" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Quick Actions ────────────────────────────────────────────────────────────

interface QuickAction {
  label: string;
  icon: typeof Zap;
  prefill?: string;
  openPicker?: "document" | "image" | "video" | "any";
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Stil spørgsmål",      icon: MessageSquare, prefill: "" },
  { label: "Upload dokument",     icon: FileText,      openPicker: "document" },
  { label: "Upload billede",      icon: Image,         openPicker: "image" },
  { label: "Upload video",        icon: Video,         openPicker: "video" },
  { label: "Dokumentvalidering",  icon: Shield,        prefill: "Valider venligst dette dokument for ægthed og fuldstændighed." },
  { label: "Find lignende sager", icon: Search,        prefill: "Find lignende sager baseret på følgende beskrivelse: " },
  { label: "Regnskabsanalyse",    icon: BarChart3,     prefill: "Lav en analyse af det vedhæftede regnskabsmateriale med fokus på afvigelser og kontrolpunkter." },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiChatPage() {
  const { toast } = useToast();
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [attachments, setAttachments]     = useState<AttachedFile[]>([]);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileAccept, setFileAccept]       = useState(ACCEPT_ALL);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── File picker ──────────────────────────────────────────────────────────────

  const openPicker = useCallback((accept: string) => {
    setFileAccept(accept);
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
    mutationFn: async (payload: { text: string; attachments: AttachedFile[] }) => {
      let fullMessage = payload.text;
      if (payload.attachments.length > 0) {
        const fileList = payload.attachments.map(a => `[${a.type === "document" ? "Dokument" : a.type === "image" ? "Billede" : "Video"}: ${a.file.name}]`).join(", ");
        fullMessage = `${fullMessage}\n\nVedhæftede filer: ${fileList}`;
      }
      const res = await apiRequest("POST", "/api/chat", {
        message: fullMessage,
        conversation_id: conversationId ?? null,
        context: {
          document_ids: [],
          preferred_expert_id: null,
          attachment_count: payload.attachments.length,
          attachment_types: Array.from(new Set(payload.attachments.map(a => a.type))),
        },
      });
      return res.json() as Promise<ChatResponse>;
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
      const raw = err?.message ?? "";
      const msg = raw.includes("NO_EXPERTS_AVAILABLE")
        ? "Ingen AI-eksperter er opsat for din organisation endnu."
        : raw.includes("NO_RELEVANT_EXPERT")
        ? "Ingen relevant ekspert fundet. Prøv at omformulere dit spørgsmål."
        : "Der opstod en fejl ved behandling af din besked. Prøv igen.";
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: msg, timestamp: new Date(), isError: true }]);
      toast({ title: "Chat fejl", description: msg, variant: "destructive" });
    },
  });

  const handleSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chatMutation.isPending) return;
    const displayText = text || (attachments.length === 1 ? `[${attachments[0].file.name}]` : `[${attachments.length} filer vedhæftet]`);
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: "user",
      text: displayText,
      attachments: [...attachments],
      timestamp: new Date(),
    }]);
    chatMutation.mutate({ text: text || "Analyser venligst de vedhæftede filer.", attachments });
    setInput("");
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handlePrompt = (text: string) => {
    setInput(text);
    setTimeout(() => document.getElementById("chat-input")?.focus(), 50);
  };

  const handleQuickAction = (action: QuickAction) => {
    if (action.openPicker) {
      const accept = action.openPicker === "document" ? ACCEPT_DOCS
        : action.openPicker === "image" ? ACCEPT_IMG
        : action.openPicker === "video" ? ACCEPT_VIDEO
        : ACCEPT_ALL;
      openPicker(accept);
      return;
    }
    if (action.prefill !== undefined) handlePrompt(action.prefill);
  };

  const isEmpty = messages.length === 0 && !chatMutation.isPending;
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !chatMutation.isPending;

  return (
    <div className="flex flex-col h-full max-h-screen" data-testid="page-ai-chat">

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={fileAccept}
        className="hidden"
        onChange={handleFileChange}
        data-testid="input-file-upload"
      />

      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border/60 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}>
          <Sparkles className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-foreground tracking-tight">AI Ekspert</h1>
          <p className="text-xs text-muted-foreground truncate">Få svar baseret på jeres egne data, dokumenter og regler.</p>
        </div>
        {conversationId && (
          <Badge variant="outline" className="ml-auto shrink-0 text-xs text-muted-foreground">Aktiv samtale</Badge>
        )}
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {isEmpty ? (
          <EmptyState onPrompt={handlePrompt} />
        ) : (
          <>
            {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
            {chatMutation.isPending && <TypingIndicator />}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer area */}
      <div className="shrink-0 border-t border-border/40 px-4 pt-3 pb-4 space-y-2">

        {/* Quick actions */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => handleQuickAction(action)}
              disabled={chatMutation.isPending}
              data-testid={`quick-action-${action.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-all",
                "text-muted-foreground border-border/60 hover:text-foreground hover:border-primary/40 hover:bg-primary/5",
                "disabled:opacity-40 disabled:cursor-not-allowed"
              )}
            >
              <action.icon className="w-3 h-3" />
              {action.label}
            </button>
          ))}
        </div>

        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1" data-testid="attachment-preview-area">
            {attachments.map(a => (
              <AttachmentChip key={a.id} file={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-2 bg-card border border-border/60 rounded-2xl p-2 focus-within:border-primary/40 transition-colors">
          {/* Attachment button */}
          <button
            onClick={() => openPicker(ACCEPT_ALL)}
            disabled={chatMutation.isPending}
            data-testid="button-attach-file"
            className="shrink-0 h-9 w-9 flex items-center justify-center rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-40"
            title="Vedhæft fil"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <Textarea
            id="chat-input"
            placeholder="Stil et spørgsmål, eller vedhæft et dokument…"
            className="flex-1 min-h-[44px] max-h-[160px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm placeholder:text-muted-foreground/60 py-2 px-1"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={chatMutation.isPending}
            data-testid="input-chat-message"
          />

          <Button
            size="icon"
            className="shrink-0 h-9 w-9 rounded-xl"
            onClick={handleSend}
            disabled={!canSend}
            data-testid="button-chat-send"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>

        <p className="text-xs text-muted-foreground/40 text-center">
          Enter sender · Shift+Enter for ny linje · Max {MAX_SIZE_MB} MB pr. fil
        </p>
      </div>
    </div>
  );
}
