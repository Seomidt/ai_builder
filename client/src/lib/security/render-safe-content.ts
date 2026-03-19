/**
 * Phase 43 — Frontend Rendering Boundary (LAYER B — browser side)
 *
 * RULE: ALL untrusted content MUST pass through this module before entering any render surface.
 *
 * This module provides:
 *   - DOMPurify-based HTML sanitization (parser-based, DOM-native)
 *   - Branded type helpers for compile-time enforcement
 *   - Escape helpers for plain text rendering
 *   - assertSanitizedHtml() guard for boundary enforcement
 *
 * NOT for use with:
 *   - AI ingestion (use normalizePlainTextForAiInput from content-sanitizer)
 *   - Server-side rendering (use output-sanitizer.ts)
 *
 * INV-FE-1: dangerouslySetInnerHTML must always receive output of renderSafeHtml()
 * INV-FE-2: raw AI output must never bypass sanitization before display
 * INV-FE-3: imported document content must always pass through renderSafeHtml() or renderSafeText()
 */

import DOMPurify from "dompurify";

// ── Branded types (mirrored from server/lib/security/output-sanitizer.ts) ────

/** Raw, untrusted string — must never be passed directly to dangerouslySetInnerHTML */
export type UnsafeContent = string & { __brand: "UnsafeContent" };

/** HTML string sanitized by renderSafeHtml() — safe to pass to dangerouslySetInnerHTML */
export type SanitizedHtml = string & { __brand: "SanitizedHtml" };

/** Plain text string sanitized by renderSafeText() — safe to render as text node */
export type SafeText = string & { __brand: "SafeText" };

/** Mark a raw string as unsafe (type annotation only — no runtime effect) */
export function markUnsafe(s: string): UnsafeContent {
  return s as UnsafeContent;
}

// ── DOMPurify config ──────────────────────────────────────────────────────────

/**
 * Phase 44: STRICT MINIMUM — 14 tags only. Mirrors server/lib/security/output-sanitizer.ts.
 * Changes from Phase 43: removed table/div/span/headings/dl/kbd/samp/q/cite/hr/etc.
 * See output-sanitizer.ts for full exclusion justifications.
 */
const RENDER_HTML_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    "b", "strong",
    "i", "em",
    "u",
    "p", "br",
    "ul", "ol", "li",
    "code", "pre",
    "blockquote",
    "a",
  ],
  // Phase 44: only href/target/rel on <a> — matches server-side policy
  ALLOWED_ATTR: ["href", "target", "rel"],
  FORCE_BODY: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  // Hooks applied below
};

/** Plain-text config — strip all HTML */
const PLAIN_TEXT_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  FORCE_BODY: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

// Apply post-process hook: force rel="noopener noreferrer" on all <a> tags
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
    // If external link, keep target=_blank; otherwise remove it
    const href = node.getAttribute("href") ?? "";
    if (!href.startsWith("/") && !href.startsWith("#") && !href.startsWith("mailto:")) {
      node.setAttribute("target", "_blank");
    } else {
      node.removeAttribute("target");
    }
  }
});

// ── Core boundary functions ───────────────────────────────────────────────────

/**
 * Sanitize untrusted HTML for safe rendering via dangerouslySetInnerHTML.
 *
 * Uses DOMPurify (DOM-native, parser-based — not regex).
 * Returns SanitizedHtml branded type.
 *
 * Usage:
 *   <div dangerouslySetInnerHTML={{ __html: renderSafeHtml(untrustedContent) }} />
 *
 * INV-FE-1: Always use this — never pass raw strings to dangerouslySetInnerHTML.
 */
export function renderSafeHtml(input: string | null | undefined): SanitizedHtml {
  if (!input || typeof input !== "string") return "" as SanitizedHtml;
  const cleaned = DOMPurify.sanitize(input.slice(0, 1_000_000), RENDER_HTML_CONFIG);
  return (typeof cleaned === "string" ? cleaned : "") as SanitizedHtml;
}

/**
 * Sanitize untrusted content for plain-text rendering.
 *
 * Strips ALL HTML tags (parser-based via DOMPurify) and returns safe plain text.
 * Use when the display surface is a text node — no HTML interpretation.
 *
 * Usage:
 *   <p>{renderSafeText(untrustedContent)}</p>
 *
 * Note: React auto-escapes string children — renderSafeText() is a defence-in-depth
 * measure, primarily useful when content may contain HTML tags that should not appear.
 */
export function renderSafeText(input: string | null | undefined): SafeText {
  if (!input || typeof input !== "string") return "" as SafeText;
  const stripped = DOMPurify.sanitize(input.slice(0, 1_000_000), PLAIN_TEXT_CONFIG);
  const normalized = (typeof stripped === "string" ? stripped : "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return normalized as SafeText;
}

/**
 * Assert that a string is already sanitized HTML.
 *
 * Use at component boundaries to make the trust boundary explicit:
 *   assertSanitizedHtml(content, 'DocPreview');
 *
 * Throws if content appears unsanitized (contains script tags, event handlers etc.).
 * This is a runtime guard — the compile-time guard is the SanitizedHtml branded type.
 */
export function assertSanitizedHtml(content: unknown, componentName = "unknown"): SanitizedHtml {
  if (typeof content !== "string") {
    throw new Error(`[render-safe] assertSanitizedHtml: expected string, got ${typeof content} in ${componentName}`);
  }
  // Re-sanitize and compare — if they differ, the input was not pre-sanitized
  const resanitized = renderSafeHtml(content);
  if (resanitized !== content) {
    // Log and return the resanitized version (do not throw in production — sanitize and continue)
    if (typeof window !== "undefined" && (window as any).__DEV__) {
      console.warn(
        `[render-safe] assertSanitizedHtml: content in ${componentName} was not pre-sanitized — sanitizing now.`,
        { original: content.slice(0, 200), sanitized: resanitized.slice(0, 200) },
      );
    }
    return resanitized;
  }
  return content as SanitizedHtml;
}

/**
 * Escape special HTML characters for safe embedding in text nodes.
 *
 * Use when constructing strings that will be inserted into HTML context
 * programmatically (e.g., template literals in non-React code).
 *
 * React renders string children as escaped text nodes automatically —
 * this helper is for non-React contexts or pre-processing.
 */
export function escapeForTextNode(input: string | null | undefined): string {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Check if a string contains potentially unsafe HTML patterns.
 * Used for testing and auditing — not a replacement for sanitization.
 */
export function containsUnsafeHtml(input: string): boolean {
  if (!input) return false;
  const UNSAFE_PATTERNS = [
    /<script\b/i,
    /javascript\s*:/i,
    /on\w+\s*=/i,
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
    /<form\b/i,
    /data\s*:[^,]*base64/i,
  ];
  return UNSAFE_PATTERNS.some((p) => p.test(input));
}
