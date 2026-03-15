import { createHash } from "crypto";
import sanitizeHtml from "sanitize-html";

// ─── Security constants ───────────────────────────────────────────────────────
export const MAX_HTML_OUTPUT_CHARS = 50_000;
export const MAX_RAW_INPUT_BYTES = 1_048_576; // 1 MB

// ─── applyUnicodeNormalization ────────────────────────────────────────────────
// Apply NFKC before embedding or chunking. Fixes lookalike attacks.
export function applyUnicodeNormalization(text: string): string {
  return text.normalize("NFKC");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedSection {
  heading?: string;
  headingPath?: string;
  content: string;
  level?: number;
  position: number;
}

export interface ParsedDocument {
  plainText: string;
  detectedTitle?: string;
  languageCode?: string;
  sections: ParsedSection[];
  parserName: string;
  parserVersion: string;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export type DocumentParserResult =
  | { success: true; data: ParsedDocument }
  | { success: false; error: string; parserName: string; parserVersion: string };

export interface ParserDescriptor {
  parserName: string;
  parserVersion: string;
  supported: boolean;
  reason?: string;
}

// ─── Parser Registry ─────────────────────────────────────────────────────────

const PARSER_VERSION = "1.0";

const SUPPORTED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "application/json",
  "text/csv",
  "application/csv",
  "text/x-csv",
]);

const UNSUPPORTED_MIME_TYPES = new Map<string, string>([
  ["application/pdf", "PDF parsing is not supported in this environment. Fail explicitly rather than fabricating output."],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOCX parsing is not supported in this environment. Fail explicitly rather than fabricating output."],
  ["application/msword", "DOC parsing is not supported in this environment."],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX parsing is not supported in this environment."],
]);

function resolveParserName(mimeType: string, documentType?: string): string {
  const mt = (mimeType ?? "").toLowerCase().trim();
  if (mt === "text/plain") return "plain_text_parser";
  if (mt === "text/markdown" || mt === "text/x-markdown") return "markdown_parser";
  if (mt === "text/html") return "html_parser";
  if (mt === "application/json") return "json_parser";
  if (mt === "text/csv" || mt === "application/csv" || mt === "text/x-csv") return "csv_parser";
  if (documentType === "markdown") return "markdown_parser";
  if (documentType === "html") return "html_parser";
  if (documentType === "json") return "json_parser";
  if (documentType === "csv") return "csv_parser";
  return "plain_text_parser";
}

// ─── selectDocumentParser ─────────────────────────────────────────────────────

export function selectDocumentParser(mimeType: string, documentType?: string): ParserDescriptor {
  const mt = (mimeType ?? "").toLowerCase().trim();

  if (UNSUPPORTED_MIME_TYPES.has(mt)) {
    return {
      parserName: "unsupported",
      parserVersion: PARSER_VERSION,
      supported: false,
      reason: UNSUPPORTED_MIME_TYPES.get(mt),
    };
  }

  if (!SUPPORTED_MIME_TYPES.has(mt) && !documentType) {
    return {
      parserName: "plain_text_parser",
      parserVersion: PARSER_VERSION,
      supported: true,
      reason: `Unknown mime type '${mt}', falling back to plain text parser`,
    };
  }

  const parserName = resolveParserName(mt, documentType);
  return {
    parserName,
    parserVersion: PARSER_VERSION,
    supported: true,
  };
}

// ─── normalizeParsedDocument ──────────────────────────────────────────────────

export function normalizeParsedDocument(
  rawText: string,
  parserName: string,
  parserVersion: string,
): { plainText: string; sections: ParsedSection[]; warnings: string[] } {
  const warnings: string[] = [];

  // NFKC normalization before any further processing
  let normalized = applyUnicodeNormalization(rawText)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[ ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length === 0) {
    warnings.push("Normalized text is empty after normalization.");
  }

  if (normalized.length > 10_000_000) {
    warnings.push("Document exceeds 10M characters after normalization — indexing may be slow.");
  }

  const paragraphs = normalized.split(/\n\n+/);
  const sections: ParsedSection[] = paragraphs
    .map((content, idx) => ({ content: content.trim(), position: idx }))
    .filter((s) => s.content.length > 0);

  return { plainText: normalized, sections, warnings };
}

// ─── Plain Text Parser ────────────────────────────────────────────────────────

