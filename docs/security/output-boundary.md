# Output Boundary — Content Safety Architecture

> Phase 43 — Enterprise Output Safety
> Last updated: 2026-03-19

---

## Overview

This document defines the **two-layer content safety architecture** used in this platform.

All content flowing through the platform is classified into one of two layers:

| Layer | Purpose | Library | File |
|-------|---------|---------|------|
| **A — AI Ingestion** | Prompt construction, search preprocessing, text extraction | Regex normalization | `server/lib/security/content-sanitizer.ts` |
| **B — Output / Rendering** | Browser display, stored display HTML | parser-based (sanitize-html / DOMPurify) | `server/lib/security/output-sanitizer.ts` |

---

## Layer A — AI Ingestion / Text Extraction

**File:** `server/lib/security/content-sanitizer.ts`

**Use when:**
- Building prompts for AI models
- Preprocessing text for embedding or search
- Extracting plain text from imported documents
- Normalizing text before storage (non-rendered)

**Safe for:**
- `normalizePlainTextForAiInput(content)` — preferred alias
- `sanitizePlainTextInput(content)` — legacy name (identical behavior)

**NOT safe for:**
- HTML rendering in the browser
- Content passed to `dangerouslySetInnerHTML`
- Content stored as HTML for later display

**Why regex-based is acceptable here:**
Layer A output is never rendered as HTML. It is consumed by AI models as plain text.
Regex-based normalization is deterministic, fast, and correct for this purpose.

### Forbidden patterns in Layer A code

```typescript
// ✗ WRONG — do not use Layer A sanitizer for rendered output
const html = sanitizePlainTextInput(userHtml);
element.innerHTML = html;  // FORBIDDEN

// ✓ CORRECT — Layer A for AI prompt
const promptText = normalizePlainTextForAiInput(documentContent);
const response = await openai.chat(promptText);
```

---

## Layer B — Output / Rendering / Storage for Display

**File:** `server/lib/security/output-sanitizer.ts` (server-side)
**File:** `client/src/lib/security/render-safe-content.ts` (client-side)

**Use when:**
- Displaying AI output to users in the browser
- Previewing imported document content
- Rendering user-supplied descriptions or comments
- Storing HTML content that will later be displayed

**Key functions:**

| Function | Returns | Use case |
|----------|---------|---------|
| `sanitizeHtmlForRender(input)` | `SanitizedHtml` | Rich HTML for browser rendering |
| `sanitizePlainTextForRender(input)` | `SafeText` | Plain text — strips all HTML |
| `stripAllHtml(input)` | `string` | Non-rendering programmatic use |
| `normalizeUntrustedContent(input)` | `string` | Storage normalization |
| `assertSafeRenderMode(mode)` | `void` | Boundary assertion |

**Frontend functions:**

| Function | Returns | Use case |
|----------|---------|---------|
| `renderSafeHtml(input)` | `SanitizedHtml` | DOMPurify — for `dangerouslySetInnerHTML` |
| `renderSafeText(input)` | `SafeText` | DOMPurify strip — for text nodes |
| `assertSanitizedHtml(input, name)` | `SanitizedHtml` | Boundary assertion |
| `escapeForTextNode(input)` | `string` | Non-React HTML context escaping |

### Branded types

The system uses TypeScript branded types to make boundary crossings explicit:

```typescript
type UnsafeUserContent = string & { __brand: "UnsafeUserContent" };
type SanitizedHtml     = string & { __brand: "SanitizedHtml" };
type SafeText          = string & { __brand: "SafeText" };
```

Rendering helpers only accept the branded output types — raw strings are rejected at compile time.

---

## HTML Allowlist Policy

The following tags are allowed in rich HTML rendering. All others are stripped.

### Allowed tags

```
b, strong, i, em, u, s, del, ins
p, br, hr
ul, ol, li, dl, dt, dd
code, pre, kbd, samp
blockquote, q, cite
h1, h2, h3, h4, h5, h6
a
table, thead, tbody, tfoot, tr, th, td, caption
div, span
abbr, acronym, address, small, sub, sup
```

### Allowed attributes

| Attribute | Allowed on | Purpose |
|-----------|-----------|---------|
| `href` | `a` | Link destination (https/http/mailto only) |
| `title` | `a`, `abbr`, `acronym` | Tooltip text |
| `target` | `a` | Link target |
| `rel` | `a` | Always forced to `noopener noreferrer` |
| `rowspan`, `colspan` | `td`, `th` | Table structure |
| `scope` | `th` | Accessibility |
| `summary` | `table` | Accessibility |
| `cite` | `blockquote`, `q` | Source attribution |

### Always forbidden

```
script, iframe, object, embed, form, svg, style, link, meta,
base, applet, noscript, template, slot, canvas, video, audio,
source, track
```

Event handler attributes (`onclick`, `onload`, `onerror`, etc.) are always stripped.

`javascript:` and `data:` URL schemes are never allowed in `href`.

---

## Frontend Rendering Component

The `SafeHtml` component in `client/src/components/security/SafeHtml.tsx` is the **only approved way** to render sanitized HTML in the frontend.

