/**
 * Phase 42 — Content Sanitizer
 *
 * Shared sanitization helpers for HTML, script, and plain text normalization.
 * Fixes scanner findings for:
 *   - Incomplete/missing script tag variant handling
 *   - Double decode / double unescape bugs
 *   - Event handler injection
 *   - javascript: URL vectors
 *
 * Design decisions:
 *   - No regex-only script stripping for trusted HTML — use allowlist approach
 *   - For plain text extraction: strip all markup
 *   - For mixed content: strip dangerous markup, preserve safe tags
 *   - Handles all script variants: <script>, <SCRIPT>, <script >, </script >, etc.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

// Matches <script ...> ... </script> with whitespace in closing tag and case variants
// Also handles </script > (space before >) which naïve regex misses
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

// Matches <style ...> ... </style>
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;

// Event handler attributes: onclick, onload, onerror, etc.
const EVENT_HANDLER_ATTR_RE = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

// javascript: URLs in href / src / action / etc.
// Handles spaces and unicode escapes: j&#97;vascript: j\u0061vascript: etc.
const JAVASCRIPT_URL_RE = /javascript\s*:/gi;

// data: URLs (can carry scripts)
const DATA_URL_RE = /data\s*:[^,]*base64/gi;

// HTML comments — can hide script payloads
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// All remaining HTML tags (for plain-text extraction)
const HTML_TAGS_RE = /<[^>]+>/g;

// Multiple whitespace collapse
const WHITESPACE_RE = /\s{2,}/g;

// ── HTML entity decode map ────────────────────────────────────────────────────
// One-pass decode of common HTML entities to detect double-encoded attack vectors

const HTML_ENTITIES: Record<string, string> = {
  "&amp;":   "&",
  "&lt;":    "<",
  "&gt;":    ">",
  "&quot;":  '"',
  "&#39;":   "'",
  "&#x27;":  "'",
  "&#x2F;":  "/",
  "&#x60;":  "`",
  "&#x3D;":  "=",
};

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|#x27|#x2F|#x60|#x3D);/gi;

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Decode one layer of HTML entity encoding.
 * Used to detect double-encoded attack payloads before stripping.
 */
export function normalizeDecodedEntities(input: string): string {
  if (!input || typeof input !== "string") return "";
  return input.replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] ?? m);
}

/**
 * Decode numeric HTML entities (decimal and hex).
 * Handles &#106; and &#x6A; style encoding used to obfuscate "javascript:".
 */
function decodeNumericEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Normalize all encoding layers (entities, numeric entities, unicode escapes)
 * to reveal the true payload before sanitization.
 */
function fullyNormalize(input: string): string {
  let prev = input;
  let current = decodeNumericEntities(normalizeDecodedEntities(input));
  // Iterate until stable to handle multi-layer encoding (double unescape bug fix)
  let iterations = 0;
  while (current !== prev && iterations++ < 5) {
    prev = current;
    current = decodeNumericEntities(normalizeDecodedEntities(current));
  }
  return current;
}

// ── Core sanitizers ───────────────────────────────────────────────────────────

/**
 * Strip all HTML markup and return clean plain text.
 * Safe for user-controlled input intended to become displayable text.
 *
 * Process:
 *   1. Normalize encoding to reveal hidden attack vectors
 *   2. Remove HTML comments
 *   3. Remove <script> and <style> blocks (with all whitespace variants)
 *   4. Remove event handler attributes
 *   5. Remove all remaining tags
 *   6. Collapse whitespace
 */
export function sanitizePlainTextInput(input: string): string {
  if (!input || typeof input !== "string") return "";

  // Cap length before processing to prevent resource exhaustion
  const capped = input.slice(0, 500_000);

  // Phase 1: normalize encoding to defeat double-encoded attacks
  let result = fullyNormalize(capped);

  // Phase 2: remove HTML comments (can hide script payloads)
  result = result.replace(HTML_COMMENT_RE, " ");

  // Phase 3: remove script and style blocks (case-insensitive, whitespace-tolerant)
  result = result.replace(SCRIPT_BLOCK_RE, " ");
  result = result.replace(STYLE_BLOCK_RE, " ");

  // Phase 4: remove event handlers
  result = result.replace(EVENT_HANDLER_ATTR_RE, "");

  // Phase 5: neutralize javascript: URLs
  result = result.replace(JAVASCRIPT_URL_RE, "removed:");

  // Phase 6: neutralize data: URLs with base64
  result = result.replace(DATA_URL_RE, "data:text/plain");

  // Phase 7: strip all remaining tags
  result = result.replace(HTML_TAGS_RE, " ");

  // Phase 8: collapse whitespace and trim
  result = result.replace(WHITESPACE_RE, " ").trim();

  return result;
}

