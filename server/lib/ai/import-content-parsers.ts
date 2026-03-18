/**
 * Phase 5B.4 — Email / HTML / Imported Content Parser Abstraction
 *
 * Supports:
 *   - text/html          → HTML section parser (heading-aware, semantic structure)
 *   - message/rfc822     → Email/thread parser (message ordering, subject/sender/timestamp)
 *   - text/plain         → Imported plain text (block-aware)
 *   - text/x-email       → Alias for email
 *
 * All parsers return deterministic normalized output.
 * Video/binary content fails explicitly (INV-IMP11).
 *
 * Server-only. Never import from client/.
 */

import { createHash } from "crypto";
import { KnowledgeInvariantError } from "./knowledge-bases";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImportContentType = "email" | "html" | "imported_text";

export interface ImportMessage {
  messageIndex: number;
  threadPosition: number;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  body: string;
  quotedContent?: string;
  quotedContentIncluded: boolean;
}

export interface ImportSection {
  sectionIndex: number;
  sectionLabel?: string;
  level?: number;
  text: string;
  sourceUrl?: string;
  linkCount: number;
}

export interface ImportParseResult {
  contentType: ImportContentType;
  parserName: string;
  parserVersion: string;
  messages: ImportMessage[];
  sections: ImportSection[];
  normalizedText: string;
  textChecksum: string;
  messageCount: number;
  sectionCount: number;
  linkCount: number;
  sourceLanguageCode: string;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface ImportParseOptions {
  parserHint?: string;
  maxContentBytes?: number;
  contentLabel?: string;
  languageHint?: string;
  includeQuotedContent?: boolean;
}

export interface ImportParser {
  name: string;
  version: string;
  supportedMimeTypes: string[];
  parse(content: string, mimeType: string, options?: ImportParseOptions): Promise<ImportParseResult>;
}

// ─── Supported/blocked mime types ─────────────────────────────────────────────

export const SUPPORTED_HTML_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
]);

export const SUPPORTED_EMAIL_MIME_TYPES = new Set([
  "message/rfc822",
  "text/x-email",
]);

export const SUPPORTED_TEXT_IMPORT_MIME_TYPES = new Set([
  "text/plain",
]);

export const SUPPORTED_IMPORT_MIME_TYPES = new Set([
  ...Array.from(SUPPORTED_HTML_MIME_TYPES),
  ...Array.from(SUPPORTED_EMAIL_MIME_TYPES),
  ...Array.from(SUPPORTED_TEXT_IMPORT_MIME_TYPES),
]);

const DEFAULT_MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// ─── Checksum ────────────────────────────────────────────────────────────────

export function computeImportTextChecksum(result: ImportParseResult): string {
  const canonical = [
    ...result.messages.map((m) => `MSG:${m.messageIndex}|${m.from ?? ""}|${m.subject ?? ""}|${m.body.trim()}`),
    ...result.sections.map((s) => `SEC:${s.sectionIndex}|${s.sectionLabel ?? ""}|${s.text.trim()}`),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 24);
}

// ─── Normalize document post-parse ───────────────────────────────────────────

