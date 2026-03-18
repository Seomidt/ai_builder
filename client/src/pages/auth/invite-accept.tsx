import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, UserPlus } from "lucide-react";
import { Link } from "wouter";

export default function InviteAcceptPage() {
  const [location, navigate] = useLocation();
  const { toast }            = useToast();
  const token = new URLSearchParams(location.split("?")[1] ?? "").get("token") ?? "";
  const [accepted, setAccepted] = useState(false);
  const [result, setResult]     = useState<{ tenantId?: string; role?: string } | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/invite/accept", { token }).then(r => r.json()),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "Invite invalid", description: data.error, variant: "destructive" });
        return;
      }
      setAccepted(true);
      setResult({ tenantId: data.tenantId, role: data.role });
      toast({ title: "Invite accepted", description: `Joined as ${data.role ?? "member"}.` });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to accept invite.", variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" data-testid="invite-accept-page">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" />
            <CardTitle>Accept Invitation</CardTitle>
          </div>
          <CardDescription>
            {token ? "You've been invited to join the platform." : "Invalid invitation link."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!token ? (
            <p className="text-sm text-destructive" data-testid="invalid-invite-msg">
              No invite token found. Please check your invitation email.
            </p>
          ) : accepted ? (
            <div className="flex flex-col items-center gap-3 py-4" data-testid="invite-accepted-success">
              <CheckCircle2 className="w-10 h-10 text-green-400" />
              <p className="text-sm font-medium">Invitation accepted!</p>
              {result?.role && (
                <p className="text-xs text-muted-foreground" data-testid="invite-role">Role: {result.role}</p>
              )}
              <Button onClick={() => navigate("/")} data-testid="btn-go-dashboard">Go to dashboard</Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Click accept to join with your current account.
              </p>
              <Button
                className="w-full"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
                data-testid="btn-accept-invite"
              >
                {mutation.isPending ? "Accepting…" : "Accept invitation"}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                You must be{" "}
                <Link href="/auth/login" className="underline" data-testid="link-login-first">signed in</Link>
                {" "}to accept.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
