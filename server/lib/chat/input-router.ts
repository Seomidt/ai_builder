/**
 * input-router.ts — Central input routing decision point (PHASE A–H).
 *
 * Single source of truth that decides which processing pipeline handles each
 * file input. Replaces ad-hoc if/else spread across upload/finalize.
 *
 * Routes:
 *   direct_text_fast_path       — text/plain, text/markdown, application/json, etc.
 *   code_text_fast_path         — source code files (.ts, .py, .js, etc.)
 *   native_text_pdf_fast_path   — PDFs with ≥120 non-whitespace embedded chars
 *   scanned_pdf_ocr_path        — PDFs with <120 non-ws chars (scanned/image-based)
 *   image_vision_path           — image/* files
 *   audio_transcription_path    — audio/* files
 *   video_multimodal_path       — video/* files
 *   unsupported                 — everything else
 *
 * INV-IR1: text/plain NEVER enters scanned_pdf_ocr_path.
 * INV-IR2: audio/video NEVER enter image_vision_path.
 * INV-IR3: Native PDFs (≥120 non-ws chars) NEVER enter OCR.
 * INV-IR4: Route selection is deterministic — same inputs → same route.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type InputRoute =
  | "direct_text_fast_path"
  | "code_text_fast_path"
  | "native_text_pdf_fast_path"
  | "scanned_pdf_ocr_path"
  | "image_vision_path"
  | "audio_transcription_path"
  | "video_multimodal_path"
  | "unsupported";

export interface InputRouterParams {
  mimeType:            string;
  filename:            string;
  sizeBytes:           number;
  /** For PDFs: non-whitespace char count extracted by pdf-parse (0 if scanned). */
  embeddedTextNonWsChars?: number;
}

export interface InputRouteResult {
  route:  InputRoute;
  reason: string;
}

// ── MIME sets ─────────────────────────────────────────────────────────────────

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/json", "application/xml", "text/xml",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs", ".java",
  ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".swift", ".kt", ".sh",
  ".bash", ".zsh", ".yaml", ".yml", ".toml", ".sql", ".graphql", ".gql",
  ".vue", ".svelte", ".lua", ".r", ".m", ".scala", ".ex", ".exs",
]);

const IMAGE_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/tiff", "image/bmp", "image/svg+xml",
]);

const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm",
  "audio/aac", "audio/flac", "audio/x-wav", "audio/mp4",
]);

const VIDEO_MIMES = new Set([
  "video/mp4", "video/quicktime", "video/x-msvideo",
  "video/webm", "video/mpeg",
]);

const PDF_MIMES = new Set(["application/pdf"]);

// ── Extension helpers ─────────────────────────────────────────────────────────

function ext(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function isCodeFile(filename: string, mimeType: string): boolean {
  if (CODE_EXTENSIONS.has(ext(filename))) return true;
  // Some editors upload code files as text/plain
  if (mimeType === "text/plain" && CODE_EXTENSIONS.has(ext(filename))) return true;
  return false;
}

function isPdfFile(mimeType: string, filename: string): boolean {
  return PDF_MIMES.has(mimeType) || filename.toLowerCase().endsWith(".pdf");
}

// ── Main routing function ─────────────────────────────────────────────────────

/**
 * Select the correct processing pipeline for a given file input.
 *
 * @param params.embeddedTextNonWsChars  Set ONLY for PDFs after pdf-parse.
 *   >= 120  → native_text_pdf_fast_path
 *   <  120  → scanned_pdf_ocr_path
 *   omitted → assume scanned (OCR path) for safety
 */
export function selectInputRoute(params: InputRouterParams): InputRouteResult {
  const { mimeType, filename, embeddedTextNonWsChars } = params;

  // ── INV-IR1: MIME type is authoritative — text/* always wins over extension ─
  // Code files: checked before generic text (code is a subset of text/plain)
  if (isCodeFile(filename, mimeType)) {
    return { route: "code_text_fast_path", reason: `code_extension:${ext(filename)}` };
  }

  // ── Plain text / structured text — before PDF extension check ────────────
  if (TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/")) {
    return { route: "direct_text_fast_path", reason: `text_mime:${mimeType}` };
  }

  // ── PDF — MIME type must be application/pdf OR filename ends with .pdf
  //   (only if MIME type was NOT already classified above as text/code)
  if (isPdfFile(mimeType, filename)) {
    const nonWs = embeddedTextNonWsChars ?? 0;
    if (nonWs >= 120) {
      return { route: "native_text_pdf_fast_path", reason: `pdf_native_text:${nonWs}chars` };
    }
    return { route: "scanned_pdf_ocr_path", reason: `pdf_scanned:${nonWs}chars` };
  }

  // ── Image ─────────────────────────────────────────────────────────────────
  if (IMAGE_MIMES.has(mimeType) || mimeType.startsWith("image/")) {
    return { route: "image_vision_path", reason: `image_mime:${mimeType}` };
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  if (AUDIO_MIMES.has(mimeType) || mimeType.startsWith("audio/")) {
    return { route: "audio_transcription_path", reason: `audio_mime:${mimeType}` };
  }

  // ── Video ─────────────────────────────────────────────────────────────────
  if (VIDEO_MIMES.has(mimeType) || mimeType.startsWith("video/")) {
    return { route: "video_multimodal_path", reason: `video_mime:${mimeType}` };
  }

  return { route: "unsupported", reason: `unknown_mime:${mimeType}` };
}
