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
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";

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

  // Safety fallback: already authenticated users bounce immediately
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

      // Prefetch dashboard summary immediately after login — fire-and-forget.
      // Calls Supabase RPC directly (no server hop). The session JWT is now
      // in localStorage so supabase.rpc() will include it automatically.
      // By the time auth state change navigates to "/", the cache is warm.
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
      className="min-h-screen flex items-center justify-center bg-background px-4"
      data-testid="page-auth-login"
    >
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="space-y-1 pb-4">
          <CardTitle
            className="text-2xl font-bold tracking-tight"
            data-testid="text-auth-login-title"
          >
            BlissOps
          </CardTitle>
          <CardDescription>Log ind for at tilgå platformen</CardDescription>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8" data-testid="auth-loading">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              noValidate
              className="space-y-4"
              data-testid="form-login"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="dig@eksempel.com"
                  data-testid="input-email"
                  {...form.register("email")}
                />
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive" data-testid="error-email">
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Adgangskode</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  data-testid="input-password"
                  {...form.register("password")}
                />
                {form.formState.errors.password && (
                  <p className="text-xs text-destructive" data-testid="error-password">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              {authError && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="error-auth"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting}
                data-testid="button-login-submit"
              >
                {isSubmitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="mr-2 h-4 w-4" />
                )}
                {isSubmitting ? "Logger ind…" : "Log ind"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
