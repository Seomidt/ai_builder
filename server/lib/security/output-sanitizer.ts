/**
 * Phase 43 — Enterprise Output Sanitizer (LAYER B)
 *
 * This is the BROWSER-BOUND / RENDER-BOUND sanitizer.
 * Use this for any content that will be:
 *   - rendered as HTML in the browser
 *   - stored as sanitized HTML for later display
 *   - output from AI that will be shown to users
 *   - content from documents shown in preview surfaces
 *
 * ARCHITECTURE:
 *   LAYER A — AI ingestion / text extraction
 *     → use normalizePlainTextForAiInput() from content-sanitizer.ts
 *     → regex-based, fast, never produces browser-safe HTML
 *
 *   LAYER B — Output / rendering / storage for display  ← THIS FILE
 *     → uses sanitize-html (parser-based, htmlparser2)
 *     → parser semantics, not regex
 *     → strict allowlist of safe tags and attributes
 *     → returns branded types to enforce boundary at call sites
 *
 * RULE: untrusted content MUST pass through this module before entering any render surface.
 *
 * INV-OUT-1: sanitizeHtmlForRender returns SanitizedHtml branded type only
 * INV-OUT-2: allowlist is minimal — deny-by-default
 * INV-OUT-3: no regex-only HTML cleaning in this layer
 * INV-OUT-4: javascript: URLs are never allowed
 * INV-OUT-5: event handlers are never allowed
 * INV-OUT-6: script, iframe, object, embed, form, svg, style are always forbidden
 */

import sanitizeHtml from "sanitize-html";

// ── Branded types — enforce trust boundary at compile time ──────────────────

/** Raw, untrusted user-supplied string — must never be rendered directly */
export type UnsafeUserContent = string & { __brand: "UnsafeUserContent" };

/** HTML string that has been processed by sanitizeHtmlForRender() — safe to render */
export type SanitizedHtml = string & { __brand: "SanitizedHtml" };

/** Plain text string that has been processed by sanitizePlainTextForRender() — safe to display */
export type SafeText = string & { __brand: "SafeText" };

/** Mark a raw string as unsafe (type-level only — no runtime transformation) */
export function markUnsafe(s: string): UnsafeUserContent {
  return s as UnsafeUserContent;
}

// ── HTML allowlist policy ────────────────────────────────────────────────────
//
// Task 3: minimal safe allowlist — deny by default.
// Forbidden always: script, iframe, object, embed, form, svg, style, link, meta
// INV-OUT-6: forbidden tags — hard-coded, not configurable at runtime

const ALLOWED_TAGS: string[] = [
  "b", "strong", "i", "em", "u", "s", "del", "ins",
  "p", "br", "hr",
  "ul", "ol", "li",
  "dl", "dt", "dd",
  "code", "pre", "kbd", "samp",
  "blockquote", "q", "cite",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "a",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "span",
  "abbr", "acronym", "address", "small", "sub", "sup",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "a": ["href", "title", "target", "rel"],
  "abbr": ["title"],
  "acronym": ["title"],
  "td": ["rowspan", "colspan"],
  "th": ["rowspan", "colspan", "scope"],
  "table": ["summary"],
  "blockquote": ["cite"],
  "q": ["cite"],
  // No class, style, id, data-*, on* — never allowed
};

/** Strict sanitize-html options for browser-rendered output */
const RENDER_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,

  // Strip all disallowed tags (not escape — strip entirely)
  disallowedTagsMode: "discard",

  // Enforce safe attributes
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: {
    "a": ["https", "http", "mailto"],  // no javascript:, no data:
  },

  // Force external links to be safe
  transformTags: {
    "a": (tagName, attribs) => {
      const href = attribs.href ?? "";
      // Strip javascript: and data: URLs from href
      if (/^\s*javascript\s*:/i.test(href) || /^\s*data\s*:/i.test(href)) {
        return { tagName: "span", attribs: {} };
      }
      return {
        tagName,
        attribs: {
          ...attribs,
          // Always add safe rel for external links
          rel: "noopener noreferrer",
          // Force target to _blank or remove it
          target: attribs.target === "_blank" ? "_blank" : undefined!,
        },
      };
    },
  },
};

/** Strict options for plain-text-only content (all tags stripped) */
const PLAIN_TEXT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

// ── Core sanitizers ───────────────────────────────────────────────────────────

/**
 * Sanitize untrusted HTML for browser rendering.
 *
 * Uses parser-based sanitization (sanitize-html / htmlparser2).
 * Returns a branded SanitizedHtml type — only this type is accepted
 * by rendering boundaries.
 *
 * INV-OUT-1: Returns SanitizedHtml — not a plain string.
 * INV-OUT-3: Parser-based, not regex.
 * INV-OUT-4: javascript: URLs removed.
 * INV-OUT-5: Event handlers removed.
 * INV-OUT-6: Forbidden tags (script, iframe, etc.) stripped.
 */
