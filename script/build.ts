import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// ── Serverless handler entries ────────────────────────────────────────────────
const HANDLERS: Array<{ name: string; entry: string; out: string }> = [
  { name: "auth",          entry: "api/_src/auth.ts",          out: "api/auth.js"          },
  { name: "dashboard",     entry: "api/_src/dashboard.ts",     out: "api/dashboard.js"     },
  { name: "projects",      entry: "api/_src/projects.ts",      out: "api/projects.js"      },
  { name: "architectures", entry: "api/_src/architectures.ts", out: "api/architectures.js" },
  { name: "runs",          entry: "api/_src/runs.ts",          out: "api/runs.js"          },
  { name: "integrations",  entry: "api/_src/integrations.ts",  out: "api/integrations.js"  },
  { name: "config",        entry: "api/_src/config.ts",        out: "api/config.js"        },
  { name: "analytics",     entry: "api/_src/analytics.ts",     out: "api/analytics.js"     },
  { name: "storage",       entry: "api/_src/storage.ts",       out: "api/storage.js"       },
  { name: "waitlist",      entry: "api/_src/waitlist.ts",      out: "api/waitlist.js"      },
  { name: "tenant",        entry: "api/_src/tenant.ts",        out: "api/tenant.js"        },
  { name: "admin",         entry: "api/_src/admin.ts",         out: "api/admin.js"         },
  { name: "chat",          entry: "api/_src/chat.ts",          out: "api/chat.js"          },
  { name: "extract",       entry: "api/_src/extract.ts",       out: "api/extract.js"       },
  { name: "early-access", entry: "api/_src/early-access.ts",  out: "api/early-access.js"  },
  { name: "kb",           entry: "api/_src/kb.ts",            out: "api/kb.js"            },
  { name: "insights",     entry: "api/_src/insights.ts",      out: "api/insights.js"      },
  { name: "experts",      entry: "api/_src/experts.ts",       out: "api/experts.js"       },
  { name: "upload",      entry: "api/_src/upload.ts",      out: "api/upload.js"      },
  { name: "usage",       entry: "api/_src/usage.ts",       out: "api/usage.js"       },
  { name: "ocr-worker",  entry: "api/_src/ocr-worker.ts",  out: "api/ocr-worker.js"  },
  { name: "ocr-status",  entry: "api/_src/ocr-status.ts",  out: "api/ocr-status.js"  },
  { name: "chat/stream",     entry: "api/_src/chat-stream.ts",     out: "api/chat/stream.js"     },
  { name: "ocr-task-stream", entry: "api/_src/ocr-task-stream.ts", out: "api/ocr-task-stream.js" },
];


const allowlist = [
  "@google/generative-ai",
  "@supabase/supabase-js",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "helmet",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "pdf-parse",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  console.log("building server (Replit / self-hosted)...");
  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  console.log("building Railway worker...");
  await esbuild({
    entryPoints: ["server/worker/railway-worker.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/worker.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    external: externals,
    logLevel: "info",
  });

  // ── Vercel serverless function ────────────────────────────────────────────────
  // Pre-bundled with esbuild to avoid @vercel/node's ncc re-compilation.
  // api/index.js is committed to git so Vercel never needs to compile TypeScript.
  // @shared/* path aliases are resolved at build time by esbuild (not at Vercel deploy).
  // Plugin: stub pg-native so it returns null instead of throwing
  // pg uses optional native bindings (pg-native) — when not installed, it falls
  // back to pure-JS. Without this stub, the bundle throws "Cannot find module".
  const stubPgNative = {
    name: "stub-pg-native",
    setup(build: import("esbuild").PluginBuild) {
      build.onResolve({ filter: /^pg-native$/ }, () => ({
        path: "pg-native",
        namespace: "pg-native-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "pg-native-stub" }, () => ({
        contents: "module.exports = null;",
        loader: "js" as const,
      }));
    },
  };

  // ── Serverless split — one function per route group ──────────────────────
  // No Express, no supabase-js, no drizzle — only Node.js built-ins + fetch.
  // Target sizes: auth/analytics/waitlist <50KB, core routes <150KB, admin <300KB.

  const cjsCompatFooter = [
    "",
    "// Vercel CJS compatibility: expose handler directly on module.exports",
    "if (module.exports && module.exports.__esModule && typeof module.exports.default === 'function') {",
    "  module.exports = module.exports.default;",
    "}",
  ].join("\n");

  const cjsCompatFooterWithConfig = [
    "",
    "// Vercel CJS compatibility: expose handler + config on module.exports",
    "if (module.exports && module.exports.__esModule && typeof module.exports.default === 'function') {",
    "  const _cfg = module.exports.config;",
    "  module.exports = module.exports.default;",
    "  if (_cfg) module.exports.config = _cfg;",
    "}",
  ].join("\n");

  for (const h of HANDLERS) {
    console.log(`building Vercel function: ${h.name} → ${h.out}`);
    const needsConfig = h.name === "chat/stream" || h.name === "ocr-task-stream";
    await esbuild({
      entryPoints: [h.entry],
      platform:    "node",
      bundle:      true,
      format:      "cjs",
      outfile:     h.out,
      tsconfig:    "tsconfig.json",
      define:      { "process.env.NODE_ENV": '"production"' },
      minifySyntax:      true,
      minifyWhitespace:  true,
      minifyIdentifiers: false,
      plugins:     [stubPgNative],
      logLevel:    "info",
      banner:      { js: `// @vercel-bundled [${h.name}] — esbuild pre-compiled, do not edit\n` },
      footer:      { js: needsConfig ? cjsCompatFooterWithConfig : cjsCompatFooter },
    });
  }

  console.log("build complete.");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
