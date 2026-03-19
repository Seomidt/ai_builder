/**
 * validate-env-enforcement.ts
 * Phase: ENV Enforcement (Fail Fast Boot)
 *
 * Verifies that:
 * 1. env.ts is imported FIRST in server/index.ts and server/vercel-handler.ts
 * 2. Key server files use env.X instead of process.env.X for the 5 governed vars
 * 3. assertProductionSafe() is defined in env.ts
 * 4. No direct process.env usage remains for the 5 governed vars in key files
 */

import * as fs from "fs";
import * as path from "path";

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  failed++;
}

function readFile(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), "utf-8");
}

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

// ── tests ────────────────────────────────────────────────────────────────────

section("S01: env.ts structure");
{
  const content = readFile("server/lib/env.ts");

  const vars = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
    "APP_ENV",
  ];

  for (const v of vars) {
    if (content.includes(v)) ok(`env.ts defines ${v}`);
    else fail(`env.ts missing ${v}`);
  }

  if (content.includes("function required")) ok("env.ts has required() helper");
  else fail("env.ts missing required() helper");

  if (content.includes("function optional")) ok("env.ts has optional() helper");
  else fail("env.ts missing optional() helper");

  if (content.includes("assertProductionSafe")) ok("env.ts has assertProductionSafe()");
  else fail("env.ts missing assertProductionSafe()");

  if (content.includes("OPENAI_API_KEY.startsWith")) ok("assertProductionSafe checks key format");
  else fail("assertProductionSafe missing key format check");

  if (content.includes("Missing env:")) ok('required() throws "Missing env: X"');
  else fail('required() missing "Missing env:" message');
}

section("S02: env.ts imported FIRST in server/index.ts");
{
  const content = readFile("server/index.ts");
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const firstImport = lines.find(l => l.startsWith("import "));

  if (firstImport === 'import "./lib/env";') {
    ok('server/index.ts: first import is "./lib/env"');
  } else {
    fail("server/index.ts: first import is NOT env", firstImport ?? "(none)");
  }
}

section("S03: env.ts imported FIRST in server/vercel-handler.ts");
{
  const content = readFile("server/vercel-handler.ts");
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const firstImport = lines.find(l => l.startsWith("import "));

  if (firstImport === 'import "./lib/env";') {
    ok('vercel-handler.ts: first import is "./lib/env"');
  } else {
    fail("vercel-handler.ts: first import is NOT env", firstImport ?? "(none)");
  }
}

section("S04: server/lib/supabase.ts uses env.*");
{
  const content = readFile("server/lib/supabase.ts");

  if (content.includes('from "./env"')) ok("supabase.ts imports from env");
  else fail("supabase.ts does not import env");

  const rawVars = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
  for (const v of rawVars) {
    const rawUsage = new RegExp(`process\\.env\\.${v}`).test(content);
    if (!rawUsage) ok(`supabase.ts: no direct process.env.${v}`);
    else fail(`supabase.ts: still uses process.env.${v}`);
  }

  if (content.includes("env.SUPABASE_URL")) ok("supabase.ts uses env.SUPABASE_URL");
  else fail("supabase.ts missing env.SUPABASE_URL");

  if (content.includes("env.SUPABASE_SERVICE_ROLE_KEY")) ok("supabase.ts uses env.SUPABASE_SERVICE_ROLE_KEY");
  else fail("supabase.ts missing env.SUPABASE_SERVICE_ROLE_KEY");

  if (content.includes("env.SUPABASE_ANON_KEY")) ok("supabase.ts uses env.SUPABASE_ANON_KEY");
  else fail("supabase.ts missing env.SUPABASE_ANON_KEY");

  const hasManualThrow = content.includes("throw new Error(\"SUPABASE_URL is required\")");
  if (!hasManualThrow) ok("supabase.ts: redundant manual throw removed");
  else fail("supabase.ts: still has manual throw (now redundant)");
}

section("S05: server/lib/openai-client.ts uses env.*");
{
  const content = readFile("server/lib/openai-client.ts");

  if (content.includes('from "./env"')) ok("openai-client.ts imports from env");
  else fail("openai-client.ts does not import env");

  if (!/process\.env\.OPENAI_API_KEY/.test(content)) ok("openai-client.ts: no direct process.env.OPENAI_API_KEY");
  else fail("openai-client.ts: still uses process.env.OPENAI_API_KEY");

  if (content.includes("env.OPENAI_API_KEY")) ok("openai-client.ts uses env.OPENAI_API_KEY");
  else fail("openai-client.ts missing env.OPENAI_API_KEY");
}

section("S06: server/lib/ai-ops/orchestrator.ts uses env.*");
{
  const content = readFile("server/lib/ai-ops/orchestrator.ts");

  if (content.includes('from "../env"')) ok("orchestrator.ts imports from env");
  else fail("orchestrator.ts does not import env");

  if (!/process\.env\.OPENAI_API_KEY/.test(content)) ok("orchestrator.ts: no direct process.env.OPENAI_API_KEY");
  else fail("orchestrator.ts: still uses process.env.OPENAI_API_KEY");

  if (content.includes("env.OPENAI_API_KEY")) ok("orchestrator.ts uses env.OPENAI_API_KEY");
  else fail("orchestrator.ts missing env.OPENAI_API_KEY");
}

section("S07: server/routes/auth-platform.ts uses env.*");
{
  const content = readFile("server/routes/auth-platform.ts");

  if (content.includes('from "../lib/env"')) ok("auth-platform.ts imports from env");
  else fail("auth-platform.ts does not import env");

  if (!/process\.env\.SUPABASE_URL/.test(content)) ok("auth-platform.ts: no direct process.env.SUPABASE_URL");
  else fail("auth-platform.ts: still uses process.env.SUPABASE_URL");

  if (!/process\.env\.SUPABASE_ANON_KEY/.test(content)) ok("auth-platform.ts: no direct process.env.SUPABASE_ANON_KEY");
  else fail("auth-platform.ts: still uses process.env.SUPABASE_ANON_KEY");

  if (content.includes("env.SUPABASE_URL")) ok("auth-platform.ts uses env.SUPABASE_URL");
  else fail("auth-platform.ts missing env.SUPABASE_URL");

  if (content.includes("env.SUPABASE_ANON_KEY")) ok("auth-platform.ts uses env.SUPABASE_ANON_KEY");
  else fail("auth-platform.ts missing env.SUPABASE_ANON_KEY");
}

section("S08: Fail-fast import — env.ts can be executed");
{
  const { execSync } = await import("child_process");
  try {
    execSync(
      `npx tsx -e "import('./server/lib/env.ts').then(() => process.exit(0)).catch(e => { process.stderr.write(e.message); process.exit(1); })"`,
      { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] },
    );
    ok("env.ts executes without crash (all required vars present)");
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() ?? e.message ?? "";
    if (stderr.includes("Missing env:")) {
      fail(`env.ts crash — required var missing: ${stderr.trim()}`);
    } else {
      fail("env.ts threw unexpected error", stderr.trim().slice(0, 200));
    }
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("ENV Enforcement Validation Complete");
console.log(`${"═".repeat(60)}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log(`${"═".repeat(60)}`);

if (failed === 0) {
  console.log("✅ ALL ASSERTIONS PASSED");
  process.exit(0);
} else {
  console.error(`❌ ${failed} ASSERTION(S) FAILED`);
  process.exit(1);
}
