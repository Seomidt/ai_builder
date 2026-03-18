import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Link } from "wouter";

export default function EmailVerifyPage() {
  const [location] = useLocation();
  const token = new URLSearchParams(location.split("?")[1] ?? "").get("token") ?? "";
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/email-verification/confirm", { token }).then(r => r.json()),
    onSuccess: (data) => {
      setStatus(data.ok ? "success" : "error");
    },
    onError: () => setStatus("error"),
  });

  useEffect(() => {
    if (token) mutation.mutate();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" data-testid="email-verify-page">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Email Verification</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-4">
          {mutation.isPending && (
            <>
              <Loader2 className="w-10 h-10 animate-spin text-primary" data-testid="verify-loading" />
              <p className="text-sm text-muted-foreground">Verifying your email…</p>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle2 className="w-10 h-10 text-green-400" data-testid="verify-success-icon" />
              <p className="text-sm font-medium" data-testid="verify-success-msg">Email verified successfully!</p>
              <Link href="/auth/login" data-testid="link-go-login">
                <Button className="mt-2">Continue to login</Button>
              </Link>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="w-10 h-10 text-red-400" data-testid="verify-error-icon" />
              <p className="text-sm text-destructive" data-testid="verify-error-msg">
                {token ? "Invalid or expired verification link." : "No verification token provided."}
              </p>
              <Link href="/" data-testid="link-go-home">
                <Button variant="outline">Go home</Button>
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
