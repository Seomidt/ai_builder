import { useEffect } from "react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

const SORO_EMBED_ID = "8c4616e7-9f43-45f2-9f0a-40eea11c3390";

export default function BlogPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const post = params.get("post");
    const src =
      `https://app.trysoro.com/api/embed/${SORO_EMBED_ID}` +
      (post ? `?post=${encodeURIComponent(post)}` : "");

    const script = document.createElement("script");
    script.src = src;
    script.async = true;

    const container = document.getElementById("soro-blog");
    if (container) {
      container.after(script);
    } else {
      document.body.appendChild(script);
    }

    return () => {
      script.remove();
    };
  }, []);

  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* Dark hero header for the nav */}
      <div className="bg-[#030711] text-white">
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
          <div className="absolute inset-0 bg-[#030711]/40" />
        </div>
        <div className="relative z-10">
          <MarketingNav />
        </div>
      </div>

      {/* Blog content — light background so Soro embed text is readable */}
      <main className="bg-white text-gray-900">
        <div className="mx-auto max-w-4xl px-6 pb-24 pt-14 md:px-8">
          <div
            id="soro-blog"
            data-testid="soro-blog-embed"
            style={{ color: "#111827" }}
          />
        </div>
      </main>

      <div className="bg-[#030711] text-white">
        <div className="mx-auto max-w-5xl px-6 md:px-8">
          <MarketingFooter />
        </div>
      </div>
    </div>
  );
}