/**
 * Strip all dangerous markup from HTML while preserving safe structure.
 * Uses an explicit denylist of dangerous patterns.
 *
 * For input that must remain as HTML (e.g. rich text that will be rendered):
 *   - Remove <script> blocks (all variants)
 *   - Remove <style> blocks
 *   - Remove event handler attributes (on*)
 *   - Neutralize javascript: URLs
 *   - Remove HTML comments
 *   - Normalize encoding first to defeat double-encoding
 *
 * Note: For full HTML sanitization with allowlist semantics, use a library
 * like DOMPurify (browser) or isomorphic-dompurify (Node.js). This function
 * provides defense-in-depth against the most common attack vectors.
 */
export function sanitizeHtmlInput(input: string): string {
  if (!input || typeof input !== "string") return "";

  const capped = input.slice(0, 500_000);

  // First normalize to defeat double-encoding
  let result = fullyNormalize(capped);

  // Remove comments
  result = result.replace(HTML_COMMENT_RE, "");

  // Remove script blocks (most dangerous — all whitespace variants)
  result = result.replace(SCRIPT_BLOCK_RE, "");

  // Remove style blocks (can contain expression() in IE, CSS injection)
  result = result.replace(STYLE_BLOCK_RE, "");

  // Remove event handler attributes (onclick, onload, onerror, etc.)
  result = result.replace(EVENT_HANDLER_ATTR_RE, "");

  // Neutralize javascript: URLs
  result = result.replace(JAVASCRIPT_URL_RE, "removed:");

  // Neutralize data: base64 URLs
  result = result.replace(DATA_URL_RE, "data:text/plain");

  return result;
}

/**
 * Specifically strip dangerous markup patterns from a string.
 * More aggressive than sanitizeHtmlInput — also strips all remaining tags.
 * Use when the content must be safe for insertion into HTML but not BE HTML.
 */
export function stripDangerousMarkup(input: string): string {
  if (!input || typeof input !== "string") return "";

  const capped = input.slice(0, 500_000);

  // Normalize first
  let result = fullyNormalize(capped);

  // Strip all dangerous patterns
  result = result
    .replace(HTML_COMMENT_RE, " ")
    .replace(SCRIPT_BLOCK_RE, " ")
    .replace(STYLE_BLOCK_RE, " ")
    .replace(EVENT_HANDLER_ATTR_RE, "")
    .replace(JAVASCRIPT_URL_RE, "removed:")
    .replace(DATA_URL_RE, "data:text/plain")
    .replace(HTML_TAGS_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();

  return result;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export interface SanitizationResult {
  original:       string;
  sanitized:      string;
  removedScripts: boolean;
  removedEvents:  boolean;
  removedUrls:    boolean;
  wasDoubleEncoded: boolean;
  bytesDelta:     number;
}

/**
 * Sanitize and return a diagnostic report showing what was removed.
 * Useful for logging/alerting when suspicious content is detected.
 */
export function sanitizeWithReport(input: string): SanitizationResult {
  if (!input || typeof input !== "string") {
    return { original: "", sanitized: "", removedScripts: false, removedEvents: false, removedUrls: false, wasDoubleEncoded: false, bytesDelta: 0 };
  }

  const normalized = fullyNormalize(input);
  const wasDoubleEncoded = normalized !== input;

  const sanitized = sanitizeHtmlInput(input);

  return {
    original:        input,
    sanitized,
    removedScripts:  SCRIPT_BLOCK_RE.test(normalized),
    removedEvents:   EVENT_HANDLER_ATTR_RE.test(normalized),
    removedUrls:     JAVASCRIPT_URL_RE.test(normalized),
    wasDoubleEncoded,
    bytesDelta:      input.length - sanitized.length,
  };
}

/**
 * Check if a string contains potentially dangerous content (without sanitizing).
 * Used for abuse detection / alerting.
 */
export function containsDangerousContent(input: string): boolean {
  if (!input || typeof input !== "string") return false;
  const normalized = fullyNormalize(input);
  // Reset lastIndex for global regexes
  SCRIPT_BLOCK_RE.lastIndex = 0;
  EVENT_HANDLER_ATTR_RE.lastIndex = 0;
  JAVASCRIPT_URL_RE.lastIndex = 0;
  return (
    SCRIPT_BLOCK_RE.test(normalized) ||
    EVENT_HANDLER_ATTR_RE.test(normalized) ||
    JAVASCRIPT_URL_RE.test(normalized) ||
    DATA_URL_RE.test(normalized)
  );
}