```tsx
// ✓ CORRECT — AI output as plain text
<SafeHtml content={run.output} mode="text" />

// ✓ CORRECT — Document preview with formatting
<SafeHtml content={doc.renderedHtml} mode="html" className="prose" />

// ✗ WRONG — never do this
<div dangerouslySetInnerHTML={{ __html: untrustedContent }} />
```

**Rule:** Any component rendering HTML must use `<SafeHtml>` or call `renderSafeHtml()` explicitly.

---

## CSP Policy

The Content Security Policy enforces browser-level rendering boundaries.

### Active directives

| Directive | Value (production) | Reason |
|-----------|-------------------|--------|
| `default-src` | `'self'` | Deny-by-default |
| `script-src` | `'self'` | No inline scripts, no CDN wildcards |
| `style-src` | `'self' 'unsafe-inline'` | Required for Tailwind/shadcn |
| `img-src` | `'self' data: blob:` | Inline chart URIs, file previews |
| `connect-src` | `'self'` | Same-origin API only in production |
| `frame-ancestors` | `'none'` | Clickjacking prevention |
| `object-src` | `'none'` | Block plugins/Flash |
| `base-uri` | `'self'` | Base-tag hijacking prevention |
| `form-action` | `'self'` | Phishing form submission prevention |
| `worker-src` | `'self' blob:` | Service workers |
| `report-uri` | `/api/security/csp-report` | Violation observability |
| `upgrade-insecure-requests` | _(prod only)_ | Mixed content upgrade |

### CSP violation reporting

Violations are:
1. Sent by browsers to `POST /api/security/csp-report`
2. Validated and parsed by the endpoint
3. Stored in the `security_events` table with `eventType: "security_header_violation"`
4. Browser-extension noise filtered automatically

### Roadmap

| Item | Status | Notes |
|------|--------|-------|
| Nonce-based `script-src` | Phase 44 | Requires React SSR streaming rewrite |
| Nonce-based `style-src` | Phase 44 | Same as above |
| `report-to` (Reporting API v2) | Future | Browser support growing |
| Remove `cspMiddleware` duplicate | Phase 44 | Cleanup — current coexistence is safe |

---

## Content Flow Inventory

### A. Plain-text only (Layer A safe)

| Surface | Source | Handler |
|---------|--------|---------|
| AI model prompts | Document text extraction | `normalizePlainTextForAiInput()` |
| Search query preprocessing | User input | `normalizePlainTextForAiInput()` |
| Document import (PDF/DOCX) | Uploaded files | `sanitizePlainTextInput()` in `document-parsers.ts` |
| HTML-to-text import | Crawled HTML | `sanitizePlainTextInput()` in `import-content-parsers.ts` |

### B. HTML allowed but sanitized (Layer B required)

| Surface | Source | Handler | Status |
|---------|--------|---------|--------|
| AI output display | AI model response | React text nodes (no HTML needed) | ✓ Safe — plain text JSX |
| Document preview | Parsed document | Layer B sanitizer if HTML rendered | Document as noted |

### C. Internal only / never rendered

| Surface | Source | Notes |
|---------|--------|-------|
| Chart CSS vars | `chart.tsx` line 81 | THEMES object — not user input. Documented as safe |

### D. Unsafe / needs refactor

None identified. All rendering surfaces audited — no unsafe paths found.

---

## Forbidden Patterns

The following patterns are **never allowed** in this codebase:

### 1. Raw `dangerouslySetInnerHTML`

```tsx
// ✗ FORBIDDEN
<div dangerouslySetInnerHTML={{ __html: content }} />

// ✓ Required pattern
<SafeHtml content={content} mode="html" />
// or
<div dangerouslySetInnerHTML={{ __html: renderSafeHtml(content) }} />
```

Exception: `chart.tsx` — internal CSS custom properties from `THEMES` object. No user input.

### 2. Manual entity decode chains

```typescript
// ✗ FORBIDDEN — double-unescape vulnerability
content.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

// ✓ Required pattern
import { normalizeDecodedEntities } from "./content-sanitizer";
normalizeDecodedEntities(content);  // single-pass, convergence-safe
```

### 3. Regex-only HTML sanitization for rendered output

```typescript
// ✗ FORBIDDEN — regex cannot parse HTML correctly
const safe = content.replace(/<script>/gi, "");
element.innerHTML = safe;

// ✓ Required pattern
import { sanitizeHtmlForRender } from "./output-sanitizer";
const safe = sanitizeHtmlForRender(content);  // parser-based
```

### 4. Direct `innerHTML` assignment

```typescript
// ✗ FORBIDDEN
element.innerHTML = untrustedContent;

// ✓ Required pattern
element.innerHTML = renderSafeHtml(untrustedContent);
```

---

## Decision Guide

```
Is the content going to be rendered as HTML in the browser?
  ├─ YES → Use Layer B (output-sanitizer.ts / render-safe-content.ts)
  │         Use <SafeHtml> component in React
  │
  └─ NO  → Is it going to an AI model or search index?
             ├─ YES → Use Layer A (normalizePlainTextForAiInput)
             └─ NO  → Is it going to be stored as plain text?
                         ├─ YES → Use Layer A or basic validation
                         └─ NO  → Document the use case and add to inventory
```