function parsePlainText(content: string): DocumentParserResult {
  const parserName = "plain_text_parser";
  const parserVersion = PARSER_VERSION;
  const { plainText, sections, warnings } = normalizeParsedDocument(content, parserName, parserVersion);

  const lines = plainText.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  const detectedTitle = firstNonEmpty ? firstNonEmpty.trim().slice(0, 200) : undefined;

  return {
    success: true,
    data: {
      plainText,
      detectedTitle,
      sections,
      parserName,
      parserVersion,
      warnings,
      metadata: { lineCount: lines.length, sectionCount: sections.length },
    },
  };
}

// ─── Markdown Parser ──────────────────────────────────────────────────────────

function parseMarkdown(content: string): DocumentParserResult {
  const parserName = "markdown_parser";
  const parserVersion = PARSER_VERSION;
  const warnings: string[] = [];

  let stripped = content
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/\n```/g, ""))
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*>\s*/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "");

  const { plainText, sections } = normalizeParsedDocument(stripped, parserName, parserVersion);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const detectedTitle = titleMatch ? titleMatch[1].trim() : undefined;

  const mdSections: ParsedSection[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  let lastPos = 0;
  let sectionIdx = 0;
  const headingPositions: Array<{ level: number; heading: string; offset: number }> = [];
  while ((match = headingRegex.exec(content)) !== null) {
    headingPositions.push({ level: match[1].length, heading: match[2].trim(), offset: match.index });
  }

  if (headingPositions.length > 0) {
    headingPositions.forEach((hp, i) => {
      const end = i + 1 < headingPositions.length ? headingPositions[i + 1].offset : content.length;
      const rawSectionContent = content.slice(hp.offset, end).replace(/^#{1,6}\s+.+\n?/, "").trim();
      const sectionText = rawSectionContent
        .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/\n```/g, ""))
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
        .trim();
      if (sectionText.length > 0) {
        mdSections.push({
          heading: hp.heading,
          headingPath: hp.heading,
          content: sectionText,
          level: hp.level,
          position: sectionIdx++,
        });
      }
    });
  }

  const finalSections = mdSections.length > 0 ? mdSections : sections;

  return {
    success: true,
    data: {
      plainText,
      detectedTitle,
      sections: finalSections,
      parserName,
      parserVersion,
      warnings,
      metadata: {
        headingCount: headingPositions.length,
        sectionCount: finalSections.length,
        hasCodeBlocks: content.includes("```"),
      },
    },
  };
}

// ─── HTML Parser (hardened — CodeQL remediation) ──────────────────────────────
// Pipeline: input → size-check → sanitize-html → plain text → NFKC → normalize
// No regex-based HTML sanitization. No double-escaping. Stored as plain text only.