export function normalizeImportedDocument(result: ImportParseResult): ImportParseResult {
  const normalized: ImportParseResult = {
    ...result,
    messages: [...result.messages].sort((a, b) => a.messageIndex - b.messageIndex),
    sections: [...result.sections].sort((a, b) => a.sectionIndex - b.sectionIndex),
  };
  normalized.textChecksum = computeImportTextChecksum(normalized);
  return normalized;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function summarizeImportParseResult(result: ImportParseResult): string {
  return `parser=${result.parserName}@${result.parserVersion} contentType=${result.contentType} messages=${result.messageCount} sections=${result.sectionCount} links=${result.linkCount} lang=${result.sourceLanguageCode} checksum=${result.textChecksum.slice(0, 12)}`;
}

// ─── HTML Parser ─────────────────────────────────────────────────────────────
/**
 * Deterministic HTML section extractor.
 * Parses headings (h1-h6) as section boundaries.
 * Strips tags, preserves semantic text order.
 * No external dependencies.
 */
export const htmlImportParser: ImportParser = {
  name: "html_import_parser",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_HTML_MIME_TYPES),

  async parse(content, mimeType, options = {}): Promise<ImportParseResult> {
    const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_IMPORT_BYTES;

    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "HTML import content is empty or zero-length. Explicit failure — html_import_parser.",
      );
    }
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        `HTML import content exceeds maximum size (${maxBytes} bytes). Explicit rejection.`,
      );
    }

    const warnings: string[] = [];

    // Strip HTML comments
    let stripped = content.replace(/<!--[\s\S]*?-->/g, " ");

    // Count links before stripping
    const linkMatches = Array.from(stripped.matchAll(/<a\s[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi));
    const linkCount = linkMatches.length;

    // Extract sections by heading tags
    const headingRegex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
    const sections: ImportSection[] = [];
    let sectionIndex = 0;
    let lastIndex = 0;
    let introText = "";

    const headings: Array<{ index: number; level: number; label: string; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = headingRegex.exec(stripped)) !== null) {
      headings.push({
        index: m.index,
        level: parseInt(m[1].slice(1), 10),
        label: stripTags(m[2]).trim(),
        end: m.index + m[0].length,
      });
    }

    if (headings.length === 0) {
      // No headings — treat entire document as one section
      const text = stripTags(stripped).replace(/\s{2,}/g, " ").trim();
      if (!text) {
        throw new KnowledgeInvariantError(
          "INV-IMP11",
          "HTML import content produced no extractable text. Explicit failure — html_import_parser.",
        );
      }
      sections.push({
        sectionIndex: 0,
        sectionLabel: undefined,
        level: undefined,
        text,
        sourceUrl: options.contentLabel,
        linkCount,
      });
    } else {
      // Intro text before first heading
      const beforeFirst = stripped.slice(0, headings[0].index);
      introText = stripTags(beforeFirst).replace(/\s{2,}/g, " ").trim();
      if (introText) {
        sections.push({
          sectionIndex: sectionIndex++,
          sectionLabel: "Introduction",
          level: 0,
          text: introText,
          sourceUrl: options.contentLabel,
          linkCount: 0,
        });
      }

      for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const nextStart = i + 1 < headings.length ? headings[i + 1].index : stripped.length;
        const bodyHtml = stripped.slice(h.end, nextStart);
        const bodyText = stripTags(bodyHtml).replace(/\s{2,}/g, " ").trim();

        const label = h.label || `Section ${sectionIndex + 1}`;
        const text = bodyText ? `${label}: ${bodyText}` : label;

        sections.push({
          sectionIndex: sectionIndex++,
          sectionLabel: label,
          level: h.level,
          text,
          sourceUrl: options.contentLabel,
          linkCount: 0,
        });
      }

      if (sections.length === 0) {
        throw new KnowledgeInvariantError(
          "INV-IMP11",
          "HTML import content produced zero parseable sections. Explicit failure.",
        );
      }
    }

    const normalizedText = sections.map((s) => s.text).join("\n\n");
    const checksum = createHash("sha256").update(normalizedText, "utf8").digest("hex").slice(0, 24);

    const result: ImportParseResult = {
      contentType: "html",
      parserName: "html_import_parser",
      parserVersion: "1.0",
      messages: [],
      sections,
      normalizedText,
      textChecksum: checksum,
      messageCount: 0,
      sectionCount: sections.length,
      linkCount,
      sourceLanguageCode: options.languageHint ?? "unknown",
      warnings,
      metadata: {
        parserLabel: "html_import_parser@1.0",
        mimeType,
        headingCount: headings.length,
        rawLength: content.length,
      },
    };
    return result;
  },
};

