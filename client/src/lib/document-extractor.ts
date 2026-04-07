// ─── Types ────────────────────────────────────────────────────────────────────

export type FastExtractMode = "fast_text" | "fast_pdf" | "unsupported";

export type AnswerSource =
  | "client_fast_text"
  | "client_fast_pdf"
  | "r2_ocr_async"
  | "ocr_partial"
  | "r2_ocr_fallback";

export interface FastExtractResult {
  text: string;
  charCount: number;
  wordCount: number;
  alphaRatio: number;
  source: AnswerSource;
  mode: FastExtractMode;
  durationMs: number;
  rawChars: number;      // raw char count from extraction (before quality gate)
  pagesWithText: number; // pages that had text content (PDFs only, 1 for text files)
  workerSrc: string;     // pdf.js worker URL used ("" for text files)
  gateForced: boolean;   // true if quality gate was bypassed by hard assert
}

export interface UsabilityGateResult {
  passed: boolean;
  reason: string | null;
  nonWsChars: number;
  wordCount: number;
  alphaRatio: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".md", ".markdown", ".html", ".htm",
  ".xml", ".json", ".rtf", ".log", ".yaml", ".yml", ".ini", ".cfg",
]);

const TEXT_MIMES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html",
  "text/xml", "application/json", "application/xml", "application/rtf",
]);

const MAX_TEXT_SIZE   = 10 * 1024 * 1024; // 10 MB
const MAX_PDF_SIZE    = 10 * 1024 * 1024; // 10 MB
const MIN_NON_WS_CHARS = 80;
const MIN_WORD_COUNT  = 10;
const MIN_ALPHA_RATIO = 0.25; // at least 25% alphabetical chars (rejects pure OCR noise)
const MAX_EXTRACTED_CHARS = 200_000;

// ─── Classification ───────────────────────────────────────────────────────────

export function classifyForFastExtract(file: File): FastExtractMode {
  const nameLower = file.name.toLowerCase();
  const ext = "." + (nameLower.split(".").pop() ?? "");
  const mime = (file.type ?? "").toLowerCase();

  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(ext)) {
    return file.size <= MAX_TEXT_SIZE ? "fast_text" : "unsupported";
  }

  if (mime === "application/pdf" || ext === ".pdf") {
    return file.size <= MAX_PDF_SIZE ? "fast_pdf" : "unsupported";
  }

  return "unsupported";
}

// ─── Usability gate ───────────────────────────────────────────────────────────

export function checkTextUsability(text: string): UsabilityGateResult {
  const nonWsChars = text.replace(/\s+/g, "").length;
  const words      = text.trim().split(/\s+/).filter(w => w.length >= 2);
  const wordCount  = words.length;
  const alphaChars = (text.match(/[a-zA-ZÀ-ÖØ-öø-ÿ]/g) ?? []).length;
  const alphaRatio = nonWsChars > 0 ? alphaChars / nonWsChars : 0;

  if (nonWsChars < MIN_NON_WS_CHARS) {
    return {
      passed: false,
      reason: `too_short: only ${nonWsChars} non-whitespace chars (min ${MIN_NON_WS_CHARS})`,
      nonWsChars,
      wordCount,
      alphaRatio,
    };
  }

  if (wordCount < MIN_WORD_COUNT) {
    return {
      passed: false,
      reason: `too_few_words: only ${wordCount} words (min ${MIN_WORD_COUNT})`,
      nonWsChars,
      wordCount,
      alphaRatio,
    };
  }

  if (alphaRatio < MIN_ALPHA_RATIO) {
    return {
      passed: false,
      reason: `low_alpha_ratio: ${alphaRatio.toFixed(2)} (min ${MIN_ALPHA_RATIO}) — likely OCR noise or binary data`,
      nonWsChars,
      wordCount,
      alphaRatio,
    };
  }

  return { passed: true, reason: null, nonWsChars, wordCount, alphaRatio };
}

// ─── Extractors ───────────────────────────────────────────────────────────────

async function extractTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader failed to read file"));
    reader.readAsText(file, "utf-8");
  });
}

let pdfjsWorkerSrcCached: string | null = null;

// Run once at startup to log whether the local worker asset is accessible.
// Logs [pdfjs-worker] LOCAL_WORKER_OK or LOCAL_WORKER_MISSING so it is
// immediately visible in the browser console before any PDF is uploaded.
let _workerProbePromise: Promise<void> | null = null;
function probeLocalWorkerOnce(): Promise<void> {
  if (_workerProbePromise) return _workerProbePromise;
  _workerProbePromise = (async () => {
    const path = "/pdf.worker.min.mjs";
    try {
      const res = await fetch(path, { method: "HEAD" });
      if (res.ok) {
        console.log(`[pdfjs-worker] LOCAL_WORKER_OK status=${res.status} url=${path}`);
      } else {
        console.error(
          `[pdfjs-worker] LOCAL_WORKER_MISSING status=${res.status} url=${path}` +
          ` — pdf.js browser extraction will use CDN fallback (slow path risk).` +
          ` Fix: ensure dist/public/pdf.worker.min.mjs is emitted by the build.`,
        );
      }
    } catch (e: any) {
      console.error(`[pdfjs-worker] LOCAL_WORKER_PROBE_ERROR: ${e?.message}`);
    }
  })();
  return _workerProbePromise;
}

