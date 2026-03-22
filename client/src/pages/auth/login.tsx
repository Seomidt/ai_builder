import { useState } from "react";
import { Redirect } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, LogIn, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";

const schema = z.object({
  email: z.string().email("Ugyldig e-mailadresse"),
  password: z.string().min(6, "Adgangskoden skal være mindst 6 tegn"),
});
type FormValues = z.infer<typeof schema>;


export default function AuthLogin() {
  const [authError, setAuthError] = useState<string | null>(null);
  const { isAuthed, isLoading } = useAuth();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const { isSubmitting } = form.formState;

  if (isAuthed) {
    return <Redirect to="/" />;
  }

  async function onSubmit(values: FormValues) {
    setAuthError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: values.email,
        password: values.password,
      });

      if (error) {
        setAuthError(
          error.message === "Invalid login credentials"
            ? "Forkert e-mail eller adgangskode."
            : error.message,
        );
        return;
      }

      queryClient.prefetchQuery({
        queryKey: ["dashboard-summary"],
        queryFn: async () => {
          const { data, error } = await supabase.rpc("get_dashboard_summary");
          if (error) throw new Error(error.message);
          return data;
        },
      });

    } catch {
      setAuthError("Der opstod en fejl. Prøv igen.");
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{ background: "hsl(220 35% 9%)" }}
      data-testid="page-auth-login"
    >
      {/* Background glow */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{
        background: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(34,211,238,0.08) 0%, transparent 60%)",
      }} />

      <div className="relative w-full max-w-sm">

        {/* Logo + Brand */}
        <div className="flex flex-col items-center mb-8 text-center">
          <img
            src="/brand/logo-full.jpeg"
            alt="BlissOps"
            className="w-56 h-auto object-contain"
            style={{ mixBlendMode: "screen" }}
          />
          <p className="mt-3 text-sm text-muted-foreground">AI Platform — Log ind for at fortsætte</p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-8"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
          }}
        >
          {isLoading ? (
            <div className="flex justify-center py-8" data-testid="auth-loading">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              noValidate
              className="space-y-5"
              data-testid="form-login"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm font-medium text-foreground/80">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="dig@eksempel.com"
                  data-testid="input-email"
                  {...form.register("email")}
                  className="h-10"
                />
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive" data-testid="error-email">
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-sm font-medium text-foreground/80">Adgangskode</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  data-testid="input-password"
                  {...form.register("password")}
                  className="h-10"
                />
                {form.formState.errors.password && (
                  <p className="text-xs text-destructive" data-testid="error-password">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              {authError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
                  data-testid="error-auth"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <Button
                type="submit"
                className="w-full h-10 font-semibold"
                disabled={isSubmitting}
                data-testid="button-login-submit"
                style={{ boxShadow: "0 0 20px rgba(34,211,238,0.20)" }}
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {isSubmitting ? "Logger ind…" : "Log ind"}
              </Button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground/50 mt-6">
          © {new Date().getFullYear()} BlissOps
        </p>
      </div>
    </div>
  );
}
