/**
 * KB OCR Adapter — Storage 1.3
 *
 * Isolated OCR adapter using OpenAI Vision (gpt-4o-mini).
 * Swap this file to integrate Tesseract, Google Vision, or Azure OCR later.
 *
 * Contract:
 *   extractTextFromImageBuffer(buffer, mimeType) → string | null
 *   Throws OcrProviderError if provider is unavailable.
 */

import { isOpenAIAvailable, getOpenAIClient } from "../openai-client";

export class OcrProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrProviderError";
  }
}

// ── extractTextFromImageBuffer ─────────────────────────────────────────────────
// Sends image bytes to OpenAI Vision for OCR text extraction.
// Returns extracted text, or null if the image contains no readable text.

export async function extractTextFromImageBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  if (!isOpenAIAvailable()) {
    throw new OcrProviderError(
      "OCR provider not available — set OPENAI_API_KEY to enable image OCR",
    );
  }

  const supportedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
  if (!supportedTypes.includes(mimeType)) {
    throw new OcrProviderError(
      `OCR not supported for MIME type '${mimeType}' — supported: ${supportedTypes.join(", ")}`,
    );
  }

  const base64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: dataUrl, detail: "high" },
          },
          {
            type: "text",
            text: "Extract all text visible in this image. Return only the extracted text verbatim, preserving structure where possible. If no text is present, return the single word: EMPTY",
          },
        ],
      },
    ],
    max_tokens: 4096,
  });

  const extracted = response.choices[0]?.message?.content?.trim() ?? "";
  if (!extracted || extracted === "EMPTY") {
    return "";
  }
  return extracted;
}

// ── fetchImageFromR2AndOcr ─────────────────────────────────────────────────────
// Convenience: fetch image from R2 by storageKey, then run OCR.

export async function fetchImageFromR2AndOcr(
  storageKey: string,
  mimeType: string,
): Promise<string> {
  const { R2_CONFIGURED, R2_BUCKET, r2Client } = await import("../r2/r2-client");
  if (!R2_CONFIGURED) {
    throw new OcrProviderError("R2 storage not configured — cannot fetch image for OCR");
  }

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: storageKey }));

  const chunks: Buffer[] = [];
  const stream = resp.Body as NodeJS.ReadableStream;
  await new Promise<void>((res, rej) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", res);
    stream.on("error", rej);
  });

  const buffer = Buffer.concat(chunks);
  return extractTextFromImageBuffer(buffer, mimeType);
}
