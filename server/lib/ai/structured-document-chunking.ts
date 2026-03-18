/**
 * structured-document-chunking.ts — Phase 5B.1
 *
 * Table-aware chunking strategy for structured (spreadsheet-like) documents.
 *
 * Design rules:
 * - Deterministic: same input + config + strategy => same chunk keys/hashes
 * - Chunk keys are content-addressable, not random
 * - Sheet boundaries preserved — never merged across sheets
 * - Row ordering stable and deterministic
 * - Header context included in every chunk for later embedding/attribution
 * - Do NOT create embeddings here
 * - Do NOT mark index_state='indexed'
 */

import { createHash } from "crypto";
import type { NormalizedSheet, StructuredParseResult } from "./structured-document-parsers";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StructuredChunkingConfig {
  strategy: string;
  version: string;
  rowWindowSize: number;
  includeHeaders: boolean;
}

export const DEFAULT_STRUCTURED_CHUNKING_CONFIG: StructuredChunkingConfig = {
  strategy: "table_rows",
  version: "1.0",
  rowWindowSize: 10,
  includeHeaders: true,
};

export interface StructuredChunkCandidate {
  chunkIndex: number;
  chunkKey: string;
  chunkHash: string;
  chunkText: string;
  sheetName: string;
  rowStart: number;
  rowEnd: number;
  columnHeaders: string[];
  tableChunkStrategy: string;
  tableChunkVersion: string;
  tokenEstimate: number;
}

// ─── Deterministic key and hash builders ────────────────────────────────────

export function buildStructuredChunkKey(
  documentId: string,
  versionId: string,
  sheetName: string,
  rowStart: number,
  rowEnd: number,
  strategy: string,
  version: string,
): string {
  const canonical = `${documentId}|${versionId}|${sheetName}|${rowStart}:${rowEnd}|${strategy}@${version}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildStructuredChunkHash(
  chunkText: string,
  strategy: string,
  version: string,
): string {
  const canonical = `${strategy}@${version}|${chunkText}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function normalizeStructuredChunkText(
  sheet: NormalizedSheet,
  rowStart: number,
  rowEnd: number,
  includeHeaders: boolean,
): string {
  const lines: string[] = [];

  if (includeHeaders && sheet.headers.length > 0) {
    lines.push(`Sheet: ${sheet.sheetName}`);
    lines.push(`Headers: ${sheet.headers.join(" | ")}`);
    lines.push("---");
  } else {
    lines.push(`Sheet: ${sheet.sheetName}`);
    lines.push("---");
  }

  const sliceRows = sheet.rows.slice(rowStart, rowEnd + 1);
  for (const row of sliceRows) {
    if (sheet.headers.length > 0 && sheet.headers.length === row.length) {
      const paired = sheet.headers.map((h, i) => `${h}: ${row[i] ?? ""}`);
      lines.push(paired.join(" | "));
    } else {
      lines.push(row.join(" | "));
    }
  }

  return lines.join("\n");
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Main chunking entry point ───────────────────────────────────────────────

export function chunkStructuredDocument(
  parseResult: StructuredParseResult,
  documentId: string,
  versionId: string,
  config: Partial<StructuredChunkingConfig> = {},
): StructuredChunkCandidate[] {
  const cfg: StructuredChunkingConfig = {
    ...DEFAULT_STRUCTURED_CHUNKING_CONFIG,
    ...config,
  };

  const chunks: StructuredChunkCandidate[] = [];
  let globalChunkIndex = 0;

  for (const sheet of parseResult.sheets) {
    if (sheet.rows.length === 0) {
      continue;
    }

    const { rowWindowSize } = cfg;
    let rowCursor = 0;

    while (rowCursor < sheet.rows.length) {
      const rowStart = rowCursor;
      const rowEnd = Math.min(rowCursor + rowWindowSize - 1, sheet.rows.length - 1);

      const chunkText = normalizeStructuredChunkText(
        sheet,
        rowStart,
        rowEnd,
        cfg.includeHeaders,
      );

      const chunkKey = buildStructuredChunkKey(
        documentId,
        versionId,
        sheet.sheetName,
        rowStart,
        rowEnd,
        cfg.strategy,
        cfg.version,
      );

      const chunkHash = buildStructuredChunkHash(chunkText, cfg.strategy, cfg.version);

      chunks.push({
        chunkIndex: globalChunkIndex,
        chunkKey,
        chunkHash,
        chunkText,
        sheetName: sheet.sheetName,
        rowStart,
        rowEnd,
        columnHeaders: sheet.headers,
        tableChunkStrategy: cfg.strategy,
        tableChunkVersion: cfg.version,
        tokenEstimate: estimateTokenCount(chunkText),
      });

      globalChunkIndex++;
      rowCursor += rowWindowSize;
    }
  }

  return chunks;
}

export function summarizeStructuredChunks(chunks: StructuredChunkCandidate[]): string {
  const sheets = Array.from(new Set(chunks.map((c) => c.sheetName)));
  const totalRows = chunks.reduce((acc, c) => acc + (c.rowEnd - c.rowStart + 1), 0);
  return `chunks=${chunks.length} sheets=${sheets.join(",")} totalRows=${totalRows}`;
}
