import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Shield, Smartphone, Monitor, Trash2, LogOut, Key, RefreshCw } from "lucide-react";

interface Session {
  id:          string;
  deviceLabel: string | null;
  ipAddress:   string | null;
  userAgent:   string | null;
  lastSeenAt:  string;
  expiresAt:   string;
}

export default function SecuritySettingsPage() {
  const { toast }   = useToast();
  const qc          = useQueryClient();
  const [mfaStep, setMfaStep]       = useState<"idle" | "start" | "verify" | "codes">("idle");
  const [qrDataUrl, setQrDataUrl]   = useState("");
  const [mfaSecret, setMfaSecret]   = useState("");
  const [totpCode, setTotpCode]     = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disableCode, setDisableCode]     = useState("");

  const { data: sessions, isLoading } = useQuery<{ sessions: Session[] }>({
    queryKey: ["/api/auth/sessions"],
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/auth/sessions/${id}/revoke`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/sessions"] });
      toast({ title: "Session revoked" });
    },
  });

  const revokeAllMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/sessions/revoke-others").then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/auth/sessions"] });
      toast({ title: "Sessions revoked", description: `${data.revokedCount ?? 0} other session(s) terminated.` });
    },
  });

  const startMfaMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/enroll/start").then(r => r.json()),
    onSuccess: (data) => {
      setQrDataUrl(data.qrDataUrl ?? "");
      setMfaSecret(data.secret ?? "");
      setMfaStep("verify");
    },
  });

  const verifyMfaMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/enroll/verify", { totpCode }).then(r => r.json()),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "Invalid code", description: data.error, variant: "destructive" });
        return;
      }
      setRecoveryCodes(data.recoveryCodes ?? []);
      setMfaStep("codes");
      toast({ title: "MFA enabled", description: "Save your recovery codes securely." });
    },
  });

  const disableMfaMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/challenge", { pendingMfaToken: "", totpCode: disableCode }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "MFA disabled" });
      setDisableCode("");
    },
  });

  return (
    <div className="min-h-screen bg-background" data-testid="security-settings-page">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Account Security</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your sessions and two-factor authentication.</p>
        </div>

        {/* MFA Section */}
        <Card data-testid="mfa-section">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4" />
              <CardTitle className="text-base">Two-Factor Authentication</CardTitle>
            </div>
            <CardDescription>
              Use an authenticator app to add an extra layer of security.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {mfaStep === "idle" && (
              <Button
                onClick={() => { setMfaStep("start"); startMfaMutation.mutate(); }}
                disabled={startMfaMutation.isPending}
                data-testid="btn-start-mfa-enrollment"
              >
                {startMfaMutation.isPending ? "Preparing…" : "Enable MFA"}
              </Button>
            )}
            {mfaStep === "verify" && (
              <div className="space-y-4">
                {qrDataUrl && (
                  <img src={qrDataUrl} alt="TOTP QR code" className="w-40 h-40 border rounded" data-testid="mfa-qr-code" />
                )}
                <p className="text-xs text-muted-foreground">
                  Manual key: <code className="text-xs bg-muted px-1 rounded" data-testid="mfa-secret">{mfaSecret}</code>
                </p>
                <Input
                  placeholder="6-digit code"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  data-testid="input-totp-enrollment-code"
                />
                <Button
                  onClick={() => verifyMfaMutation.mutate()}
                  disabled={verifyMfaMutation.isPending || totpCode.length !== 6}
                  data-testid="btn-verify-enrollment"
                >
                  {verifyMfaMutation.isPending ? "Verifying…" : "Verify and enable"}
                </Button>
              </div>
            )}
            {mfaStep === "codes" && (
              <div className="space-y-3" data-testid="recovery-codes-section">
                <p className="text-sm font-medium text-yellow-400">
                  Save these recovery codes — they won't be shown again.
                </p>
                <div className="grid grid-cols-2 gap-1" data-testid="recovery-codes-list">
                  {recoveryCodes.map((c, i) => (
                    <code key={i} className="text-xs bg-muted px-2 py-1 rounded font-mono" data-testid={`recovery-code-${i}`}>
                      {c}
                    </code>
                  ))}
                </div>
                <Button variant="outline" size="sm" onClick={() => setMfaStep("idle")} data-testid="btn-done-mfa">
                  Done
                </Button>
              </div>
            )}

            {mfaStep === "idle" && (
              <div className="mt-2 pt-4 border-t border-border space-y-2">
                <p className="text-xs text-muted-foreground">Disable MFA (requires current TOTP code):</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="000000"
                    maxLength={6}
                    value={disableCode}
                    onChange={e => setDisableCode(e.target.value.replace(/\D/g, ""))}
                    className="w-32"
                    data-testid="input-disable-mfa-code"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={disableMfaMutation.isPending || disableCode.length !== 6}
                    onClick={() => disableMfaMutation.mutate()}
                    data-testid="btn-disable-mfa"
                  >
                    Disable MFA
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Sessions */}
        <Card data-testid="sessions-section">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4" />
                <CardTitle className="text-base">Active Sessions</CardTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => revokeAllMutation.mutate()}
                disabled={revokeAllMutation.isPending}
                data-testid="btn-revoke-all-sessions"
              >
                <LogOut className="w-3.5 h-3.5 mr-1.5" />
                {revokeAllMutation.isPending ? "Revoking…" : "Revoke all others"}
              </Button>
            </div>
            <CardDescription>All devices currently signed in to your account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
            ) : (sessions?.sessions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="no-sessions-msg">No active sessions found.</p>
            ) : (
              (sessions?.sessions ?? []).map((s, i) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between p-3 border border-border rounded-md"
                  data-testid={`session-row-${i}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Smartphone className="w-4 h-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`session-device-${i}`}>
                        {s.deviceLabel ?? "Unknown device"}
                      </p>
                      <p className="text-xs text-muted-foreground" data-testid={`session-ip-${i}`}>
                        {s.ipAddress ?? "—"} · Last seen {new Date(s.lastSeenAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeMutation.mutate(s.id)}
                    disabled={revokeMutation.isPending}
                    data-testid={`btn-revoke-session-${i}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