export function sanitizeHtmlForRender(input: string): SanitizedHtml {
  if (!input || typeof input !== "string") return "" as SanitizedHtml;
  const capped = input.slice(0, 1_000_000); // 1MB cap before parser
  const result = sanitizeHtml(capped, RENDER_SANITIZE_OPTIONS);
  return result as SanitizedHtml;
}

/**
 * Sanitize untrusted content for plain-text rendering.
 *
 * Strips ALL HTML tags (parser-based) and encodes remaining text for safe display.
 * Returns a branded SafeText type.
 *
 * Use this when the rendering surface expects plain text but content
 * may have arrived with HTML markup.
 */
export function sanitizePlainTextForRender(input: string): SafeText {
  if (!input || typeof input !== "string") return "" as SafeText;
  const capped = input.slice(0, 1_000_000);
  // Strip all tags via parser
  const stripped = sanitizeHtml(capped, PLAIN_TEXT_SANITIZE_OPTIONS);
  // Collapse whitespace
  const normalized = stripped.replace(/\s{2,}/g, " ").trim();
  return normalized as SafeText;
}

/**
 * Strip ALL HTML from input using parser-based cleaning.
 *
 * Returns plain string (not branded) — use when returning content for
 * further programmatic processing, not direct rendering.
 */
export function stripAllHtml(input: string): string {
  if (!input || typeof input !== "string") return "";
  return sanitizeHtml(input.slice(0, 1_000_000), PLAIN_TEXT_SANITIZE_OPTIONS)
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Normalize untrusted content for storage or comparison.
 *
 * - Strips all HTML (parser-based)
 * - Collapses whitespace
 * - Trims
 *
 * NOT for rendering — use sanitizeHtmlForRender or sanitizePlainTextForRender
 * for browser-visible output.
 */
export function normalizeUntrustedContent(input: string): string {
  if (!input || typeof input !== "string") return "";
  return stripAllHtml(input);
}

// ── Mode assertion helper ─────────────────────────────────────────────────────

/**
 * Assert that a rendering mode is known-safe.
 *
 * Call at render boundaries to make the content mode explicit and auditable.
 * Throws at runtime if an unknown mode is used — prevents silent misuse.
 *
 * Usage:
 *   assertSafeRenderMode('text');  // OK — plain text mode
 *   assertSafeRenderMode('html');  // OK — sanitized HTML mode
 *   assertSafeRenderMode('raw');   // throws — not a safe mode
 */
export function assertSafeRenderMode(mode: "text" | "html"): void {
  if (mode !== "text" && mode !== "html") {
    throw new Error(
      `[output-sanitizer] assertSafeRenderMode: '${mode}' is not a recognized safe render mode. ` +
      `Use 'text' (plain text) or 'html' (sanitized HTML via sanitizeHtmlForRender).`,
    );
  }
}

// ── Convenience: AI output sanitization ───────────────────────────────────────

/**
 * Sanitize AI-generated output before displaying to users.
 *
 * AI models can produce HTML or markdown that, when rendered, may execute
 * scripts or exfiltrate data. Always sanitize before display.
 *
 * Returns SanitizedHtml for rich display or SafeText for plain text mode.
 */
export function sanitizeAiOutputForDisplay(
  input: string,
  mode: "html" | "text" = "text",
): SanitizedHtml | SafeText {
  assertSafeRenderMode(mode);
  return mode === "html"
    ? sanitizeHtmlForRender(input)
    : sanitizePlainTextForRender(input);
}

// ── Introspection ─────────────────────────────────────────────────────────────

/**
 * Expose the configured allowlist for audit/testing.
 */
export function getAllowedTagsPolicy(): { allowedTags: string[]; allowedAttributes: Record<string, unknown> } {
  return {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES as Record<string, unknown>,
  };
}

/**
 * Check if a tag is in the allowlist.
 */
export function isTagAllowed(tag: string): boolean {
  return ALLOWED_TAGS.includes(tag.toLowerCase());
}

/**
 * Check if a tag is explicitly forbidden by invariant INV-OUT-6.
 */
export function isTagForbiddenByInvariant(tag: string): boolean {
  const FORBIDDEN_ALWAYS = new Set([
    "script", "iframe", "object", "embed", "form", "svg", "style",
    "link", "meta", "base", "applet", "noscript", "template", "slot",
    "canvas", "video", "audio", "source", "track",
  ]);
  return FORBIDDEN_ALWAYS.has(tag.toLowerCase());
}
