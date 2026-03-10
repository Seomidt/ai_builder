import { defineConfig } from "drizzle-kit";

const url = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;

if (!url) {
  throw new Error("No database URL found. Set SUPABASE_DB_POOL_URL or DATABASE_URL.");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url,
    ssl: process.env.SUPABASE_DB_POOL_URL ? "require" : undefined,
  },
});
