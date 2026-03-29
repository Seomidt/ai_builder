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
  body: string;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "what-is-an-ai-expert",
    title: "What Is an AI Expert — and Why Your Team Needs One",
    excerpt:
      "AI Experts are not chatbots. They are specialized AI agents configured with company-specific knowledge, roles, and rules — operating precisely within the boundaries you define.",
    category: "Product",
    readTime: 6,
    date: "March 24, 2025",
    author: "BlissOps Team",
    authorRole: "Platform",
    featured: true,
    body: `AI Experts are purpose-built AI agents — not generic assistants. Each Expert is scoped to a specific role: your internal legal advisor, your onboarding guide, your data analyst. They don't guess. They work within the knowledge base you've given them, following the rules you've set.

**Why this matters**

Generic AI tools suffer from a fundamental problem: they know everything about the world but nothing about your business. An AI Expert solves this by combining a powerful language model with your company's documents, processes, and policies — in a tenant-isolated environment only your team can access.

**How it works in BlissOps**

You configure an Expert by defining its role, uploading its knowledge base (documents, PDFs, structured data), and setting operational boundaries. The Expert then responds to queries strictly within that scope — no hallucinations about things it hasn't been given, no access to other tenants' data.

**Control at every level**

With BlissOps, you don't just configure Experts — you govern them. Set usage limits, assign them to specific projects or user groups, and audit every interaction. This is AI that your compliance team can actually sign off on.

Getting started is straightforward. Define the Expert's purpose, load its knowledge, set its rules, and deploy it to your team. Most organizations are running their first Expert within a day.`,
  },
  {
    slug: "ai-and-data-security",
    title: "How to Deploy AI Without Compromising Data Security",
    excerpt:
      "Many organizations hold back on AI because they fear data leaks and compliance issues. Here's how tenant-isolated architecture and fine-grained access control solve the most critical security challenges.",
    category: "Security",
    readTime: 8,
    date: "March 17, 2025",
    author: "BlissOps Team",
    authorRole: "Security",
    body: `Enterprise AI adoption is often blocked not by technology but by a single question from the security or legal team: "Where does our data go?"

It's a fair question. Most AI tools send your data to shared infrastructure, use it to improve their models, and give you limited visibility into what actually happens under the hood.

**The tenant isolation model**

BlissOps is built on strict tenant isolation. Every organization gets its own isolated data environment — no shared storage, no cross-tenant queries, no possibility of data bleeding between customers. Your knowledge bases, conversation logs, and configuration are yours, partitioned at the infrastructure level.

**Access control that maps to your org**

Role-based access control isn't a feature — it's the foundation. Every action inside BlissOps — creating an Expert, uploading documents, running a query — is gated by your organization's permission model. Admins see everything. Operators see their projects. End users see only what they're allowed to see.

**Audit trails for compliance**

Every query, every response, every configuration change is logged with a full audit trail. When your compliance team needs to demonstrate what data was accessed, by whom, and when, that information is there — searchable, exportable, and tamper-evident.

**A practical checklist**

Before deploying AI in your organization, ask: Is our data isolated from other tenants? Can we control which users access which AI capabilities? Do we have logs for every interaction? With BlissOps, the answer to all three is yes.`,
  },
  {
    slug: "5-ai-use-cases-with-roi",
    title: "5 Use Cases Where AI Experts Deliver Measurable ROI",
    excerpt:
      "From internal knowledge bases to automated customer support — here are five concrete scenarios where organizations use BlissOps AI Experts and see results that show up on the bottom line.",
    category: "Business",
    readTime: 7,
    date: "March 10, 2025",
    author: "BlissOps Team",
    authorRole: "Business",
    body: `AI is only valuable if it saves time, reduces cost, or creates revenue. Here are five use cases where organizations consistently see measurable returns.

**1. Internal knowledge base**

Replace the endless Slack questions and wiki hunts with an Expert that knows your internal documentation. Employees get accurate answers in seconds instead of waiting for the one person who knows. Typical time savings: 2–4 hours per employee per week.

**2. Customer support tier 1**

An Expert trained on your product documentation, FAQ, and support history handles the majority of tier-1 support tickets without human intervention. Ticket deflection rates of 40–60% are common, with customer satisfaction scores that meet or exceed human agents for routine queries.

**3. HR and onboarding**

New hires have hundreds of questions in their first weeks. An onboarding Expert answers them instantly, consistently, and at any hour. HR teams report spending significantly less time on repetitive questions and more time on high-value work.

**4. Legal and compliance review**

An Expert trained on your internal policies, contracts, and regulatory requirements can do first-pass review of documents, flag potential issues, and provide guidance — reducing outside counsel spend for routine matters.

**5. Sales enablement**

Sales teams need fast, accurate answers about product capabilities, pricing, and competitive positioning. An Expert trained on your sales materials and product documentation keeps every rep aligned and responsive.

The common thread across all five: an AI Expert doesn't replace your team. It removes the repetitive, low-value work so your people can focus on what actually requires human judgment.`,
  },
  {
    slug: "multi-tenant-ai-platform",
    title: "How Multi-Tenant Architecture Is Reshaping Enterprise AI",
    excerpt:
      "A look at what multi-tenancy means in an AI context, and why it's the only scalable model for organizations with strict requirements around data isolation and role-based access.",
    category: "Technology",
    readTime: 9,
    date: "March 3, 2025",
    author: "BlissOps Team",
    authorRole: "Engineering",
    body: `The term "multi-tenant" comes from SaaS — it means multiple customers sharing an infrastructure while remaining logically separated. In AI, the stakes are higher.

When the data being processed is proprietary business information — contracts, employee records, financial data, strategic plans — "logically separated" isn't enough. You need architectural guarantees.

**What multi-tenancy means in AI**

In a properly multi-tenant AI platform, tenant data never touches other tenants' data paths. Knowledge bases are partitioned at the storage level. Retrieval and generation pipelines are scoped to the requesting tenant. Logs and audit trails are tenant-specific. No query can return results from another organization's data, not by accident and not by exploit.

**Why this enables enterprise deployment**

Most AI tools are built for individuals or small teams. They assume a single user context. Enterprise deployment requires a fundamentally different architecture — one where you can define which users in which roles have access to which AI capabilities, and where that access is enforced at every layer.

**Scalability without security tradeoffs**

The right multi-tenant architecture scales horizontally without weakening isolation. Adding a new tenant doesn't affect existing tenants' performance or security posture. This is what makes it possible to run hundreds or thousands of organizations on the same platform without compromise.

BlissOps was designed from the ground up with this model. Every component — from document ingestion to Expert configuration to query execution — enforces tenant boundaries. It's not a layer added on top. It's the foundation.`,
  },
  {
    slug: "ai-governance-in-practice",
    title: "AI Governance in Practice: Rules, Access, and Audit Trails",
    excerpt:
      "What does it actually mean to have control over AI in your organization? We break down what governance covers — from access permissions and usage limits to audit trails and compliance reporting.",
    category: "Governance",
    readTime: 5,
    date: "February 24, 2025",
    author: "BlissOps Team",
    authorRole: "Compliance",
    body: `"AI governance" is a term that gets used loosely. For some, it means having a policy document. For others, it means a technical control framework. In practice, effective AI governance requires both.

**Access control**

Who can create AI Experts? Who can upload knowledge? Who can run queries? Governance starts with a clear permission model that maps to your organizational structure — admins, operators, and end users each with appropriate capabilities.

**Usage limits**

Unbounded AI usage creates unpredictable costs and unpredictable outputs. Governance means setting operational boundaries: how many queries can run per project, per user, per time period. These limits aren't just financial controls — they're risk controls.

**Content rules**

Experts can be configured with rules about what they will and won't discuss. A customer-facing Expert shouldn't speculate about unreleased products. An HR Expert shouldn't provide legal advice. These guardrails are part of governance, and they should be documented and enforced systematically.

**Audit trails**

A complete audit trail means you can answer: What did the AI say to this user on this date? Which documents were used to generate that answer? Who configured this Expert, and when? These questions matter for incident response, compliance audits, and continuous improvement.

**Reporting**

Governance without visibility is governance on paper only. Effective AI governance includes regular reporting on usage patterns, error rates, and policy adherence — so you can identify issues before they become incidents.

The organizations that deploy AI successfully aren't the ones that move fastest. They're the ones that build the right controls from the start, so they can scale with confidence.`,
  },
];

