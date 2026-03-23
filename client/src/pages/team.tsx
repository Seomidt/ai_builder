/**
 * Team — Tenant Product Page
 *
 * Manage members, departments, roles and access permissions.
 * Tenant admin can invite users and configure granular access control.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Users2, UserPlus, Shield, Building, MoreHorizontal,
  ChevronLeft, ChevronRight, Check, Lock, Unlock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { useAuth } from "@/hooks/use-auth";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  role: string;
  userId: string | null;
  email: string | null;
  fullName: string | null;
  joinedAt: string;
  tenantRole?: string;
  departments?: string[];
  canAccessAllDepartments?: boolean;
  allowedSectionKeys?: string[];
}

interface TeamResponse {
  members: Member[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
  retrievedAt: string;
}

interface Department {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  memberCount?: number;
}

interface DeptResponse {
  departments: Department[];
}

// ── Config ────────────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<string, { label: string; color: string; border: string; bg: string }> = {
  owner:        { label: "Ejer",          color: "text-primary",    border: "border-primary/25",    bg: "bg-primary/10" },
  tenant_admin: { label: "Tenant Admin",  color: "text-amber-400",  border: "border-amber-500/25",  bg: "bg-amber-500/10" },
  admin:        { label: "Admin",         color: "text-secondary",  border: "border-secondary/25",  bg: "bg-secondary/10" },
  manager:      { label: "Manager",       color: "text-blue-400",   border: "border-blue-500/25",   bg: "bg-blue-500/10" },
  member:       { label: "Medlem",        color: "text-slate-300",  border: "border-slate-600/30",  bg: "bg-slate-500/10" },
  viewer:       { label: "Viewer",        color: "text-slate-400",  border: "border-slate-600/30",  bg: "bg-slate-500/8" },
};

const SECTIONS = [
  { key: "ai-eksperter", label: "AI Eksperter" },
  { key: "viden-data",   label: "Viden & Data" },
  { key: "regler",       label: "Regler" },
  { key: "koerseler",    label: "Kørseler" },
  { key: "team",         label: "Team" },
  { key: "workspace",    label: "Workspace" },
];

const PRESET_DEPARTMENTS = ["Salg", "Marketing", "Support", "Compliance", "Drift", "Claims", "Ledelse"];

// ── Sub-components ────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_CONFIG[role] ?? ROLE_CONFIG.member;
  return (
    <Badge variant="outline" className={`text-xs ${cfg.color} ${cfg.border} ${cfg.bg}`}>
      {cfg.label}
    </Badge>
  );
}

function MemberCard({ member, onEdit }: { member: Member; onEdit: (m: Member) => void }) {
  const initials = member.email ? member.email.slice(0, 2).toUpperCase() : "??";
  const sections = member.allowedSectionKeys ?? [];
  const hasFullAccess = member.canAccessAllDepartments;

  return (
    <Card
      data-testid={`member-card-${member.id}`}
      className="bg-card border-card-border hover:border-primary/20 transition-colors"
    >
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-primary shrink-0"
            style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.25)" }}
          >
            {initials}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
              <span className="text-sm font-semibold text-card-foreground truncate">
                {member.fullName || member.email || "Inviteret"}
              </span>
              <RoleBadge role={member.tenantRole ?? member.role} />
            </div>
            {member.email && (
              <p className="text-xs text-muted-foreground truncate mb-2">{member.email}</p>
            )}

            {/* Access summary */}
            <div className="flex flex-wrap gap-1.5">
              {hasFullAccess ? (
                <span className="flex items-center gap-1 text-[10px] text-green-400/70 bg-green-500/8 border border-green-500/20 px-1.5 py-0.5 rounded">
                  <Unlock className="w-2.5 h-2.5" /> Fuld adgang
                </span>
              ) : sections.length > 0 ? (
                sections.slice(0, 3).map((sk) => {
                  const s = SECTIONS.find((x) => x.key === sk);
                  return (
                    <span key={sk} className="text-[10px] text-muted-foreground/60 bg-muted/30 border border-white/5 px-1.5 py-0.5 rounded">
                      {s?.label ?? sk}
                    </span>
                  );
                })
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-slate-400/60">
                  <Lock className="w-2.5 h-2.5" /> Standard adgang
                </span>
              )}
              {(member.departments ?? []).length > 0 && (
                <span className="text-[10px] text-muted-foreground/50">
                  · {member.departments!.join(", ")}
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreHorizontal className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(member)}>
                Rediger adgang
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}

