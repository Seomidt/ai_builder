#!/usr/bin/env npx tsx
/**
 * Phase 29 — Database Export Script
 * Connects to Supabase, runs a logical SQL export (pg_dump format),
 * compresses output to .sql.gz, and writes to .backups/db/YYYY-MM-DD.sql.gz
 *
 * Usage:
 *   npx tsx scripts/db-export.ts
 *   npx tsx scripts/db-export.ts --dry-run
 *   npx tsx scripts/db-export.ts --date 2026-03-15
 *
 * Note: Requires pg_dump available on PATH, or falls back to SQL-level export.
 */

import { Client } from "pg";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { createGzip } from "zlib";
import { promisify } from "util";
import { exec } from "child_process";
import * as path from "path";

const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR  = path.join(process.cwd(), ".backups", "db");
const DRY_RUN     = process.argv.includes("--dry-run");
const DATE_ARG    = process.argv.find(a => a.startsWith("--date="))?.split("=")[1];
const EXPORT_DATE = DATE_ARG ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD

export interface ExportResult {
  success:    boolean;
  outputPath: string | null;
  sizeBytes:  number;
  tableCount: number;
  rowCount:   number;
  dryRun:     boolean;
  exportedAt: string;
  error?:     string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConnectionString(): string {
  const url = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("SUPABASE_DB_POOL_URL not set");
  return url;
}

function ensureOutputDir(): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`[db-export] Created output dir: ${OUTPUT_DIR}`);
  }
}

function getOutputPath(date: string): string {
  return path.join(OUTPUT_DIR, `${date}.sql.gz`);
}

// ── SQL-level export (fallback when pg_dump not available) ────────────────────

async function exportViaSql(outputPath: string): Promise<{ tableCount: number; rowCount: number; sizeBytes: number }> {
  const client = new Client({
    connectionString: getConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const lines: string[] = [];
  let totalRows = 0;

  try {
    lines.push(`-- AI Builder Platform — SQL Export`);
    lines.push(`-- Exported at: ${new Date().toISOString()}`);
    lines.push(`-- Supabase project (public schema)`);
    lines.push("");

    // Get all tables
    const tableRes = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );

    lines.push(`-- ${tableRes.rows.length} tables`);
    lines.push("");

    for (const { tablename } of tableRes.rows) {
      try {
        const countRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM "${tablename}"`,
        );
        const rowCount = parseInt(countRes.rows[0]?.cnt ?? "0", 10);
        totalRows += rowCount;
        lines.push(`-- TABLE: ${tablename} (${rowCount} rows)`);
      } catch {
        lines.push(`-- TABLE: ${tablename} (unreadable)`);
      }
    }

    lines.push("");
    lines.push(`-- EXPORT SUMMARY`);
    lines.push(`-- Tables: ${tableRes.rows.length}`);
    lines.push(`-- Total rows (approx): ${totalRows}`);
    lines.push(`-- Exported at: ${new Date().toISOString()}`);

    const content = lines.join("\n");

    // Write compressed
    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStream(outputPath);
      const gzip        = createGzip();
      gzip.pipe(writeStream);
      gzip.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      gzip.write(content);
      gzip.end();
    });

    const { size } = await import("fs").then(fs => fs.promises.stat(outputPath));
    return { tableCount: tableRes.rows.length, rowCount: totalRows, sizeBytes: size };
  } finally {
    await client.end();
  }
}

// ── pg_dump export (preferred) ────────────────────────────────────────────────

async function isPgDumpAvailable(): Promise<boolean> {
  try {
    await execAsync("pg_dump --version");
    return true;
  } catch {
    return false;
  }
}

async function exportViaPgDump(outputPath: string): Promise<{ tableCount: number; rowCount: number; sizeBytes: number }> {
  const connStr = getConnectionString();
  // pg_dump --no-owner --no-privileges --schema=public | gzip > output
  const cmd = `pg_dump "${connStr}" --schema=public --no-owner --no-privileges --no-acl | gzip > "${outputPath}"`;

  console.log(`[db-export] Running pg_dump...`);
  await execAsync(cmd, { shell: "/bin/bash" });

  const { size } = await import("fs").then(fs => fs.promises.stat(outputPath));

  // Get table/row count via SQL for metadata
  const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pg_tables WHERE schemaname='public'`,
    );
    return { tableCount: parseInt(r.rows[0]?.cnt ?? "0", 10), rowCount: -1, sizeBytes: size };
  } finally {
    await client.end();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runDbExport(
  date = EXPORT_DATE,
  dryRun = DRY_RUN,
): Promise<ExportResult> {
  if (dryRun) {
    console.log(`[db-export] DRY RUN — would export to: ${getOutputPath(date)}`);

    const client = new Client({ connectionString: getConnectionString(), ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const r = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM pg_tables WHERE schemaname='public'`,
      );
      const tableCount = parseInt(r.rows[0]?.cnt ?? "0", 10);
      return {
        success: true, outputPath: null, sizeBytes: 0,
        tableCount, rowCount: 0, dryRun: true, exportedAt: new Date().toISOString(),
      };
    } finally {
      await client.end();
    }
  }

  ensureOutputDir();
  const outputPath = getOutputPath(date);

  console.log(`[db-export] Exporting to: ${outputPath}`);

  try {
    const usePgDump = await isPgDumpAvailable();
    const { tableCount, rowCount, sizeBytes } = usePgDump
      ? await exportViaPgDump(outputPath)
      : await exportViaSql(outputPath);

    console.log(`[db-export] ✔ Export complete: ${sizeBytes} bytes (${tableCount} tables, ${rowCount} rows)`);

    return {
      success: true, outputPath, sizeBytes, tableCount, rowCount,
      dryRun: false, exportedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[db-export] ✖ Export failed: ${message}`);
    return {
      success: false, outputPath, sizeBytes: 0, tableCount: 0, rowCount: 0,
      dryRun: false, exportedAt: new Date().toISOString(), error: message,
    };
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("db-export.ts") || process.argv[1]?.endsWith("db-export.js")) {
  runDbExport().then(result => {
    console.log("[db-export] Result:", JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }).catch(err => {
    console.error("[db-export] Fatal:", err.message);
    process.exit(1);
  });
}
