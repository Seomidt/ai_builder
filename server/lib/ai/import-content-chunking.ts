/**
 * Phase 5B.4 — Email / HTML / Imported Content Chunking Foundation
 *
 * Strategies:
 *   - email_messages   → one chunk per email message (with subject/sender/date context)
 *   - html_sections    → one chunk per HTML section/heading block
 *   - import_text_blocks → bounded paragraph blocks for imported plain text
 *
 * Deterministic chunk keys and hashes (INV-IMP10).
 * Does NOT create embeddings or set index_state='indexed'.
 */

import { createHash } from "crypto";
import type { ImportParseResult, ImportContentType } from "./import-content-parsers";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ImportChunkingConfig {
  strategy?: string;
  version?: string;
  maxBlockSize?: number;
  includeHeaderContext?: boolean;
  includeSectionLabel?: boolean;
  groupBy?: "message" | "section" | "block";
}

export const DEFAULT_IMPORT_CHUNKING_CONFIG: ImportChunkingConfig = {
  strategy: "auto",
  version: "1.0",
  maxBlockSize: 1500,
  includeHeaderContext: true,
  includeSectionLabel: true,
};

// ─── Candidate type ───────────────────────────────────────────────────────────

export interface ImportChunkCandidate {
  chunkIndex: number;
  chunkKey: string;
  chunkHash: string;
  chunkText: string;
  importChunkStrategy: string;
  importChunkVersion: string;
  emailChunk: boolean;
  htmlChunk: boolean;
  messageIndex?: number;
  threadPosition?: number;
  sectionLabel?: string;
  sourceUrl?: string;
  senderLabel?: string;
  sentAt?: string;
  quotedContentIncluded?: boolean;
  tokenEstimate: number;
}

// ─── Deterministic key + hash ─────────────────────────────────────────────────

