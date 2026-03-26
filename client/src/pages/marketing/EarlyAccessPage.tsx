import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, ArrowRight, Check } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingLogo } from "@/components/marketing/MarketingLogo";

const formSchema = z.object({
  email:    z.string().email("Indtast en gyldig arbejdsmail"),
  fullName: z.string().optional(),
  company:  z.string().min(1, "Virksomhedsnavn er påkrævet"),
  role:     z.string().optional(),
  useCase:  z.string().min(1, "Vælg venligst et use case"),
  teamSize: z.string().optional(),
});

type FormData = z.infer<typeof formSchema>;

const USE_CASES = [
  "Intern vidensbase og dokumentsøgning",
  "Kundesupport AI-assistent",
  "AI-drevet HR og onboarding",
  "Finansiel analyse og rapportering",
  "Juridisk og compliance review",
  "Salg og CRM-integration",
  "Andet / custom workflow",
];

const TEAM_SIZES = ["1–10", "11–50", "51–200", "201–1000", "1000+"];

const expectItems = [
  "Kvalificeret virksomheds- og use case-registrering",
  "Prioriteret onboarding for de bedst egnede teams",
  "Ingen spam eller generisk ventelistelarm",
  "Struktureret til admin review og opfølgning",
];

const securityItems = [
  "Tenant-isoleret arkitektur",
  "Privacy-first datahåndtering",
  "Audit-venlig driftsmodel",
  "Designet til GDPR-overholdelse",
];

