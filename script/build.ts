import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

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

  // ── Vercel serverless function ────────────────────────────────────────────────
  // Pre-bundled with esbuild to avoid @vercel/node's ncc re-compilation.
  // api/index.js is committed to git so Vercel never needs to compile TypeScript.
  // @shared/* path aliases are resolved at build time by esbuild (not at Vercel deploy).
  console.log("building Vercel serverless function (api/index.js)...");
  await esbuild({
    entryPoints: ["server/vercel-entry.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "api/index.js",
    tsconfig: "tsconfig.json",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    external: ["pg-native"],
    logLevel: "info",
    banner: {
      js: "// @vercel-bundled — esbuild pre-compiled, do not edit\n",
    },
  });

  console.log("build complete.");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
