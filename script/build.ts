import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile, mkdir, cp } from "fs/promises";
import { join } from "path";

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
  await rm(".vercel/output", { recursive: true, force: true });

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

  // ─── Vercel Build Output API v3 ──────────────────────────────────────────────
  // Outputs to .vercel/output/ so Vercel uses our pre-built function directly,
  // WITHOUT re-bundling through @vercel/node's ncc.

  const funcDir = ".vercel/output/functions/api/index.func";
  const staticDir = ".vercel/output/static";

  await mkdir(funcDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });

  console.log("building Vercel serverless function...");
  await esbuild({
    entryPoints: ["server/vercel-entry.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: join(funcDir, "index.mjs"),
    tsconfig: "tsconfig.json",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    external: ["pg-native"],
    logLevel: "info",
  });

  // Function config — tells Vercel runtime + memory + maxDuration
  await writeFile(
    join(funcDir, ".vc-config.json"),
    JSON.stringify({
      runtime: "nodejs20.x",
      handler: "index.mjs",
      memory: 1024,
      maxDuration: 30,
      launcherType: "Nodejs",
    }),
  );

  // Copy static frontend assets from dist/public/ to .vercel/output/static/
  console.log("copying static assets to Vercel output...");
  await cp("dist/public", staticDir, { recursive: true });

  // Build Output API config — routes and headers
  const outputConfig = {
    version: 3,
    routes: [
      // API routes → serverless function
      { src: "/api/(.*)", dest: "/api/index" },
      // Static assets with long cache
      {
        src: "/assets/(.*)",
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      },
      // Security headers on all routes
      {
        src: "/(.*)",
        headers: {
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
        continue: true,
      },
      // SPA fallback — all non-file paths serve index.html
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index.html" },
    ],
  };

  await writeFile(
    ".vercel/output/config.json",
    JSON.stringify(outputConfig, null, 2),
  );

  console.log("Vercel Build Output API v3 ready at .vercel/output/");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
