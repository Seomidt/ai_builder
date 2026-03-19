import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Users, UserPlus, Shield, ChevronRight, ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TeamResponse {
  members: {
    id: string; role: string; userId: string | null;
    email: string | null; fullName: string | null; joinedAt: string;
  }[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
  retrievedAt: string;
}

const ROLE_COLORS: Record<string, string> = {
  owner:  "bg-primary/15 text-primary border-primary/25",
  admin:  "bg-secondary/15 text-secondary border-secondary/25",
  member: "bg-muted text-muted-foreground border-border",
  viewer: "bg-muted text-muted-foreground border-border",
};

export default function TenantTeam() {
  const { toast } = useToast();
  const [cursor, setCursor]     = useState<string | undefined>(undefined);
  const [cursorStack, setStack] = useState<(string | undefined)[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [email,  setEmail]  = useState("");
  const [role,   setRole]   = useState("member");

  const { data, isLoading } = useQuery<TeamResponse>({
    queryKey: cursor ? ["/api/tenant/team", cursor] : ["/api/tenant/team"],
  });

  const inviteMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tenant/team/invite", { email, role }),
    onSuccess: () => {
      toast({ title: "Invitation sent", description: `${email} invited as ${role}` });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/team"] });
      setShowInvite(false);
      setEmail("");
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const nextPage = () => {
    if (!data?.pagination.hasMore || !data.pagination.nextCursor) return;
    setStack((s) => [...s, cursor]);
    setCursor(data.pagination.nextCursor);
  };
  const prevPage = () => {
    const stack = [...cursorStack];
    const prev  = stack.pop();
    setStack(stack);
    setCursor(prev);
  };

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" /> Team
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Manage members and access control</p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setShowInvite(true)} data-testid="button-invite-user">
            <UserPlus className="w-4 h-4" /> Invite
          </Button>
        </div>

        {/* Roles Reference */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" /> Roles
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { role: "owner",  desc: "Full platform control" },
                { role: "admin",  desc: "Manage settings & team" },
                { role: "member", desc: "Read & write access" },
                { role: "viewer", desc: "Read-only access" },
              ].map(({ role: r, desc }) => (
                <div key={r} className="flex flex-col gap-1" data-testid={`role-info-${r}`}>
                  <Badge variant="outline" className={`text-xs w-fit ${ROLE_COLORS[r]}`}>{r}</Badge>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Members List */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Members</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : data?.members?.length ? (
              <div data-testid="team-members-list">
                {data.members.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`member-row-${m.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
                        <span className="text-xs font-semibold text-primary">
                          {(m.fullName ?? m.email ?? "?").slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="text-sm font-medium" data-testid={`member-name-${m.id}`}>
                          {m.fullName ?? m.email ?? "Unknown user"}
                        </p>
                        <p className="text-xs text-muted-foreground">{m.email}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-xs ${ROLE_COLORS[m.role] ?? ROLE_COLORS.member}`} data-testid={`member-role-${m.id}`}>
                      {m.role}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <Users className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-members-msg">No team members yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        <div className="flex items-center justify-between" data-testid="team-pagination">
          <Button variant="outline" size="sm" onClick={prevPage} disabled={cursorStack.length === 0}
            className="gap-1.5" data-testid="button-team-prev">
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">{data?.members?.length ?? 0} members</span>
          <Button variant="outline" size="sm" onClick={nextPage} disabled={!data?.pagination.hasMore}
            className="gap-1.5" data-testid="button-team-next">
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Invite Dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent data-testid="invite-dialog">
          <DialogHeader>
            <DialogTitle>Invite Team Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Email address</label>
              <Input
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="input-invite-email"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Role</label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger data-testid="select-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)} data-testid="button-cancel-invite">Cancel</Button>
            <Button
              onClick={() => inviteMutation.mutate()}
              disabled={!email || inviteMutation.isPending}
              data-testid="button-confirm-invite"
            >
              {inviteMutation.isPending ? "Sending…" : "Send Invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