// Kick off the probe immediately when this module is loaded (no await needed).
probeLocalWorkerOnce();

async function resolvePdfjsWorkerSrc(): Promise<string> {
  if (pdfjsWorkerSrcCached) return pdfjsWorkerSrcCached;

  // Strategy 1: public/ directory — worker is explicitly copied here at build
  // time via script/build.ts. client/public/pdf.worker.min.mjs → /pdf.worker.min.mjs
  // vercel.json rewrite excludes this path so Vercel serves it as a static file.
  const localPath = "/pdf.worker.min.mjs";
  try {
    const probe = await fetch(localPath, { method: "HEAD" });
    if (probe.ok) {
      pdfjsWorkerSrcCached = localPath;
      console.log(`[pdfjs-worker] resolved via public path: ${localPath} (status=${probe.status})`);
      return pdfjsWorkerSrcCached;
    }
    console.error(
      `[pdfjs-worker] MISSING_LOCAL_WORKER ${localPath} — HTTP ${probe.status}.` +
      ` The worker file is missing from the deployed build.` +
      ` All text PDFs will fall back to slow OCR path (~40 s latency).`,
    );
  } catch (e: any) {
    console.error(`[pdfjs-worker] MISSING_LOCAL_WORKER ${localPath} — fetch error: ${e?.message}`);
  }

  // Strategy 2 (CDN FALLBACK — OBSERVABLE, NOT SILENT):
  // Only reached if /pdf.worker.min.mjs is missing from the deployment.
  // This keeps pdf.js functional but means browser extraction may be unreliable
  // for CORS-restricted origins, and signals a build pipeline problem.
  const { version } = await import("pdfjs-dist");
  const cdnUrl = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.mjs`;
  pdfjsWorkerSrcCached = cdnUrl;
  console.error(
    `[pdfjs-worker] CDN_FALLBACK_ACTIVE url=${cdnUrl}` +
    ` — LOCAL WORKER MISSING. This is a build/deploy misconfiguration.` +
    ` Expected: dist/public/pdf.worker.min.mjs in Vercel output directory.`,
  );
  return pdfjsWorkerSrcCached;
}

async function extractPdfText(
  file: File,
  traceLabel: string,
): Promise<{ text: string; pagesWithText: number; rawChars: number }> {
  const pdfjsLib = await import("pdfjs-dist");

  const workerSrc = await resolvePdfjsWorkerSrc();
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  const arrayBuffer = await file.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({
    data:             arrayBuffer,
    useSystemFonts:   true,
    disableAutoFetch: true,
    disableStream:    true,
  }).promise;

  const maxPages = Math.min(pdf.numPages, 200);
  console.log(`[pdfjs] ${traceLabel} numPages=${pdf.numPages} maxPages=${maxPages} workerSrc=${workerSrc.slice(0, 80)}`);

  const textParts: string[] = [];
  let emptyPages = 0;

  for (let i = 1; i <= maxPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    if (pageText.trim()) {
      textParts.push(pageText.trim());
    } else {
      emptyPages++;
    }
    page.cleanup();
  }

  const joined = textParts.join("\n\n");
  const pagesWithText = textParts.length;

  // Log per-page extraction result — critical for diagnosing image-only vs text PDFs
  if (joined.length === 0) {
    console.warn(
      `[pdfjs-raw] ${traceLabel}: ZERO_CHARS — pdf.js extracted 0 chars from ${maxPages} pages ` +
      `(emptyPages=${emptyPages}/${maxPages}). ` +
      `Likely causes: (1) scanned/image-only PDF → server OCR needed, ` +
      `(2) broken worker URL "${workerSrc.slice(0, 80)}" → check build assets.`,
    );
  } else {
    console.log(
      `[pdfjs-raw] ${traceLabel}: rawChars=${joined.length} ` +
      `pagesWithText=${pagesWithText}/${maxPages} emptyPages=${emptyPages}`,
    );
  }

  return { text: joined, pagesWithText, rawChars: joined.length };
}

// ─── PDF Page Rendering (for vision preview of scanned PDFs) ─────────────────

export async function renderPdfPagesToImages(
  file: File,
  maxPages: number = 3,
  maxWidth: number = 1200,
  quality: number = 0.7,
): Promise<{ images: string[]; pageCount: number } | null> {
  const t0 = performance.now();
  try {
    const pdfjsLib = await import("pdfjs-dist");
    const workerSrc = await resolvePdfjsWorkerSrc();
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      useSystemFonts: true,
    }).promise;

    const pageCount = pdf.numPages;
    const pagesToRender = Math.min(pageCount, maxPages);
    const images: string[] = [];

    for (let i = 1; i <= pagesToRender; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      const scale = Math.min(maxWidth / viewport.width, 2.0);
      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(scaledViewport.width);
      canvas.height = Math.floor(scaledViewport.height);
      const ctx = canvas.getContext("2d")!;

      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      if (base64) images.push(base64);

      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }

    const durMs = Math.round(performance.now() - t0);
    console.log(`[renderPdfPages] OK file="${file.name}" pages=${pagesToRender}/${pageCount} images=${images.length} durMs=${durMs}`);
    return { images, pageCount };
  } catch (e: any) {
    console.error(`[renderPdfPages] FAILED file="${file.name}": ${e?.message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Threshold for hard assert: if pdf.js extracted this many chars from at least 1
// page, it is provably a text PDF — skip quality gate and force the fast path.
// Prevents scanned-PDF noise gates from incorrectly routing text PDFs to OCR.
const HARD_ASSERT_MIN_CHARS = 2000;

export async function fastExtractText(
  file: File,
  traceLabel = file.name,
): Promise<FastExtractResult | null> {
  const mode = classifyForFastExtract(file);
  if (mode === "unsupported") {
    console.log(`[fast-extract] ${traceLabel}: SKIP — classifyForFastExtract=unsupported mime=${file.type} size=${file.size}`);
    return null;
  }

  const t0 = performance.now();
  console.log(`[fast-extract] ${traceLabel}: START mode=${mode} size=${file.size} mime=${file.type}`);

  try {
    let rawText: string;
    let pagesWithText = 1; // default for text files (single "page")
    let rawChars: number;

    if (mode === "fast_text") {
      rawText = await extractTextFile(file);
      rawChars = rawText.length;
    } else {
      // extractPdfText now returns {text, pagesWithText, rawChars}
      const pdfResult = await extractPdfText(file, traceLabel);
      rawText      = pdfResult.text;
      pagesWithText = pdfResult.pagesWithText;
      rawChars      = pdfResult.rawChars;
    }

    const workerSrc = pdfjsWorkerSrcCached ?? "";

    const gate = checkTextUsability(rawText);

    let gateForced = false;
    if (!gate.passed) {
      // ── HARD ASSERT: if pdf.js extracted ≥2000 chars from ≥1 page, it is
      //    provably a text PDF. The quality gate may reject due to alpha-ratio
      //    or word-count thresholds that are sensitive to formatting artifacts.
      //    Override: bypass gate, use extracted text, force fast path.
      if (rawChars >= HARD_ASSERT_MIN_CHARS && pagesWithText > 0) {
        gateForced = true;
        console.warn(
          `[LIVE-ASSERT] ${traceLabel}: GATE_BYPASS — rawChars=${rawChars} pagesWithText=${pagesWithText}` +
          ` gate_reason="${gate.reason}"` +
          ` → forcing ALL_FAST, skipping OCR fallback (hard assert active)`,
        );
      } else {
        console.log(
          `[fast-extract] ${traceLabel}: GATE_REJECTED — ${gate.reason}` +
          ` nonWs=${gate.nonWsChars} words=${gate.wordCount} alpha=${gate.alphaRatio.toFixed(2)}` +
          ` rawChars=${rawChars} pagesWithText=${pagesWithText}`,
        );
        return null;
      }
    }

    const capped = rawText.trim().slice(0, MAX_EXTRACTED_CHARS);
    const durationMs = Math.round(performance.now() - t0);
    const source: AnswerSource = mode === "fast_text" ? "client_fast_text" : "client_fast_pdf";

    console.log(
      `[fast-extract] ${traceLabel}: OK` +
      ` nonWs=${gate.nonWsChars} words=${gate.wordCount} alpha=${gate.alphaRatio.toFixed(2)}` +
      ` chars=${capped.length} rawChars=${rawChars} pagesWithText=${pagesWithText}` +
      ` gateForced=${gateForced} duration=${durationMs}ms source=${source}`,
    );

    return {
      text:         capped,
      charCount:    capped.length,
      wordCount:    gate.wordCount,
      alphaRatio:   gate.alphaRatio,
      source,
      mode,
      durationMs,
      rawChars,
      pagesWithText,
      workerSrc,
      gateForced,
    };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - t0);
    console.warn(`[fast-extract] ${traceLabel}: ERROR after ${durationMs}ms —`, err?.message ?? err);
    return null;
  }
}
