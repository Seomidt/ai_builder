import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, ArrowRight, Check, Lock, Eye, FolderLock, ShieldCheck } from "lucide-react";
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
  { icon: <Lock className="h-3.5 w-3.5" />, text: "Tenant-isoleret arkitektur" },
  { icon: <Eye className="h-3.5 w-3.5" />, text: "Privacy-first datahåndtering" },
  { icon: <FolderLock className="h-3.5 w-3.5" />, text: "Audit-venlig driftsmodel" },
  { icon: <ShieldCheck className="h-3.5 w-3.5" />, text: "Designet til GDPR-beredskab" },
];

const inputCls = "w-full rounded-xl border border-white/10 bg-[#0a1628] px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/15 transition";
const labelCls = "mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400";

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
      if (json.status === "already_registered") setAlreadyRegistered(true);
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

        <main className="mx-auto max-w-5xl px-6 pb-20 pt-10 md:px-8">
          {/* Hero */}
          <div className="mb-10 text-center">
            <div className="mb-4 text-[10px] font-bold uppercase tracking-[0.3em] text-sky-400/70">
              Privat adgang
            </div>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white md:text-5xl">
              Join Private Early Access
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-slate-400">
              BlissOps er i privat rollout til udvalgte teams. Del din virksomhed og dit use case, så vi kan prioritere det rette match.
            </p>
          </div>

          {submitted ? (
            /* ── Success state ── */
            <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-[#060d1f]/80 p-10 text-center backdrop-blur-xl">
              <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl border border-emerald-500/25 bg-emerald-500/10">
                <CheckCircle2 className="h-7 w-7 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold text-white">
                {alreadyRegistered ? "Du er allerede registreret" : "Du er på listen"}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                {alreadyRegistered
                  ? "Vi har allerede din ansøgning. Vi vender tilbage til dig snart."
                  : "Vi kontakter dig, når privat rollout udvides."}
              </p>
              <div className="mt-6 border-t border-white/8 pt-6 space-y-2">
                {["Ingen spam", "Prioriteret onboarding", "Begrænset antal pladser"].map((item) => (
                  <div key={item} className="flex items-center justify-center gap-2 text-xs text-slate-400">
                    <Check className="h-3.5 w-3.5 text-emerald-400/80" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* ── Two-column layout ── */
            <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">

              {/* ── Left: Form ── */}
              <div className="rounded-2xl border border-white/10 bg-[#060d1f]/80 p-7 backdrop-blur-xl">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.28em] text-sky-400/70">
                  Ansøgning
                </div>
                <h2 className="mt-2 mb-7 text-lg font-semibold text-white">
                  Join Private Early Access
                </h2>

                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>

                  {/* Row: Email + Full name */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className={labelCls}>
                        Arbejdsmail <span className="text-sky-400 normal-case tracking-normal">*</span>
                      </label>
                      <input
                        {...form.register("email")}
                        type="email"
                        placeholder="navn@virksomhed.dk"
                        autoComplete="email"
                        data-testid="input-ea-email"
                        className={inputCls}
                      />
                      {form.formState.errors.email && (
                        <p className="mt-1.5 text-xs text-red-400/90">{form.formState.errors.email.message}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls}>Fuldt navn</label>
                      <input
                        {...form.register("fullName")}
                        type="text"
                        placeholder="Valgfrit"
                        autoComplete="name"
                        data-testid="input-ea-fullname"
                        className={inputCls}
                      />
                    </div>
                  </div>

                  {/* Row: Company + Role */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className={labelCls}>
                        Virksomhed <span className="text-sky-400 normal-case tracking-normal">*</span>
                      </label>
                      <input
                        {...form.register("company")}
                        type="text"
                        placeholder="Virksomhedsnavn"
                        autoComplete="organization"
                        data-testid="input-ea-company"
                        className={inputCls}
                      />
                      {form.formState.errors.company && (
                        <p className="mt-1.5 text-xs text-red-400/90">{form.formState.errors.company.message}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls}>Stilling / rolle</label>
                      <input
                        {...form.register("role")}
                        type="text"
                        placeholder="Valgfrit"
                        autoComplete="organization-title"
                        data-testid="input-ea-role"
                        className={inputCls}
                      />
                    </div>
                  </div>

                  {/* Use case */}
                  <div>
                    <label className={labelCls}>
                      Primært use case <span className="text-sky-400 normal-case tracking-normal">*</span>
                    </label>
                    <div className="relative">
                      <select
                        {...form.register("useCase")}
                        data-testid="select-ea-usecase"
                        className={inputCls + " appearance-none pr-10"}
                        defaultValue=""
                      >
                        <option value="" disabled className="text-slate-500 bg-[#0a1628]">Vælg et use case</option>
                        {USE_CASES.map((uc) => (
                          <option key={uc} value={uc} className="bg-[#0a1628]">{uc}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                    {form.formState.errors.useCase && (
                      <p className="mt-1.5 text-xs text-red-400/90">{form.formState.errors.useCase.message}</p>
                    )}
                  </div>

                  {/* Team size */}
                  <div>
                    <label className={labelCls}>Teamstørrelse</label>
                    <div className="relative">
                      <select
                        {...form.register("teamSize")}
                        data-testid="select-ea-teamsize"
                        className={inputCls + " appearance-none pr-10"}
                      >
                        {TEAM_SIZES.map((s) => (
                          <option key={s} value={s} className="bg-[#0a1628]">{s}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {serverError && (
                    <p className="rounded-xl border border-red-500/15 bg-red-500/8 px-4 py-3 text-sm text-red-400">
                      {serverError}
                    </p>
                  )}

                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={form.formState.isSubmitting}
                      data-testid="button-ea-submit"
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-sky-500/35 bg-sky-500/12 py-3.5 text-sm font-medium text-white transition hover:border-sky-400/55 hover:bg-sky-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {form.formState.isSubmitting ? (
                        <>
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                          Sender…
                        </>
                      ) : (
                        <>Request Early Access <ArrowRight className="h-4 w-4" /></>
                      )}
                    </button>
                    <p className="mt-3 text-center text-xs text-slate-500">
                      Privat rollout · Ingen spam · Prioriteret onboarding
                    </p>
                  </div>
                </form>
              </div>

              {/* ── Right: Trust panel ── */}
              <div className="flex flex-col gap-4">

                {/* What to expect */}
                <div className="rounded-2xl border border-white/10 bg-[#060d1f]/70 p-6 backdrop-blur-xl">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.28em] text-sky-400/70">
                    Hvad du kan forvente
                  </div>
                  <h3 className="mt-3 text-lg font-semibold leading-tight text-white">
                    Privat rollout for udvalgte teams
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-slate-400">
                    Vi prioriterer teams med brug for stærk kontrol over AI-forbrug, adgang og interne dataflows.
                  </p>
                  <div className="mt-5 space-y-3">
                    {expectItems.map((item) => (
                      <div key={item} className="flex items-start gap-2.5 text-sm text-slate-300">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-400/80" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Security block */}
                <div className="rounded-2xl border border-white/10 bg-[#060d1f]/70 p-6 backdrop-blur-xl">
                  <h3 className="text-sm font-semibold text-white">
                    Bygget til sikker AI-infrastruktur
                  </h3>
                  <div className="mt-4 space-y-3">
                    {securityItems.map((item) => (
                      <div key={item.text} className="flex items-center gap-2.5">
                        <div className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-sky-400/15 bg-[#0a1628] text-sky-300">
                          {item.icon}
                        </div>
                        <span className="text-sm text-slate-400">{item.text}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Brand support card */}
                <div className="rounded-2xl border border-white/8 bg-[#0a1628]/50 p-5">
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
