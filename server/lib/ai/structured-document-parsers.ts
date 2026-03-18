/**
 * structured-document-parsers.ts — Phase 5B.1
 *
 * Structured document parsing for spreadsheet-like content.
 * Supports: CSV, TSV. XLSX: explicit unsupported failure (INV-SP11).
 *
 * Design rules:
 * - Deterministic: same input + config => same output
 * - Fail explicitly on unsupported/malformed/unsafe content
 * - Preserve sheet identity, row order, header context
 * - Do NOT silently flatten structure away
 */

import { createHash } from "crypto";
import { KnowledgeInvariantError } from "./knowledge-bases";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface NormalizedSheet {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  rows: string[][];
  warnings: string[];
}

export interface StructuredParseResult {
  parserName: string;
  parserVersion: string;
  sheets: NormalizedSheet[];
  totalSheetCount: number;
  totalRowCount: number;
  totalColumnCount: number;
  contentChecksum: string;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface StructuredParser {
  name: string;
  version: string;
  supportedMimeTypes: string[];
  parse(content: string, options?: StructuredParseOptions): StructuredParseResult;
}

export interface StructuredParseOptions {
  sheetName?: string;
  hasHeader?: boolean;
  delimiter?: string;
  maxRows?: number;
}

// ─── Checksum helper ────────────────────────────────────────────────────────

export function computeStructuredContentChecksum(result: StructuredParseResult): string {
  const canonical = JSON.stringify({
    sheets: result.sheets.map((s) => ({
      name: s.sheetName,
      rows: s.rows,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── CSV Parser ─────────────────────────────────────────────────────────────

class CsvParser implements StructuredParser {
  readonly name = "csv_parser";
  readonly version = "1.0";
  readonly supportedMimeTypes = ["text/csv", "application/csv", "text/comma-separated-values"];

  parse(content: string, options: StructuredParseOptions = {}): StructuredParseResult {
    const delimiter = options.delimiter ?? ",";
    const hasHeader = options.hasHeader !== false;
    const maxRows = options.maxRows ?? 50_000;
    const sheetName = options.sheetName ?? "Sheet1";

    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-SP11",
        "CSV content is empty — cannot parse",
      );
    }

    const rawRows = this.parseDelimited(content, delimiter);

    if (rawRows.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-SP11",
        "CSV parsed 0 rows — content appears empty or malformed",
      );
    }

    const warnings: string[] = [];

    let headers: string[] = [];
    let dataRows: string[][];

    if (hasHeader && rawRows.length > 0) {
      headers = rawRows[0].map((h) => h.trim());
      dataRows = rawRows.slice(1);
    } else {
      headers = rawRows[0].map((_, i) => `column_${i + 1}`);
      dataRows = rawRows;
    }

    if (dataRows.length > maxRows) {
      warnings.push(`Row limit reached: truncated at ${maxRows} of ${dataRows.length} data rows`);
      dataRows = dataRows.slice(0, maxRows);
    }

    const columnCount = Math.max(headers.length, ...dataRows.map((r) => r.length));

    const normalizedRows = dataRows.map((row) => {
      const padded = [...row];
      while (padded.length < columnCount) padded.push("");
      return padded.map((cell) => cell.trim());
    });

    const sheet: NormalizedSheet = {
      sheetName,
      rowCount: normalizedRows.length,
      columnCount,
      headers,
      rows: normalizedRows,
      warnings,
    };

    const result: StructuredParseResult = {
      parserName: this.name,
      parserVersion: this.version,
      sheets: [sheet],
      totalSheetCount: 1,
      totalRowCount: normalizedRows.length,
      totalColumnCount: columnCount,
      contentChecksum: "",
      warnings,
      metadata: { delimiter, hasHeader, sheetName },
    };

    result.contentChecksum = computeStructuredContentChecksum(result);
    return result;
  }

  private parseDelimited(content: string, delimiter: string): string[][] {
    const lines = content.split(/\r?\n/);
    const rows: string[][] = [];

    for (const line of lines) {
      if (line.trim() === "") continue;
      const row = this.parseLine(line, delimiter);
      rows.push(row);
    }

    return rows;
  }

  private parseLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i++;
        continue;
      }

      if (ch === delimiter && !inQuotes) {
        cells.push(current);
        current = "";
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    cells.push(current);
    return cells;
  }
}

// ─── TSV Parser ─────────────────────────────────────────────────────────────

class TsvParser implements StructuredParser {
  readonly name = "tsv_parser";
  readonly version = "1.0";
  readonly supportedMimeTypes = ["text/tab-separated-values", "text/tsv"];

  private csvParser = new CsvParser();

  parse(content: string, options: StructuredParseOptions = {}): StructuredParseResult {
    const tsvOptions: StructuredParseOptions = {
      ...options,
      delimiter: "\t",
      sheetName: options.sheetName ?? "Sheet1",
    };
    const result = this.csvParser.parse(content, tsvOptions);
    return {
      ...result,
      parserName: this.name,
      parserVersion: this.version,
      metadata: { ...result.metadata, format: "tsv" },
    };
  }
}

// ─── XLSX Explicit Fail ──────────────────────────────────────────────────────

class XlsxParser implements StructuredParser {
  readonly name = "xlsx_parser";
  readonly version = "1.0";
  readonly supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/excel",
    "application/x-excel",
  ];

  parse(_content: string, _options?: StructuredParseOptions): StructuredParseResult {
    throw new KnowledgeInvariantError(
      "INV-SP11",
      "XLSX parsing is not supported in this environment. " +
        "The 'xlsx' package is not installed. " +
        "Fail explicitly rather than faking completion. " +
        "Convert to CSV/TSV before ingesting XLSX files.",
    );
  }
}

// ─── Parser registry ────────────────────────────────────────────────────────

const STRUCTURED_PARSERS: StructuredParser[] = [
  new CsvParser(),
  new TsvParser(),
  new XlsxParser(),
];

export function selectStructuredDocumentParser(mimeType: string): StructuredParser {
  const normalized = (mimeType || "").toLowerCase().trim();
  const parser = STRUCTURED_PARSERS.find((p) =>
    p.supportedMimeTypes.some((m) => m === normalized),
  );
  if (!parser) {
    throw new KnowledgeInvariantError(
      "INV-SP11",
      `Structured parser not available for mime type '${mimeType}'. ` +
        `Supported types: CSV (text/csv), TSV (text/tab-separated-values). ` +
        `XLSX is not supported.`,
    );
  }
  return parser;
}

// ─── Main entry points ──────────────────────────────────────────────────────

export function parseStructuredDocumentVersion(
  content: string,
  mimeType: string,
  options?: StructuredParseOptions,
): StructuredParseResult {
  const parser = selectStructuredDocumentParser(mimeType);
  return parser.parse(content, options);
}

export function normalizeStructuredDocument(
  result: StructuredParseResult,
): StructuredParseResult {
  const normalized: StructuredParseResult = {
    ...result,
    sheets: result.sheets.map((sheet) => ({
      ...sheet,
      sheetName: sheet.sheetName.trim(),
      headers: sheet.headers.map((h) => h.trim()),
      rows: sheet.rows.map((row) => row.map((cell) => cell.trim())),
    })),
  };
  normalized.contentChecksum = computeStructuredContentChecksum(normalized);
  return normalized;
}

export function summarizeStructuredParseResult(result: StructuredParseResult): string {
  return [
    `parser=${result.parserName}@${result.parserVersion}`,
    `sheets=${result.totalSheetCount}`,
    `rows=${result.totalRowCount}`,
    `columns=${result.totalColumnCount}`,
    `checksum=${result.contentChecksum.slice(0, 12)}`,
    result.warnings.length > 0 ? `warnings=${result.warnings.length}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