// ─── Email / RFC 822 Parser ───────────────────────────────────────────────────
/**
 * Deterministic email thread parser.
 * Supports:
 *   - Single RFC 822 formatted messages
 *   - Multi-message thread format (messages delimited by "From " lines or "---" separators)
 *   - Extracts Subject, From, To, Date headers when available
 *   - Optionally includes or excludes quoted reply content (lines starting with ">")
 *
 * Does NOT depend on any external email library — uses regex-based header extraction.
 */
export const emailImportParser: ImportParser = {
  name: "email_import_parser",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_EMAIL_MIME_TYPES),

  async parse(content, mimeType, options = {}): Promise<ImportParseResult> {
    const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_IMPORT_BYTES;
    const includeQuoted = options.includeQuotedContent ?? false;

    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "Email import content is empty or zero-length. Explicit failure — email_import_parser.",
      );
    }
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        `Email import content exceeds maximum size (${maxBytes} bytes). Explicit rejection.`,
      );
    }

    const warnings: string[] = [];

    // Split into individual messages by "From " delimiter or "---" separator
    const rawMessages = splitEmailThread(content);

    if (rawMessages.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "Email import content produced no parseable messages. Explicit failure — email_import_parser.",
      );
    }

    const messages: ImportMessage[] = [];
    let threadPosition = 0;

    for (const rawMsg of rawMessages) {
      const headers = extractEmailHeaders(rawMsg);
      const { bodyLines, quotedLines } = separateQuotedContent(rawMsg);

      const body = bodyLines.join("\n").trim();
      const quoted = quotedLines.join("\n").trim();

      if (!body && !quoted) {
        warnings.push(`Message ${threadPosition}: empty body, skipping`);
        continue;
      }

      const effectiveBody = includeQuoted
        ? (body + (quoted ? `\n\n[Quoted]\n${quoted}` : "")).trim()
        : body || `[No new content — quoted only]`;

      messages.push({
        messageIndex: messages.length,
        threadPosition: threadPosition++,
        subject: headers.subject,
        from: headers.from,
        to: headers.to,
        date: headers.date,
        body: effectiveBody,
        quotedContent: quoted || undefined,
        quotedContentIncluded: includeQuoted,
      });
    }

    if (messages.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "Email import produced no parseable messages with content. Explicit failure.",
      );
    }

    const normalizedText = messages
      .map((msg) => {
        const header = [
          msg.subject ? `Subject: ${msg.subject}` : null,
          msg.from ? `From: ${msg.from}` : null,
          msg.date ? `Date: ${msg.date}` : null,
        ].filter(Boolean).join(" | ");
        return header ? `${header}\n${msg.body}` : msg.body;
      })
      .join("\n\n---\n\n");

    const checksum = createHash("sha256").update(normalizedText, "utf8").digest("hex").slice(0, 24);

    return {
      contentType: "email",
      parserName: "email_import_parser",
      parserVersion: "1.0",
      messages,
      sections: [],
      normalizedText,
      textChecksum: checksum,
      messageCount: messages.length,
      sectionCount: 0,
      linkCount: 0,
      sourceLanguageCode: options.languageHint ?? "unknown",
      warnings,
      metadata: {
        parserLabel: "email_import_parser@1.0",
        mimeType,
        rawMessageCount: rawMessages.length,
        includeQuotedContent: includeQuoted,
        rawLength: content.length,
      },
    };
  },
};

// ─── Plain Text Import Parser ─────────────────────────────────────────────────

