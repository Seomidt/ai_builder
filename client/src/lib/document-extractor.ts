export type FastExtractMode = "fast_text" | "fast_pdf" | "unsupported";

export interface FastExtractResult {
  text: string;
  charCount: number;
  source: "client_fast_text" | "client_fast_pdf";
  mode: FastExtractMode;
  durationMs: number;
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".md", ".markdown", ".html", ".htm",
  ".xml", ".json", ".rtf", ".log", ".yaml", ".yml", ".ini", ".cfg",
]);

const TEXT_MIMES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html",
  "text/xml", "application/json", "application/xml", "application/rtf",
]);

const MAX_TEXT_SIZE = 10 * 1024 * 1024;
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const MIN_USEFUL_CHARS = 80;

export function classifyForFastExtract(file: File): FastExtractMode {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const mime = file.type?.toLowerCase() ?? "";

  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(ext)) {
    return file.size <= MAX_TEXT_SIZE ? "fast_text" : "unsupported";
  }

  if (mime === "application/pdf" || ext === ".pdf") {
    return file.size <= MAX_PDF_SIZE ? "fast_pdf" : "unsupported";
  }

  return "unsupported";
}

async function extractTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read text file"));
    reader.readAsText(file, "utf-8");
  });
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const textParts: string[] = [];
  const maxPages = Math.min(pdf.numPages, 200);

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    if (pageText.trim()) {
      textParts.push(pageText.trim());
    }
  }

  return textParts.join("\n\n");
}

export async function fastExtractText(file: File): Promise<FastExtractResult | null> {
  const mode = classifyForFastExtract(file);
  if (mode === "unsupported") return null;

  const t0 = performance.now();

  try {
    let text: string;

    if (mode === "fast_text") {
      text = await extractTextFile(file);
    } else {
      text = await extractPdfText(file);
    }

    const trimmed = text.trim();
    const nonWsChars = trimmed.replace(/\s+/g, "").length;

    if (nonWsChars < MIN_USEFUL_CHARS) {
      console.log(`[fast-extract] ${file.name}: only ${nonWsChars} non-ws chars — below threshold`);
      return null;
    }

    const capped = trimmed.slice(0, 200_000);

    return {
      text: capped,
      charCount: capped.length,
      source: mode === "fast_text" ? "client_fast_text" : "client_fast_pdf",
      mode,
      durationMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    console.warn(`[fast-extract] ${file.name} failed:`, err);
    return null;
  }
}
