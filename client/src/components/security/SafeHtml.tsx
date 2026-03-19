/**
 * Phase 43 — SafeHtml Component
 *
 * THE ONLY approved way to render sanitized HTML in the frontend.
 * All dangerouslySetInnerHTML usage outside this component is forbidden
 * unless explicitly documented as "INTERNAL — no user input".
 *
 * Usage:
 *   <SafeHtml content={untrustedContent} mode="html" />
 *   <SafeHtml content={aiOutput} mode="text" />
 *
 * The component sanitizes internally — it never accepts SanitizedHtml branded type
 * as input to avoid false confidence. Sanitization is always applied on render.
 *
 * INV-FE-1: This is the only component that may use dangerouslySetInnerHTML.
 * INV-FE-2: mode="text" renders via React text nodes (no innerHTML) — defence in depth.
 * INV-FE-3: mode="html" runs DOMPurify before every render.
 */

import { useMemo } from "react";
import { renderSafeHtml, renderSafeText } from "@/lib/security/render-safe-content";

interface SafeHtmlProps {
  /** Untrusted content — will be sanitized before rendering */
  content: string | null | undefined;

  /**
   * Rendering mode:
   *   "text" — strips all HTML, renders as plain text (default — safest)
   *   "html"  — sanitizes HTML via DOMPurify allowlist, renders via innerHTML
   *
   * Use "html" only when rich formatting must be preserved for the user.
   * Always use "text" for AI output, audit metadata, user-supplied labels/names.
   */
  mode?: "text" | "html";

  /** Optional CSS class applied to wrapper element */
  className?: string;

  /** Wrapper element tag — defaults to "div" for html mode, "span" for text mode */
  as?: keyof JSX.IntrinsicElements;

  /** data-testid for testing */
  "data-testid"?: string;
}

/**
 * SafeHtml — centralized safe content renderer.
 *
 * Mode "text" (default): Strips all HTML, renders plain text.
 * Mode "html": Sanitizes via DOMPurify allowlist, renders controlled innerHTML.
 *
 * @example
 * // AI output — plain text only
 * <SafeHtml content={run.output} mode="text" />
 *
 * @example
 * // Document preview — allow safe formatting
 * <SafeHtml content={doc.renderedHtml} mode="html" className="prose" />
 */
export function SafeHtml({
  content,
  mode = "text",
  className,
  as,
  "data-testid": testId,
}: SafeHtmlProps) {
  const Tag = as ?? (mode === "html" ? "div" : "span");

  const sanitized = useMemo(() => {
    if (mode === "html") {
      return renderSafeHtml(content);
    }
    return renderSafeText(content);
  }, [content, mode]);

  if (mode === "html") {
    return (
      <Tag
        className={className}
        data-testid={testId}
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  // mode === "text": React renders string children as escaped text nodes
  // DOMPurify already stripped any tags in renderSafeText() — double safe
  return (
    <Tag className={className} data-testid={testId}>
      {sanitized}
    </Tag>
  );
}

export default SafeHtml;
