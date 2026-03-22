import { useState } from "react";
import { Redirect } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Check, AlertCircle } from "lucide-react";
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
      className="flex min-h-screen w-full font-sans antialiased overflow-hidden"
      data-testid="page-auth-login"
    >
      {/* Left Panel — Brand (60%) */}
      <div
        className="relative hidden md:flex md:w-[60%] flex-col justify-center items-start p-16 overflow-hidden"
        style={{ backgroundColor: "hsl(218 30% 12%)" }}
      >
        {/* Ambient glows */}
        <div
          className="absolute -top-32 -right-32 w-96 h-96 rounded-full blur-[128px] opacity-30 pointer-events-none"
          style={{ background: "radial-gradient(circle, #22D3EE 0%, transparent 70%)" }}
        />
        <div
          className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full blur-[128px] opacity-20 pointer-events-none"
          style={{ background: "radial-gradient(circle, #F59E0B 0%, transparent 70%)" }}
        />

        {/* Grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />

        <div className="relative z-10 w-full max-w-lg">
          <img
            src="/brand/logo-full.png"
            alt="BlissOps"
            className="w-56 mb-12"
            style={{ filter: "drop-shadow(0 0 12px rgba(34,211,238,0.25))" }}
          />

          <h1 className="text-white text-3xl md:text-4xl font-light mb-12 leading-tight">
            Byg din fremtid <br /> med{" "}
            <span className="font-semibold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">
              AI
            </span>
          </h1>

          <div className="space-y-6">
            {["Automatiser workflows", "AI-drevne projekter", "Enterprise-sikkerhed"].map(
              (feature, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
                    <Check className="w-3.5 h-3.5 text-cyan-400" />
                  </div>
                  <span className="text-slate-300 text-lg font-light">{feature}</span>
                </div>
              ),
            )}
          </div>
        </div>
      </div>

      {/* Right Panel — Form (40%) */}
      <div className="flex-1 bg-white flex flex-col items-center justify-center p-8 md:p-12 relative">
        <div className="w-full max-w-sm flex flex-col h-full justify-center">
          <div className="mb-8 text-center md:text-left">
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Velkommen tilbage</h2>
            <p className="text-slate-500">Log ind på din BlissOps konto</p>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-8" data-testid="auth-loading">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              noValidate
              className="space-y-5"
              data-testid="form-login"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm font-medium text-slate-700">
                  E-mail
                </Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="navn@firma.dk"
                  data-testid="input-email"
                  {...form.register("email")}
                  className="h-10 border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-cyan-500/50 focus-visible:border-cyan-500"
                />
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive" data-testid="error-email">
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-sm font-medium text-slate-700">
                  Adgangskode
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  data-testid="input-password"
                  {...form.register("password")}
                  className="h-10 border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-cyan-500/50 focus-visible:border-cyan-500"
                />
                {form.formState.errors.password && (
                  <p className="text-xs text-destructive" data-testid="error-password">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              {authError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600"
                  data-testid="error-auth"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={isSubmitting}
                data-testid="button-login-submit"
                className="w-full h-10 font-semibold bg-[#22D3EE] hover:bg-[#06b6d4] text-slate-950 border-0"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {isSubmitting ? "Logger ind…" : "Log ind"}
              </Button>

              <div className="text-center pt-2">
                <a
                  href="#"
                  className="text-sm font-medium text-slate-500 hover:text-cyan-600 transition-colors"
                >
                  Glemt adgangskode?
                </a>
              </div>
            </form>
          )}
        </div>

        <div className="absolute bottom-8 text-center w-full">
          <p className="text-xs text-slate-400">© {new Date().getFullYear()} BlissOps</p>
        </div>
      </div>
    </div>
  );
}