export const textImportParser: ImportParser = {
  name: "text_import_parser",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_TEXT_IMPORT_MIME_TYPES),

  async parse(content, mimeType, options = {}): Promise<ImportParseResult> {
    const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_IMPORT_BYTES;

    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "Imported text content is empty or zero-length. Explicit failure — text_import_parser.",
      );
    }
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        `Imported text content exceeds maximum size (${maxBytes} bytes). Explicit rejection.`,
      );
    }

    const paragraphs = content
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (paragraphs.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMP11",
        "Imported text content produced no parseable paragraphs. Explicit failure — text_import_parser.",
      );
    }

    const sections: ImportSection[] = paragraphs.map((text, idx) => ({
      sectionIndex: idx,
      sectionLabel: undefined,
      level: undefined,
      text,
      sourceUrl: options.contentLabel,
      linkCount: 0,
    }));

    const normalizedText = sections.map((s) => s.text).join("\n\n");
    const checksum = createHash("sha256").update(normalizedText, "utf8").digest("hex").slice(0, 24);

    return {
      contentType: "imported_text",
      parserName: "text_import_parser",
      parserVersion: "1.0",
      messages: [],
      sections,
      normalizedText,
      textChecksum: checksum,
      messageCount: 0,
      sectionCount: sections.length,
      linkCount: 0,
      sourceLanguageCode: options.languageHint ?? "unknown",
      warnings: [],
      metadata: {
        parserLabel: "text_import_parser@1.0",
        mimeType,
        paragraphCount: paragraphs.length,
        rawLength: content.length,
      },
    };
  },
};

// ─── Parser Selection ─────────────────────────────────────────────────────────

export function selectImportContentParser(mimeType: string, hint?: string): ImportParser {
  const normalizedMime = mimeType.toLowerCase().trim();

  if (!SUPPORTED_IMPORT_MIME_TYPES.has(normalizedMime)) {
    throw new KnowledgeInvariantError(
      "INV-IMP11",
      `Import content parser not available for mime type '${mimeType}'. Supported: ${Array.from(SUPPORTED_IMPORT_MIME_TYPES).join(", ")}. Explicit failure — no silent fallback.`,
    );
  }

  if (hint === "html_import_parser") return htmlImportParser;
  if (hint === "email_import_parser") return emailImportParser;
  if (hint === "text_import_parser") return textImportParser;

  if (SUPPORTED_HTML_MIME_TYPES.has(normalizedMime)) return htmlImportParser;
  if (SUPPORTED_EMAIL_MIME_TYPES.has(normalizedMime)) return emailImportParser;
  if (SUPPORTED_TEXT_IMPORT_MIME_TYPES.has(normalizedMime)) return textImportParser;

  throw new KnowledgeInvariantError(
    "INV-IMP11",
    `No import parser found for mime type '${mimeType}'. Explicit failure.`,
  );
}

// ─── Top-level parse function ─────────────────────────────────────────────────

export async function parseImportedDocumentVersion(
  content: string,
  mimeType: string,
  options?: ImportParseOptions,
): Promise<ImportParseResult> {
  const parser = selectImportContentParser(mimeType, options?.parserHint);
  const raw = await parser.parse(content, mimeType, options);
  return normalizeImportedDocument(raw);
}

// ─── Utility functions ────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function splitEmailThread(content: string): string[] {
  // Split on "From " mbox delimiter or "---" separator (3+ dashes on own line)
  const parts = content.split(/\n(?=From )|(?:\r?\n---+\r?\n)/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function extractEmailHeaders(text: string): { subject?: string; from?: string; to?: string; date?: string } {
  const headerEnd = text.search(/\n\n|\r\n\r\n/);
  const headerSection = headerEnd > -1 ? text.slice(0, headerEnd) : text.slice(0, 800);

  function extractHeader(name: string): string | undefined {
    const regex = new RegExp(`^${name}:\\s*(.+)`, "im");
    const m = headerSection.match(regex);
    return m ? m[1].trim() : undefined;
  }

  return {
    subject: extractHeader("Subject") ?? extractHeader("Re"),
    from: extractHeader("From"),
    to: extractHeader("To"),
    date: extractHeader("Date"),
  };
}

function separateQuotedContent(text: string): { bodyLines: string[]; quotedLines: string[] } {
  const lines = text.split(/\r?\n/);

  // Skip header block (up to first blank line)
  let i = 0;
  while (i < lines.length && lines[i].trim() !== "") i++;
  i++; // skip blank line

  const bodyLines: string[] = [];
  const quotedLines: string[] = [];

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(">") || line.startsWith("| ") || line.match(/^On .+ wrote:$/)) {
      quotedLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }

  return { bodyLines, quotedLines };
}