function DeptCard({ dept }: { dept: Department }) {
  return (
    <Card data-testid={`dept-card-${dept.id}`} className="bg-card border-card-border">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/8 border border-primary/15 shrink-0">
            <Building className="w-3.5 h-3.5 text-primary/60" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-card-foreground">{dept.name}</p>
            {dept.description && (
              <p className="text-xs text-muted-foreground truncate">{dept.description}</p>
            )}
          </div>
          {dept.memberCount !== undefined && (
            <span className="ml-auto text-xs text-muted-foreground/50 shrink-0">
              {dept.memberCount} {dept.memberCount === 1 ? "medlem" : "medlemmer"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Invite Dialog ─────────────────────────────────────────────────────────────

function InviteDialog({
  open,
  onOpenChange,
  departments,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  departments: Department[];
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [tenantRole, setTenantRole] = useState("member");
  const [selectedDepts, setSelectedDepts] = useState<string[]>([]);
  const [fullAccess, setFullAccess] = useState(false);
  const [selectedSections, setSelectedSections] = useState<string[]>(
    SECTIONS.map((s) => s.key),
  );

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/tenant/team/invite", {
        email,
        role,
        tenantRole,
        canAccessAllDepartments: fullAccess,
        allowedDepartmentIds: selectedDepts,
        allowedSectionKeys: fullAccess ? SECTIONS.map((s) => s.key) : selectedSections,
      }),
    onSuccess: () => {
      toast({ title: "Invitation sendt", description: `${email} er inviteret som ${ROLE_CONFIG[tenantRole]?.label ?? tenantRole}` });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/team"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/departments"] });
      onOpenChange(false);
      setEmail(""); setRole("member"); setTenantRole("member");
      setSelectedDepts([]); setFullAccess(false);
    },
    onError: (err: Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  function toggleSection(key: string) {
    setSelectedSections((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  function toggleDept(id: string) {
    setSelectedDepts((prev) => prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            Invitér teammedlem
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Email */}
          <div className="space-y-1.5">
            <Label>E-mail</Label>
            <Input
              type="email"
              placeholder="navn@virksomhed.dk"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="input-invite-email"
            />
          </div>

          {/* Tenant role */}
          <div className="space-y-1.5">
            <Label>Rolle</Label>
            <Select value={tenantRole} onValueChange={setTenantRole}>
              <SelectTrigger data-testid="select-invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tenant_admin">Tenant Admin — fuld tenant-styring</SelectItem>
                <SelectItem value="manager">Manager — kan se og administrere</SelectItem>
                <SelectItem value="member">Medlem — standard adgang</SelectItem>
                <SelectItem value="viewer">Viewer — kun læseadgang</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {tenantRole !== "tenant_admin" && (
            <>
              {/* Department scope */}
              {departments.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Afdelingsadgang</Label>
                    <button
                      type="button"
                      className="text-xs text-primary/70 hover:text-primary transition-colors"
                      onClick={() => setFullAccess((v) => !v)}
                    >
                      {fullAccess ? "Begræns til afdeling" : "Giv fuld adgang"}
                    </button>
                  </div>
                  {!fullAccess ? (
                    <div className="flex flex-wrap gap-2">
                      {departments.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => toggleDept(d.id)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                            selectedDepts.includes(d.id)
                              ? "bg-primary/15 text-primary border-primary/30"
                              : "bg-muted/20 text-muted-foreground border-white/8 hover:border-white/20"
                          }`}
                          data-testid={`toggle-dept-${d.id}`}
                        >
                          {selectedDepts.includes(d.id) && <Check className="w-2.5 h-2.5 inline mr-1" />}
                          {d.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-green-400/70 flex items-center gap-1">
                      <Unlock className="w-3 h-3" /> Adgang til alle afdelinger
                    </p>
                  )}
                </div>
              )}

              {/* Section access */}
              <div className="space-y-2">
                <Label>Sektionsadgang</Label>
                <div className="grid grid-cols-2 gap-2">
                  {SECTIONS.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => !fullAccess && toggleSection(s.key)}
                      disabled={fullAccess}
                      className={`text-xs px-3 py-1.5 rounded-lg border text-left transition-colors ${
                        fullAccess || selectedSections.includes(s.key)
                          ? "bg-primary/10 text-primary/80 border-primary/25"
                          : "bg-muted/10 text-muted-foreground border-white/8 hover:border-white/20"
                      }`}
                      data-testid={`toggle-section-${s.key}`}
                    >
                      {(fullAccess || selectedSections.includes(s.key)) && (
                        <Check className="w-2.5 h-2.5 inline mr-1" />
                      )}
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuller</Button>
          <Button
            disabled={!email.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-invite"
          >
            {mutation.isPending ? "Sender..." : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Department Dialog ─────────────────────────────────────────────────────────

function CreateDeptDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tenant/departments", {
      name,
      slug: name.toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa").replace(/[^a-z0-9]+/g, "-"),
      description: desc || undefined,
    }),
    onSuccess: () => {
      toast({ title: "Afdeling oprettet" });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/departments"] });
      onOpenChange(false);
      setName(""); setDesc("");
    },
    onError: (err: Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building className="w-4 h-4 text-primary" />
            Opret afdeling
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Navn</Label>
            <Input
              placeholder="f.eks. Salg, Marketing, Compliance"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-dept-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Beskrivelse (valgfri)</Label>
            <Input
              placeholder="Kort beskrivelse..."
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              data-testid="input-dept-description"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_DEPARTMENTS.filter((p) => p !== name).map((p) => (
              <button
                key={p}
                type="button"
                className="text-xs px-2 py-0.5 rounded-full bg-muted/20 border border-white/8 text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
                onClick={() => setName(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuller</Button>
          <Button
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-create-dept"
          >
            {mutation.isPending ? "Opretter..." : "Opret afdeling"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Team() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setStack] = useState<(string | undefined)[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateDept, setShowCreateDept] = useState(false);
  const [editMember, setEditMember] = useState<Member | null>(null);

  const isTenantAdmin = user?.role === "tenant_admin" || user?.role === "platform_admin" || user?.role === "owner";

  const { data: teamData, isLoading: teamLoading } = useQuery<TeamResponse>({
    queryKey: cursor ? ["/api/tenant/team", cursor] : ["/api/tenant/team"],
  });

  const { data: deptData, isLoading: deptLoading } = useQuery<DeptResponse>({
    queryKey: ["/api/tenant/departments"],
    retry: 1,
  });

  const departments = deptData?.departments ?? [];
  const members = teamData?.members ?? [];

  function nextPage() {
    if (!teamData?.pagination.hasMore || !teamData.pagination.nextCursor) return;
    setStack((s) => [...s, cursor]);
    setCursor(teamData.pagination.nextCursor ?? undefined);
  }

  function prevPage() {
    const prev = cursorStack[cursorStack.length - 1];
    setStack((s) => s.slice(0, -1));
    setCursor(prev);
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-team">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.18)" }}
            >
              <Users2 className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              Team
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Administrér medlemmer, afdelinger og adgang til data, eksperter og søgning.
          </p>
        </div>
        {isTenantAdmin && (
          <Button
            onClick={() => setShowInvite(true)}
            data-testid="button-invite-member"
            className="shrink-0"
          >
            <UserPlus className="w-4 h-4 mr-1.5" />
            Invitér
          </Button>
        )}
      </div>

      <Tabs defaultValue="members">
        <TabsList className="mb-4">
          <TabsTrigger value="members" data-testid="tab-members">
            Medlemmer {members.length > 0 && `(${members.length})`}
          </TabsTrigger>
          <TabsTrigger value="departments" data-testid="tab-departments">
            Afdelinger {departments.length > 0 && `(${departments.length})`}
          </TabsTrigger>
        </TabsList>

        {/* ── Members tab ─────────────────────────────────────────────── */}
        <TabsContent value="members" className="space-y-3">
          {teamLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))
          ) : members.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <div
                className="mx-auto w-12 h-12 rounded-2xl flex items-center justify-center"
                style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}
              >
                <Users2 className="w-6 h-6 text-primary/50" />
              </div>
              <p className="text-sm text-muted-foreground">Ingen teammedlemmer endnu.</p>
              {isTenantAdmin && (
                <Button onClick={() => setShowInvite(true)} data-testid="button-empty-invite">
                  <UserPlus className="w-4 h-4 mr-1.5" />
                  Invitér første medlem
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {members.map((m) => (
                <MemberCard key={m.id} member={m} onEdit={setEditMember} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {(teamData?.pagination.hasMore || cursorStack.length > 0) && (
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={cursorStack.length === 0}
                onClick={prevPage}
                data-testid="button-team-prev"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!teamData?.pagination.hasMore}
                onClick={nextPage}
                data-testid="button-team-next"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </TabsContent>

        {/* ── Departments tab ──────────────────────────────────────────── */}
        <TabsContent value="departments" className="space-y-3">
          {isTenantAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreateDept(true)}
              data-testid="button-create-dept"
              className="mb-2"
            >
              <Building className="w-4 h-4 mr-1.5" />
              Opret afdeling
            </Button>
          )}

          {deptLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))
          ) : departments.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <div
                className="mx-auto w-12 h-12 rounded-2xl flex items-center justify-center"
                style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}
              >
                <Building className="w-6 h-6 text-primary/50" />
              </div>
              <p className="text-sm text-muted-foreground">Ingen afdelinger oprettet endnu.</p>
              {isTenantAdmin && (
                <Button variant="outline" onClick={() => setShowCreateDept(true)} data-testid="button-empty-create-dept">
                  <Building className="w-4 h-4 mr-1.5" />
                  Opret afdeling
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {departments.map((d) => (
                <DeptCard key={d.id} dept={d} />
              ))}
            </div>
          )}

          {/* RBAC info box */}
          <Card className="bg-primary/5 border-primary/15 mt-4">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-start gap-2.5">
                <Shield className="w-4 h-4 text-primary/60 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-foreground/80 mb-0.5">Afdelingsbaseret adgangskontrol</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Medlemmer kan begrænses til specifikke afdelinger. Salg ser kun Salgs-data, Compliance ser kun Compliance-eksperter — medmindre de er givet fuld adgang.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <InviteDialog open={showInvite} onOpenChange={setShowInvite} departments={departments} />
      <CreateDeptDialog open={showCreateDept} onOpenChange={setShowCreateDept} />
    </div>
  );
}
