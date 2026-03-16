import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Shield } from "lucide-react";
import { Link } from "wouter";

export default function MfaChallengePage() {
  const [location, navigate] = useLocation();
  const { toast }            = useToast();
  const [code, setCode]      = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  const pendingMfaToken = new URLSearchParams(location.split("?")[1] ?? "").get("token") ?? "";

  const mfaMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/challenge", { pendingMfaToken, totpCode: code }).then(r => r.json()),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "MFA failed", description: "Invalid code. Try again.", variant: "destructive" });
        return;
      }
      toast({ title: "Verified", description: "You are now logged in." });
      navigate("/");
    },
    onError: () => toast({ title: "Error", description: "Verification failed.", variant: "destructive" }),
  });

  const recoveryMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/recovery", { pendingMfaToken, recoveryCode }).then(r => r.json()),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "Invalid code", description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: "Logged in", description: "Recovery code accepted." });
      navigate("/");
    },
    onError: () => toast({ title: "Error", description: "Recovery failed.", variant: "destructive" }),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" data-testid="mfa-challenge-page">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle>Two-Factor Verification</CardTitle>
          </div>
          <CardDescription>
            {useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {useRecovery ? (
            <>
              <Input
                placeholder="XXXX-XXXX-XX"
                value={recoveryCode}
                onChange={e => setRecoveryCode(e.target.value)}
                data-testid="input-recovery-code"
              />
              <Button
                className="w-full"
                onClick={() => recoveryMutation.mutate()}
                disabled={recoveryMutation.isPending || recoveryCode.length < 8}
                data-testid="btn-use-recovery-code"
              >
                {recoveryMutation.isPending ? "Verifying…" : "Use recovery code"}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                <button
                  className="underline cursor-pointer"
                  onClick={() => setUseRecovery(false)}
                  data-testid="link-back-to-totp"
                >
                  Use authenticator app
                </button>
              </p>
            </>
          ) : (
            <>
              <Input
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
                data-testid="input-totp-code"
              />
              <Button
                className="w-full"
                onClick={() => mfaMutation.mutate()}
                disabled={mfaMutation.isPending || code.length !== 6}
                data-testid="btn-verify-totp"
              >
                {mfaMutation.isPending ? "Verifying…" : "Verify"}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                <button
                  className="underline cursor-pointer"
                  onClick={() => setUseRecovery(true)}
                  data-testid="link-use-recovery-code"
                >
                  Use recovery code instead
                </button>
              </p>
            </>
          )}
          <p className="text-xs text-center">
            <Link href="/auth/login" className="text-muted-foreground underline" data-testid="link-back-login">
              Back to login
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
