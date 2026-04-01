/**
 * pdf-page-splitter.ts — Pure-JS PDF page isolation using pdf-lib.
 *
 * Splits a multi-page PDF buffer into individual single-page PDF buffers.
 * Each page buffer can be sent to Gemini Vision independently, enabling
 * parallel per-page OCR instead of one monolithic 15–45s call.
 *
 * No native dependencies — pdf-lib is pure JavaScript/WASM.
 */

export interface PageSplitResult {
  pageBuffers: Buffer[];
  pageCount:   number;
}

const MAX_PAGES = 50; // Guard against very large documents

/**
 * Split a PDF buffer into individual per-page PDF buffers.
 *
 * Returns the original buffer as a single-element array if:
 *  - pdf-lib fails to load
 *  - the PDF has 0 or 1 pages
 *  - an error occurs during splitting
 */
export async function splitPdfIntoPages(pdfBuffer: Buffer): Promise<PageSplitResult> {
  try {
    const { PDFDocument } = await import("pdf-lib");

    const srcDoc   = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const numPages = srcDoc.getPageCount();

    if (numPages <= 1) {
      return { pageBuffers: [pdfBuffer], pageCount: Math.max(numPages, 1) };
    }

    const cappedPages = Math.min(numPages, MAX_PAGES);

    const pageBuffers = await Promise.all(
      Array.from({ length: cappedPages }, async (_, i) => {
        const single           = await PDFDocument.create();
        const [copiedPage]     = await single.copyPages(srcDoc, [i]);
        single.addPage(copiedPage);
        const bytes = await single.save({ useObjectStreams: false });
        return Buffer.from(bytes);
      }),
    );

    return { pageBuffers, pageCount: cappedPages };
  } catch (err) {
    console.warn(
      `[pdf-page-splitter] Failed to split PDF (${(err as Error).message}), ` +
      "falling back to monolithic processing.",
    );
    return { pageBuffers: [pdfBuffer], pageCount: 1 };
  }
}
