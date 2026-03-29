import { Link, useParams } from "wouter";
import { ArrowLeft, Clock, Calendar } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { BLOG_POSTS, CategoryBadge } from "./BlogPage";

function renderBody(body: string) {
  return body.split("\n\n").map((block, i) => {
    if (block.startsWith("**") && block.endsWith("**")) {
      return (
        <h3 key={i} className="mt-8 mb-3 text-lg font-semibold text-white">
          {block.slice(2, -2)}
        </h3>
      );
    }
    // Inline bold within paragraph
    const parts = block.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i} className="leading-8 text-slate-300">
        {parts.map((part, j) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={j} className="font-semibold text-white">
              {part.slice(2, -2)}
            </strong>
          ) : (
            part
          ),
        )}
      </p>
    );
  });
}

export default function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const post = BLOG_POSTS.find((p) => p.slug === slug);

  if (!post) {
    return (
      <div className="min-h-screen bg-[#030711] text-white">
        <div className="relative z-10">
          <MarketingNav />
          <div className="mx-auto max-w-2xl px-6 pt-24 text-center md:px-8">
            <h1 className="text-3xl font-semibold text-white">Post not found</h1>
            <p className="mt-4 text-slate-400">This article doesn't exist or may have been moved.</p>
            <Link
              href="/blog"
              className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-sky-400 hover:text-sky-300"
              data-testid="link-blog-back-404"
            >
              <ArrowLeft className="h-4 w-4" /> Back to blog
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const others = BLOG_POSTS.filter((p) => p.slug !== slug).slice(0, 2);

  return (
    <div className="min-h-screen bg-[#030711] text-white">
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
            opacity: 0.12,
          }}
        />
        <div className="absolute left-1/4 top-0 h-[400px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(30,64,175,0.28),transparent_65%)] blur-2xl" />
        <div className="absolute inset-0 bg-[#030711]/40" />
      </div>

      <div className="relative z-10">
        <MarketingNav />

        <main className="mx-auto max-w-2xl px-6 pb-24 pt-12 md:px-8">
          {/* Back */}
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-white"
            data-testid="link-blog-back"
          >
            <ArrowLeft className="h-4 w-4" />
            All articles
          </Link>

          {/* Header */}
          <div className="mt-8">
            <div className="flex flex-wrap items-center gap-3">
              <CategoryBadge category={post.category} />
            </div>
            <h1
              className="mt-5 text-3xl font-semibold leading-tight text-white md:text-4xl"
              data-testid="text-post-title"
            >
              {post.title}
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-400">
              {post.excerpt}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-5 border-b border-white/8 pb-8 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {post.date}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {post.readTime} min read
              </span>
              <span className="font-medium text-slate-400">
                {post.author} · {post.authorRole}
              </span>
            </div>
          </div>

          {/* Body */}
          <article
            className="mt-8 space-y-5"
            data-testid="text-post-body"
          >
            {renderBody(post.body)}
          </article>

          {/* CTA */}
          <div className="mt-14 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-7 text-center backdrop-blur-xl">
            <p className="text-sm font-medium text-white">
              Ready to deploy AI Experts in your organization?
            </p>
            <p className="mt-1 text-sm text-slate-400">
              Join the private rollout — selected teams get priority onboarding.
            </p>
            <Link
              href="/early-access"
              className="mt-5 inline-flex items-center gap-2 rounded-xl border border-sky-500/40 bg-[#060d1f]/80 px-6 py-2.5 text-sm font-medium text-white transition hover:border-sky-400/60 hover:bg-sky-500/10"
              data-testid="link-post-early-access"
            >
              Get Early Access
            </Link>
          </div>

          {/* More articles */}
          {others.length > 0 && (
            <div className="mt-14">
              <p className="mb-5 text-xs font-semibold uppercase tracking-widest text-slate-500">
                More articles
              </p>
              <div className="space-y-4">
                {others.map((other) => (
                  <Link
                    key={other.slug}
                    href={`/blog/${other.slug}`}
                    data-testid={`link-related-${other.slug}`}
                    className="group flex items-start justify-between gap-4 rounded-xl border border-white/8 bg-[#060d1f]/50 p-5 transition hover:border-sky-500/20 hover:bg-[#060d1f]/80"
                  >
                    <div>
                      <CategoryBadge category={other.category} />
                      <p className="mt-2 text-sm font-medium text-white group-hover:text-sky-100">
                        {other.title}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{other.readTime} min read</p>
                    </div>
                    <ArrowLeft className="mt-1 h-4 w-4 shrink-0 rotate-180 text-slate-600 transition group-hover:text-sky-400" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </main>

        <div className="mx-auto max-w-2xl px-6 md:px-8">
          <MarketingFooter />
        </div>
      </div>
    </div>
  );
}
