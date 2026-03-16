import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Shield } from "lucide-react";

const loginSchema = z.object({
  email:    z.string().email("Valid email required"),
  password: z.string().min(1, "Password required"),
});
type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { toast }    = useToast();
  const [mfaPending, setMfaPending]       = useState(false);
  const [pendingMfaToken, setPendingMfaToken] = useState("");
  const [mfaCode, setMfaCode]             = useState("");

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const loginMutation = useMutation({
    mutationFn: (data: LoginForm) =>
      apiRequest("POST", "/api/auth/login", data).then(r => r.json()),
    onSuccess: (data) => {
      if (data.mfaRequired) {
        setMfaPending(true);
        setPendingMfaToken(data.pendingMfaToken ?? "");
        return;
      }
      if (data.error) {
        toast({ title: "Login failed", description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: "Logged in", description: "Welcome back." });
      navigate("/");
    },
    onError: () => {
      toast({ title: "Login failed", description: "Invalid credentials.", variant: "destructive" });
    },
  });

  const mfaMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/auth/mfa/challenge", { pendingMfaToken, totpCode: mfaCode }).then(r => r.json()),
    onSuccess: (data) => {
      if (data.error) {
        toast({ title: "MFA failed", description: "Invalid code.", variant: "destructive" });
        return;
      }
      toast({ title: "Logged in", description: "MFA verified." });
      navigate("/");
    },
    onError: () => {
      toast({ title: "MFA failed", description: "Invalid code.", variant: "destructive" });
    },
  });

  if (mfaPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4" data-testid="mfa-challenge-inline">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle>Two-Factor Verification</CardTitle>
            </div>
            <CardDescription>Enter your authenticator code to continue.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              placeholder="000000"
              maxLength={6}
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, ""))}
              data-testid="input-mfa-code"
            />
            <Button
              className="w-full"
              onClick={() => mfaMutation.mutate()}
              disabled={mfaMutation.isPending || mfaCode.length !== 6}
              data-testid="btn-submit-mfa"
            >
              {mfaMutation.isPending ? "Verifying…" : "Verify"}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Lost your device?{" "}
              <Link href="/auth/mfa-challenge" className="underline" data-testid="link-use-recovery">
                Use recovery code
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" data-testid="login-page">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Enter your email and password to access your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => loginMutation.mutate(d))} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" data-testid="input-email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" data-testid="input-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={loginMutation.isPending} data-testid="btn-login">
                {loginMutation.isPending ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-sm text-center text-muted-foreground">
                <Link href="/auth/password-reset" className="underline" data-testid="link-forgot-password">
                  Forgot password?
                </Link>
              </p>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
