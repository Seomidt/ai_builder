export type DocumentMode = "fast_text" | "fast_partial_ocr" | "durable_only_fallback";

export interface DocumentClassification {
  mode: DocumentMode;
  reason: string;
  mimeType: string;
  detectedTextiness: "text" | "binary" | "unknown";
  estimatedSize: number;
  canFastExtract: boolean;
  canPartialOcr: boolean;
}

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/rtf",
]);

const TEXTUAL_OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const PDF_MIME = "application/pdf";

const FAST_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
const PARTIAL_OCR_MAX_BYTES = 50 * 1024 * 1024;

export function classifyDocument(input: {
  mimeType: string;
  sizeBytes: number;
  filename: string;
}): DocumentClassification {
  const { mimeType, sizeBytes, filename } = input;
  const lowerName = filename.toLowerCase();

  if (TEXT_MIME_TYPES.has(mimeType) || lowerName.endsWith(".txt") || lowerName.endsWith(".csv") || lowerName.endsWith(".md")) {
    return {
      mode: "fast_text",
      reason: "plain_text_direct_read",
      mimeType,
      detectedTextiness: "text",
      estimatedSize: sizeBytes,
      canFastExtract: true,
      canPartialOcr: false,
    };
  }

  if (mimeType === PDF_MIME || lowerName.endsWith(".pdf")) {
    if (sizeBytes <= FAST_EXTRACT_MAX_BYTES) {
      return {
        mode: "fast_text",
        reason: "pdf_client_extract",
        mimeType,
        detectedTextiness: "unknown",
        estimatedSize: sizeBytes,
        canFastExtract: true,
        canPartialOcr: true,
      };
    }
    if (sizeBytes <= PARTIAL_OCR_MAX_BYTES) {
      return {
        mode: "fast_partial_ocr",
        reason: "pdf_large_partial_ocr",
        mimeType,
        detectedTextiness: "unknown",
        estimatedSize: sizeBytes,
        canFastExtract: false,
        canPartialOcr: true,
      };
    }
    return {
      mode: "durable_only_fallback",
      reason: "pdf_too_large_for_fast_path",
      mimeType,
      detectedTextiness: "unknown",
      estimatedSize: sizeBytes,
      canFastExtract: false,
      canPartialOcr: false,
    };
  }

  if (TEXTUAL_OFFICE_MIMES.has(mimeType)) {
    if (sizeBytes <= FAST_EXTRACT_MAX_BYTES) {
      return {
        mode: "fast_text",
        reason: "office_doc_small_enough",
        mimeType,
        detectedTextiness: "unknown",
        estimatedSize: sizeBytes,
        canFastExtract: true,
        canPartialOcr: false,
      };
    }
    return {
      mode: "durable_only_fallback",
      reason: "office_doc_too_large",
      mimeType,
      detectedTextiness: "binary",
      estimatedSize: sizeBytes,
      canFastExtract: false,
      canPartialOcr: false,
    };
  }

  return {
    mode: "durable_only_fallback",
    reason: `unsupported_or_binary_mime:${mimeType}`,
    mimeType,
    detectedTextiness: "binary",
    estimatedSize: sizeBytes,
    canFastExtract: false,
    canPartialOcr: false,
  };
}