function parseHtml(content: string): DocumentParserResult {
  const parserName = "html_parser";
  const parserVersion = PARSER_VERSION;
  const warnings: string[] = [];

  // Step 1: Reject documents > 1 MB raw input (resource exhaustion protection)
  const rawBytes = Buffer.byteLength(content, "utf8");
  if (rawBytes > MAX_RAW_INPUT_BYTES) {
    return {
      success: false,
      error: `HTML document exceeds 1 MB raw input limit (${rawBytes} bytes). Rejected to prevent resource exhaustion.`,
      parserName,
      parserVersion,
    };
  }

  // Step 2: Use sanitize-html to remove scripts, styles, and all attributes.
  // Produces clean HTML with only structural tags, then extract visible text.
  const cleanHtml = sanitizeHtml(content, {
    allowedTags: ["p", "div", "span", "br", "h1", "h2", "h3", "h4", "h5", "h6",
                  "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong",
                  "table", "thead", "tbody", "tr", "th", "td", "article", "section",
                  "header", "footer", "main", "aside", "nav"],
    allowedAttributes: {},          // strip ALL attributes (no href, no src, no onerror)
    disallowedTagsMode: "discard",  // silently remove anything not in allowedTags
    allowedSchemes: [],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
  });

  // Step 3: Extract visible text from clean HTML — insert newline for block elements
  // Then decode HTML entities ONCE to produce plain text (no double-escaping).
  const rawVisible = cleanHtml
    .replace(/<\/?(h[1-6]|p|div|br|li|tr|blockquote|pre|article|section|header|footer|main|aside|nav)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")   // remove any remaining tags (inline elements)
    .replace(/\n[ \t]+/g, "\n") // trim horizontal whitespace after newlines
    .trim();

  // Decode HTML entities once — store as plain text only. Never re-encode.
  const visibleText = rawVisible
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  // Step 4: Clamp output to MAX_HTML_OUTPUT_CHARS (plain text, store only once)
  let plainOutput = visibleText;
  if (plainOutput.length > MAX_HTML_OUTPUT_CHARS) {
    warnings.push(`HTML output clamped from ${plainOutput.length} to ${MAX_HTML_OUTPUT_CHARS} characters.`);
    plainOutput = plainOutput.slice(0, MAX_HTML_OUTPUT_CHARS);
  }

  // Step 5: Normalize (NFKC applied inside normalizeParsedDocument)
  const { plainText, sections } = normalizeParsedDocument(plainOutput, parserName, parserVersion);

  // Step 6: Extract title from clean sanitized HTML (plain-text title extraction only)
  const titleMatch = cleanHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const detectedTitle = titleMatch ? titleMatch[1].trim().slice(0, 200) : undefined;

  return {
    success: true,
    data: {
      plainText,
      detectedTitle,
      sections,
      parserName,
      parserVersion,
      warnings,
      metadata: {
        sectionCount: sections.length,
        rawBytes,
        outputChars: plainText.length,
        clamped: visibleText.length > MAX_HTML_OUTPUT_CHARS,
      },
    },
  };
}

// ─── JSON Parser ──────────────────────────────────────────────────────────────

function parseJson(content: string): DocumentParserResult {
  const parserName = "json_parser";
  const parserVersion = PARSER_VERSION;
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      success: false,
      error: `Invalid JSON: ${(e as Error).message}`,
      parserName,
      parserVersion,
    };
  }

  function extractText(obj: unknown, depth = 0): string {
    if (depth > 10) return "";
    if (typeof obj === "string") return obj;
    if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
    if (Array.isArray(obj)) return obj.map((v) => extractText(v, depth + 1)).filter(Boolean).join("\n");
    if (obj !== null && typeof obj === "object") {
      return Object.entries(obj as Record<string, unknown>)
        .map(([k, v]) => {
          const val = extractText(v, depth + 1);
          return val ? `${k}: ${val}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  const rawText = extractText(parsed);
  const { plainText, sections } = normalizeParsedDocument(rawText, parserName, parserVersion);

  if (plainText.length === 0) {
    warnings.push("JSON document produced empty text after extraction.");
  }

  return {
    success: true,
    data: {
      plainText,
      sections,
      parserName,
      parserVersion,
      warnings,
      metadata: { topLevelKeys: Array.isArray(parsed) ? parsed.length : Object.keys(parsed as object).length },
    },
  };
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCsv(content: string): DocumentParserResult {
  const parserName = "csv_parser";
  const parserVersion = PARSER_VERSION;
  const warnings: string[] = [];

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      success: false,
      error: "CSV document is empty.",
      parserName,
      parserVersion,
    };
  }

  const headerLine = lines[0];
  const dataLines = lines.slice(1);

  if (dataLines.length > 50_000) {
    warnings.push(`CSV has ${dataLines.length} rows — large documents may be slow to chunk.`);
  }

  const plainText = lines.join("\n");
  const { sections } = normalizeParsedDocument(plainText, parserName, parserVersion);

  return {
    success: true,
    data: {
      plainText,
      sections,
      parserName,
      parserVersion,
      warnings,
      metadata: { rowCount: dataLines.length, headerLine },
    },
  };
}

// ─── parseDocumentVersion ─────────────────────────────────────────────────────

export function parseDocumentVersion(
  content: string,
  mimeType: string,
  documentType?: string,
): DocumentParserResult {
  const descriptor = selectDocumentParser(mimeType, documentType);

  if (!descriptor.supported) {
    return {
      success: false,
      error: descriptor.reason ?? `Unsupported format: ${mimeType}`,
      parserName: descriptor.parserName,
      parserVersion: descriptor.parserVersion,
    };
  }

  try {
    switch (descriptor.parserName) {
      case "markdown_parser":
        return parseMarkdown(content);
      case "html_parser":
        return parseHtml(content);
      case "json_parser":
        return parseJson(content);
      case "csv_parser":
        return parseCsv(content);
      case "plain_text_parser":
      default:
        return parsePlainText(content);
    }
  } catch (err) {
    return {
      success: false,
      error: `Parser '${descriptor.parserName}' threw an unexpected error: ${(err as Error).message}`,
      parserName: descriptor.parserName,
      parserVersion: descriptor.parserVersion,
    };
  }
}

// ─── Checksum Utility ─────────────────────────────────────────────────────────

export function computeTextChecksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