export default function EarlyAccessPage() {
  const [submitted, setSubmitted] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "", fullName: "", company: "", role: "", useCase: "", teamSize: "1–10",
    },
  });

  async function onSubmit(data: FormData) {
    setServerError(null);
    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) {
        setServerError(json.error ?? "Der skete en fejl. Prøv igen.");
        return;
      }
      if (json.status === "already_registered") {
        setAlreadyRegistered(true);
      }
      setSubmitted(true);
    } catch {
      setServerError("Netværksfejl. Tjek din forbindelse og prøv igen.");
    }
  }

  return (
    <div className="min-h-screen bg-[#030711] text-white">
      {/* ── Background ── */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(circle, rgba(255,255,255,0.75) 1px, transparent 1px)",
              "radial-gradient(circle, rgba(255,255,255,0.5) 1px, transparent 1px)",
            ].join(","),
            backgroundSize: "120px 120px, 60px 60px",
            backgroundPosition: "0 0, 30px 30px",
            opacity: 0.18,
          }}
        />
        <div className="absolute left-1/4 top-0 h-[500px] w-[600px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(30,64,175,0.35),transparent_65%)] blur-2xl" />
        <div className="absolute right-0 top-1/3 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.10),transparent_65%)] blur-2xl" />
        <div className="absolute inset-0 bg-[#030711]/50" />
      </div>

      {/* ── Content ── */}
      <div className="relative z-10">
        <MarketingNav />

        <main className="mx-auto max-w-5xl px-6 pb-20 pt-12 md:px-8">
          {/* Header */}
          <div className="mb-12 text-center">
            <h1 className="text-5xl font-semibold leading-[1.1] tracking-tight text-white md:text-6xl">
              Join Private<br />Early Access
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-7 text-slate-300">
              BlissOps is rolling out private access to selected teams first.<br className="hidden sm:block" />
              Share your company and use case so we can prioritize the right fit.
            </p>
          </div>

          {submitted ? (
            /* ── Success state ── */
            <div className="mx-auto max-w-lg rounded-2xl border border-emerald-500/25 bg-[#060d1f]/80 p-10 text-center backdrop-blur-xl">
              <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full border border-emerald-500/30 bg-emerald-500/15">
                <CheckCircle2 className="h-8 w-8 text-emerald-400" />
              </div>
              <h2 className="text-2xl font-semibold text-white">
                {alreadyRegistered ? "Du er allerede tilmeldt" : "Ansøgning modtaget"}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                {alreadyRegistered
                  ? "Vi har allerede din ansøgning. Vi vender tilbage til dig snart."
                  : "Vi gennemgår din ansøgning og vender tilbage til dig snart. Prioriteret onboarding for de bedst egnede teams."}
              </p>
              <div className="mt-6 flex flex-col gap-2">
                {["Ingen spam", "Prioriteret onboarding", "Begrænset antal pladser"].map((item) => (
                  <div key={item} className="flex items-center justify-center gap-2 text-sm text-slate-300">
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* ── Two-column form + info ── */
            <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
              {/* Left: Form card */}
              <div className="rounded-2xl border border-white/10 bg-[#060d1f]/80 p-7 backdrop-blur-xl">
                <h2 className="mb-6 text-xl font-semibold text-white">Join Private Early Access</h2>

                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  {/* Email */}
                  <div>
                    <input
                      {...form.register("email")}
                      type="email"
                      placeholder="Arbejdsmail *"
                      autoComplete="email"
                      data-testid="input-ea-email"
                      className="w-full rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                    />
                    {form.formState.errors.email && (
                      <p className="mt-1.5 text-xs text-red-400">{form.formState.errors.email.message}</p>
                    )}
                  </div>

                  {/* Full name */}
                  <input
                    {...form.register("fullName")}
                    type="text"
                    placeholder="Fuldt navn"
                    autoComplete="name"
                    data-testid="input-ea-fullname"
                    className="w-full rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                  />

                  {/* Company */}
                  <div>
                    <input
                      {...form.register("company")}
                      type="text"
                      placeholder="Virksomhed *"
                      autoComplete="organization"
                      data-testid="input-ea-company"
                      className="w-full rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                    />
                    {form.formState.errors.company && (
                      <p className="mt-1.5 text-xs text-red-400">{form.formState.errors.company.message}</p>
                    )}
                  </div>

                  {/* Role */}
                  <input
                    {...form.register("role")}
                    type="text"
                    placeholder="Stilling / rolle"
                    autoComplete="organization-title"
                    data-testid="input-ea-role"
                    className="w-full rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                  />

                  {/* Use case */}
                  <div>
                    <label className="mb-1.5 block text-sm text-slate-300">
                      Primært use case <span className="text-sky-400">*</span>
                    </label>
                    <div className="relative">
                      <select
                        {...form.register("useCase")}
                        data-testid="select-ea-usecase"
                        className="w-full appearance-none rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                        defaultValue=""
                      >
                        <option value="" disabled className="text-slate-500">Vælg et use case</option>
                        {USE_CASES.map((uc) => (
                          <option key={uc} value={uc} className="bg-[#0a1628]">{uc}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">
                        <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                    {form.formState.errors.useCase && (
                      <p className="mt-1.5 text-xs text-red-400">{form.formState.errors.useCase.message}</p>
                    )}
                  </div>

                  {/* Team size */}
                  <div>
                    <label className="mb-1.5 block text-sm text-slate-300">Teamstørrelse</label>
                    <div className="relative">
                      <select
                        {...form.register("teamSize")}
                        data-testid="select-ea-teamsize"
                        className="w-full appearance-none rounded-xl border border-white/12 bg-[#0a1628] px-4 py-3 text-sm text-white outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 transition"
                      >
                        {TEAM_SIZES.map((s) => (
                          <option key={s} value={s} className="bg-[#0a1628]">{s}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">
                        <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {serverError && (
                    <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                      {serverError}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={form.formState.isSubmitting}
                    data-testid="button-ea-submit"
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 py-3.5 text-base font-semibold text-white shadow-[0_0_24px_rgba(14,165,233,0.4)] transition hover:bg-sky-400 hover:shadow-[0_0_32px_rgba(14,165,233,0.55)] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {form.formState.isSubmitting ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Sender…
                      </span>
                    ) : (
                      <>Request Early Access <ArrowRight className="h-4 w-4" /></>
                    )}
                  </button>

                  <p className="text-center text-xs text-slate-500">
                    Privat rollout · Ingen spam · Prioriteret onboarding
                  </p>
                </form>
              </div>

              {/* Right: What to expect */}
              <div className="rounded-2xl border border-white/10 bg-[#060d1f]/70 p-7 backdrop-blur-xl">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.28em] text-sky-400">
                  Hvad du kan forvente
                </div>

                <h3 className="mt-3 text-2xl font-semibold leading-tight text-white">
                  Privat rollout for<br />udvalgte teams
                </h3>

                <p className="mt-3 text-sm leading-6 text-slate-400">
                  Vi prioriterer teams, der har brug for stærk kontrol over AI-forbrug, adgang og interne dataflows.
                </p>

                <div className="mt-5 space-y-3">
                  {expectItems.map((item) => (
                    <div key={item} className="flex items-start gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>

                <div className="my-6 h-px bg-white/8" />

                <h3 className="text-lg font-semibold leading-tight text-sky-300">
                  Bygget til sikker AI-infrastruktur
                </h3>

                <div className="mt-4 space-y-3">
                  {securityItems.map((item) => (
                    <div key={item} className="flex items-start gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>

                {/* Logo card at bottom */}
                <div className="mt-8 rounded-xl border border-white/8 bg-[#0a1628]/60 p-4">
                  <MarketingLogo small />
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    BlissOps er i privat rollout. Adgang gives løbende til udvalgte organisationer.
                  </p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
