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
    <div className="min-h-screen overflow-x-hidden bg-white">
      {/* Header with nav */}
      <div className="bg-white border-b border-gray-200">
        <div className="relative z-10">
          <MarketingNav />
        </div>
      </div>

      {/* Blog content */}
      <main className="bg-white text-gray-900">
        <div className="mx-auto max-w-4xl px-6 pb-24 pt-14 md:px-8">
          <div
            id="soro-blog"
            data-testid="soro-blog-embed"
            style={{ color: "#111827" }}
          />
        </div>
      </main>

      <div className="bg-white border-t border-gray-200">
        <div className="mx-auto max-w-5xl px-6 md:px-8">
          <MarketingFooter />
        </div>
      </div>
    </div>
  );
}
