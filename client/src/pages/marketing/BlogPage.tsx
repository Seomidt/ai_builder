import { Link } from "wouter";
import { ArrowRight, Clock, Calendar, Tag } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  readTime: number;
  date: string;
  author: string;
  authorRole: string;
  featured?: boolean;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "hvad-er-en-ai-ekspert",
    title: "Hvad er en AI Ekspert — og hvorfor dit team har brug for én",
    excerpt:
      "AI Eksperter er ikke chatbots. De er specialiserede AI-agenter, der er konfigureret med virksomhedsspecifik viden, roller og regler — og som handler præcist inden for de rammer, du sætter.",
    category: "Produkt",
    readTime: 6,
    date: "24. marts 2025",
    author: "BlissOps Team",
    authorRole: "Platform",
    featured: true,
  },
  {
    slug: "ai-og-datasikkerhed",
    title: "Implementer AI uden at gå på kompromis med datasikkerheden",
    excerpt:
      "Mange virksomheder holder igen med AI, fordi de frygter datalæk og compliance-problemer. Vi gennemgår, hvordan tenant-isoleret arkitektur og adgangsstyring løser de mest kritiske sikkerhedsproblemstillinger.",
    category: "Sikkerhed",
    readTime: 8,
    date: "17. marts 2025",
    author: "BlissOps Team",
    authorRole: "Sikkerhed",
  },
  {
    slug: "5-ai-use-cases-med-roi",
    title: "5 use cases, hvor AI Eksperter skaber målbar ROI",
    excerpt:
      "Fra intern vidensbase til automatiseret kundesupport — her er fem konkrete scenarier, hvor virksomheder bruger BlissOps AI Eksperter og ser resultater, der kan måles på bundlinjen.",
    category: "Business",
    readTime: 7,
    date: "10. marts 2025",
    author: "BlissOps Team",
    authorRole: "Business",
  },
  {
    slug: "multi-tenant-ai-platform",
    title: "Hvordan multi-tenant arkitektur ændrer enterprise AI",
    excerpt:
      "En gennemgang af, hvad multi-tenancy betyder i AI-kontekst, og hvorfor det er den eneste skalerbare model for organisationer med strikse krav til dataisolering og rollebaseret adgang.",
    category: "Teknologi",
    readTime: 9,
    date: "3. marts 2025",
    author: "BlissOps Team",
    authorRole: "Engineering",
  },
  {
    slug: "ai-governance-i-praksis",
    title: "AI governance i praksis: Regler, adgang og revisionsspor",
    excerpt:
      "Hvad vil det sige at have kontrol over AI i din organisation? Vi dykker ned i, hvad governance dækker — fra brugeradgang og kørselsbegrænsninger til revisionsspor og compliance-rapportering.",
    category: "Governance",
    readTime: 5,
    date: "24. februar 2025",
    author: "BlissOps Team",
    authorRole: "Compliance",
  },
];

const CATEGORY_COLORS: Record<string, string> = {
  Produkt:    "border-sky-400/30 bg-sky-500/10 text-sky-300",
  Sikkerhed:  "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  Business:   "border-violet-400/30 bg-violet-500/10 text-violet-300",
  Teknologi:  "border-amber-400/30 bg-amber-500/10 text-amber-300",
  Governance: "border-rose-400/30 bg-rose-500/10 text-rose-300",
};

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? "border-white/10 bg-white/5 text-slate-300";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${cls}`}
    >
      <Tag className="h-2.5 w-2.5" />
      {category}
    </span>
  );
}

function FeaturedCard({ post }: { post: BlogPost }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      data-testid={`card-blog-featured-${post.slug}`}
      className="group relative block rounded-[20px] border border-white/10 bg-[#060d1f]/70 p-7 backdrop-blur-xl transition hover:border-sky-500/30 hover:bg-[#060d1f]/90 md:p-10"
    >
      <div className="absolute inset-0 rounded-[20px] bg-[radial-gradient(circle_at_60%_0%,rgba(30,64,175,0.18),transparent_60%)] pointer-events-none" />
      <div className="relative">
        <div className="flex flex-wrap items-center gap-3">
          <CategoryBadge category={post.category} />
          <span className="rounded-full border border-sky-400/20 bg-sky-500/8 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
            Udvalgt artikel
          </span>
        </div>
        <h2 className="mt-5 text-2xl font-semibold leading-tight text-white transition group-hover:text-sky-100 md:text-3xl">
          {post.title}
        </h2>
        <p className="mt-3 text-base leading-7 text-slate-400 md:max-w-2xl">
          {post.excerpt}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-5 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            {post.date}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {post.readTime} min læsning
          </span>
          <span className="font-medium text-slate-400">{post.author}</span>
        </div>
        <div className="mt-7 inline-flex items-center gap-2 text-sm font-medium text-sky-400 transition group-hover:gap-3">
          Læs artikel <ArrowRight className="h-4 w-4" />
        </div>
      </div>
    </Link>
  );
}

function BlogCard({ post }: { post: BlogPost }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      data-testid={`card-blog-${post.slug}`}
      className="group flex flex-col rounded-2xl border border-white/10 bg-[#060d1f]/60 p-6 backdrop-blur-xl transition hover:border-sky-500/25 hover:bg-[#060d1f]/80"
    >
      <div>
        <CategoryBadge category={post.category} />
        <h3 className="mt-4 text-base font-semibold leading-snug text-white transition group-hover:text-sky-100">
          {post.title}
        </h3>
        <p className="mt-2.5 text-sm leading-6 text-slate-400 line-clamp-3">
          {post.excerpt}
        </p>
      </div>
      <div className="mt-auto pt-5 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {post.readTime} min
        </span>
        <span>{post.date}</span>
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 transition group-hover:gap-2.5">
        Læs mere <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}

export default function BlogPage() {
  const featured = BLOG_POSTS.find((p) => p.featured);
  const rest = BLOG_POSTS.filter((p) => !p.featured);

  return (
    <div className="min-h-screen bg-[#030711] text-white">
      {/* Background */}
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
            opacity: 0.14,
          }}
        />
        <div className="absolute left-1/4 top-0 h-[400px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(30,64,175,0.3),transparent_65%)] blur-2xl" />
        <div className="absolute right-0 top-1/3 h-[300px] w-[300px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.08),transparent_65%)] blur-2xl" />
        <div className="absolute inset-0 bg-[#030711]/40" />
      </div>

      <div className="relative z-10">
        <MarketingNav />

        <main className="mx-auto max-w-5xl px-6 pb-24 pt-14 md:px-8">
          {/* Page header */}
          <div className="mb-12 text-center">
            <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
              BlissOps Blog
            </div>
            <h1
              className="text-4xl font-semibold tracking-tight text-white md:text-5xl"
              data-testid="text-blog-title"
            >
              Indsigt om AI i enterprise
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-400">
              Guides, produktnyheder og perspektiver på, hvordan virksomheder bruger AI med kontrol og tillid.
            </p>
          </div>

          {/* Featured post */}
          {featured && (
            <div className="mb-8">
              <FeaturedCard post={featured} />
            </div>
          )}

          {/* Grid */}
          <div className="grid gap-5 sm:grid-cols-2">
            {rest.map((post) => (
              <BlogCard key={post.slug} post={post} />
            ))}
          </div>
        </main>

        <div className="mx-auto max-w-5xl px-6 md:px-8">
          <MarketingFooter />
        </div>
      </div>
    </div>
  );
}