const CATEGORY_COLORS: Record<string, string> = {
  Product:    "border-sky-400/30 bg-sky-500/10 text-sky-300",
  Security:   "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  Business:   "border-violet-400/30 bg-violet-500/10 text-violet-300",
  Technology: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  Governance: "border-rose-400/30 bg-rose-500/10 text-rose-300",
};

export function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? "border-white/10 bg-white/5 text-slate-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${cls}`}>
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
      <div className="pointer-events-none absolute inset-0 rounded-[20px] bg-[radial-gradient(circle_at_60%_0%,rgba(30,64,175,0.18),transparent_60%)]" />
      <div className="relative">
        <div className="flex flex-wrap items-center gap-3">
          <CategoryBadge category={post.category} />
          <span className="rounded-full border border-sky-400/20 bg-sky-500/8 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
            Featured
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
            {post.readTime} min read
          </span>
          <span className="font-medium text-slate-400">{post.author}</span>
        </div>
        <div className="mt-7 inline-flex items-center gap-2 text-sm font-medium text-sky-400 transition group-hover:gap-3">
          Read article <ArrowRight className="h-4 w-4" />
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
      <div className="mt-auto flex items-center justify-between pt-5 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {post.readTime} min
        </span>
        <span>{post.date}</span>
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 transition group-hover:gap-2.5">
        Read more <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}

export default function BlogPage() {
  const featured = BLOG_POSTS.find((p) => p.featured);
  const rest = BLOG_POSTS.filter((p) => !p.featured);

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
          <div className="mb-12 text-center">
            <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
              BlissOps Blog
            </div>
            <h1
              className="text-4xl font-semibold tracking-tight text-white md:text-5xl"
              data-testid="text-blog-title"
            >
              Insights on Enterprise AI
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-400">
              Guides, product updates, and perspectives on deploying AI with control and confidence.
            </p>
          </div>

          {featured && (
            <div className="mb-8">
              <FeaturedCard post={featured} />
            </div>
          )}

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