export function buildImportChunkKey(
  documentId: string,
  versionId: string,
  chunkIndex: number,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${documentId}::${versionId}::chunk${chunkIndex}::${strategy}@${strategyVersion}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

export function buildImportChunkHash(
  normalizedText: string,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${strategy}@${strategyVersion}::${normalizedText}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

// ─── Text normalization ───────────────────────────────────────────────────────

export function normalizeImportChunkText(text: string): string {
  return text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Strategy resolution ──────────────────────────────────────────────────────

function resolveStrategy(contentType: ImportContentType, config: ImportChunkingConfig): string {
  if (config.strategy && config.strategy !== "auto") return config.strategy;
  switch (contentType) {
    case "email": return "email_messages";
    case "html": return "html_sections";
    case "imported_text": return "import_text_blocks";
    default: return "import_text_blocks";
  }
}

// ─── email_messages strategy ──────────────────────────────────────────────────

function chunkEmailMessages(
  parseResult: ImportParseResult,
  documentId: string,
  versionId: string,
  strategy: string,
  stratVersion: string,
  config: ImportChunkingConfig,
): ImportChunkCandidate[] {
  const includeHeader = config.includeHeaderContext ?? true;
  const candidates: ImportChunkCandidate[] = [];

  for (const msg of parseResult.messages) {
    const headerParts: string[] = [];
    if (includeHeader) {
      if (msg.subject) headerParts.push(`Subject: ${msg.subject}`);
      if (msg.from) headerParts.push(`From: ${msg.from}`);
      if (msg.date) headerParts.push(`Date: ${msg.date}`);
    }

    const rawText = headerParts.length > 0
      ? `${headerParts.join(" | ")}\n${msg.body}`
      : msg.body;

    const normalizedText = normalizeImportChunkText(rawText);
    if (!normalizedText) continue;

    const chunkIndex = candidates.length;
    const chunkKey = buildImportChunkKey(documentId, versionId, chunkIndex, strategy, stratVersion);
    const chunkHash = buildImportChunkHash(normalizedText, strategy, stratVersion);

    candidates.push({
      chunkIndex,
      chunkKey,
      chunkHash,
      chunkText: normalizedText,
      importChunkStrategy: strategy,
      importChunkVersion: stratVersion,
      emailChunk: true,
      htmlChunk: false,
      messageIndex: msg.messageIndex,
      threadPosition: msg.threadPosition,
      sectionLabel: msg.subject,
      senderLabel: msg.from,
      sentAt: msg.date,
      quotedContentIncluded: msg.quotedContentIncluded,
      tokenEstimate: Math.ceil(normalizedText.length / 4),
    });
  }

  return candidates;
}

// ─── html_sections strategy ───────────────────────────────────────────────────

function chunkHtmlSections(
  parseResult: ImportParseResult,
  documentId: string,
  versionId: string,
  strategy: string,
  stratVersion: string,
  config: ImportChunkingConfig,
): ImportChunkCandidate[] {
  const includeLabel = config.includeSectionLabel ?? true;
  const candidates: ImportChunkCandidate[] = [];

  for (const sec of parseResult.sections) {
    const rawText = includeLabel && sec.sectionLabel
      ? `[${sec.sectionLabel}] ${sec.text}`
      : sec.text;

    const normalizedText = normalizeImportChunkText(rawText);
    if (!normalizedText) continue;

    const chunkIndex = candidates.length;
    const chunkKey = buildImportChunkKey(documentId, versionId, chunkIndex, strategy, stratVersion);
    const chunkHash = buildImportChunkHash(normalizedText, strategy, stratVersion);

    candidates.push({
      chunkIndex,
      chunkKey,
      chunkHash,
      chunkText: normalizedText,
      importChunkStrategy: strategy,
      importChunkVersion: stratVersion,
      emailChunk: false,
      htmlChunk: true,
      sectionLabel: sec.sectionLabel,
      sourceUrl: sec.sourceUrl,
      tokenEstimate: Math.ceil(normalizedText.length / 4),
    });
  }

  return candidates;
}

// ─── import_text_blocks strategy ─────────────────────────────────────────────

function chunkImportTextBlocks(
  parseResult: ImportParseResult,
  documentId: string,
  versionId: string,
  strategy: string,
  stratVersion: string,
  config: ImportChunkingConfig,
): ImportChunkCandidate[] {
  const maxBlockSize = config.maxBlockSize ?? 1500;
  const candidates: ImportChunkCandidate[] = [];

  let buffer = "";
  let chunkIndex = 0;

  const flush = () => {
    const normalizedText = normalizeImportChunkText(buffer);
    if (!normalizedText) return;
    const chunkKey = buildImportChunkKey(documentId, versionId, chunkIndex, strategy, stratVersion);
    const chunkHash = buildImportChunkHash(normalizedText, strategy, stratVersion);
    candidates.push({
      chunkIndex: chunkIndex++,
      chunkKey,
      chunkHash,
      chunkText: normalizedText,
      importChunkStrategy: strategy,
      importChunkVersion: stratVersion,
      emailChunk: false,
      htmlChunk: false,
      tokenEstimate: Math.ceil(normalizedText.length / 4),
    });
    buffer = "";
  };

  const allText = parseResult.sections.length > 0
    ? parseResult.sections.map((s) => s.text).join("\n\n")
    : parseResult.normalizedText;

  // Split into paragraphs, then group into blocks
  const paragraphs = allText.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);

  for (const para of paragraphs) {
    if (buffer.length + para.length > maxBlockSize && buffer.length > 0) {
      flush();
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }
  if (buffer) flush();

  return candidates;
}

// ─── Main chunking function ───────────────────────────────────────────────────

export function chunkImportedContent(
  parseResult: ImportParseResult,
  documentId: string,
  versionId: string,
  config: ImportChunkingConfig = {},
): ImportChunkCandidate[] {
  const stratVersion = config.version ?? DEFAULT_IMPORT_CHUNKING_CONFIG.version!;
  const strategy = resolveStrategy(parseResult.contentType, config);

  switch (strategy) {
    case "email_messages":
      return chunkEmailMessages(parseResult, documentId, versionId, strategy, stratVersion, config);
    case "html_sections":
      return chunkHtmlSections(parseResult, documentId, versionId, strategy, stratVersion, config);
    case "import_text_blocks":
    default:
      return chunkImportTextBlocks(parseResult, documentId, versionId, strategy, stratVersion, config);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function summarizeImportChunks(candidates: ImportChunkCandidate[]): string {
  if (candidates.length === 0) return "chunks=0";
  const emailChunks = candidates.filter((c) => c.emailChunk).length;
  const htmlChunks = candidates.filter((c) => c.htmlChunk).length;
  const strategy = candidates[0].importChunkStrategy;
  return `chunks=${candidates.length} strategy=${strategy} emailChunks=${emailChunks} htmlChunks=${htmlChunks}`;
}
