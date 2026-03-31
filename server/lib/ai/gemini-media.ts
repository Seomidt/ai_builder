/**
 * gemini-media.ts — Central Gemini 2.5 Flash multimodal extraction helper.
 *
 * Handles all non-text file types via Google AI's OpenAI-compatible endpoint:
 *   - PDF:   native PDF understanding (text, tables, scanned pages)
 *   - Image: vision analysis (text extraction + visual description)
 *   - Video: frame-by-frame analysis + spoken content transcription
 *   - Audio: speech-to-text transcription
 *
 * Uses GEMINI_API_KEY → https://generativelanguage.googleapis.com/v1beta/openai
 * Model: gemini-2.5-flash (~$0.075/1M tokens — cheapest capable multimodal model)
 *
 * Max inline payload: ~20 MB base64. Files larger than this should be
 * uploaded via the Google Files API (not yet implemented — fallback to error).
 *
 * SOC2: file content is never logged — only metadata (filename, mime, chars).
 */

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY ?? "";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL    = "gemini-2.5-flash";

// 18 MB base64 limit (leaves headroom for JSON overhead)
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

export type GeminiMediaType = "pdf" | "image" | "video" | "audio" | "unknown";

export interface GeminiMediaResult {
  text:       string;
  mediaType:  GeminiMediaType;
  model:      string;
  charCount:  number;
}

/**
 * Classify a MIME type into a Gemini media category.
 */
export function classifyMime(mimeType: string, filename: string): GeminiMediaType {
  const mime = mimeType.toLowerCase();
  const ext  = filename.toLowerCase().split(".").pop() ?? "";

  if (mime === "application/pdf" || ext === "pdf") return "pdf";

  if (mime.startsWith("image/")) return "image";

  if (
    mime.startsWith("video/") ||
    ["mp4", "mov", "avi", "webm", "mpeg", "mkv", "m4v"].includes(ext)
  ) return "video";

  if (
    mime.startsWith("audio/") ||
    ["mp3", "wav", "ogg", "aac", "m4a", "flac", "opus"].includes(ext)
  ) return "audio";

  return "unknown";
}

/**
 * Build the extraction prompt based on media type.
 */
function buildPrompt(mediaType: GeminiMediaType, filename: string): string {
  switch (mediaType) {
    case "pdf":
      return `Udtræk og returner ALT tekst fra dette PDF-dokument præcist som det fremgår.

Regler:
- Udtræk HELE dokumentets tekstindhold — ingen udeladelser
- Bevar dokumentets struktur (overskrifter, afsnit, tabeller, lister, sidenumre)
- Inkludér alle tal, datoer, navne og juridiske termer præcist
- Svar KUN med dokumentets tekst — ingen kommentarer eller forklaringer
- Bevar det originale sprog (dansk, engelsk osv.)
- Tabeller: bevar kolonner og rækker med tabulering
- Hvis dokumentet er scannet/billede-baseret: transskribér al synlig tekst

Dokument: ${filename}`;

    case "image":
      return `Analysér dette billede grundigt og returner:

1. AL synlig tekst i billedet (OCR) — præcist som den fremgår
2. En detaljeret beskrivelse af billedets indhold (hvad vises, farver, layout, diagrammer, tabeller)
3. Hvis det er et dokument/screenshot: udtræk strukturen (overskrifter, felter, værdier)
4. Hvis det er et diagram/flowchart: beskriv elementerne og forbindelserne

Format:
=== TEKST I BILLEDE ===
[al synlig tekst]

=== BILLEDBESKRIVELSE ===
[detaljeret beskrivelse]

Billede: ${filename}`;

    case "video":
      return `Analysér denne video grundigt og returner:

1. TRANSSKRIPTION: Al talt dialog og fortælling ord-for-ord
2. VISUEL BESKRIVELSE: Hvad vises i videoen (scener, tekst på skærm, diagrammer, handlinger)
3. NØGLEPUNKTER: De vigtigste informationer fra videoen
4. TIDSSTEMPLER: Angiv ca. tidspunkter for vigtige skift eller emner (hvis muligt)

Format:
=== TRANSSKRIPTION ===
[al talt tekst]

=== VISUEL BESKRIVELSE ===
[hvad vises]

=== NØGLEPUNKTER ===
[vigtigste informationer]

Video: ${filename}`;

    case "audio":
      return `Transskribér denne lydfil ord-for-ord.

Regler:
- Transskribér AL talt tekst præcist
- Bevar det originale sprog
- Angiv [PAUSE] ved lange pauser
- Angiv [UTYDELIGT] hvis noget ikke kan høres
- Inkludér ikke tidsstempler medmindre der er tydelige skift i emne

Lydfil: ${filename}`;

    default:
      return `Udtræk al tilgængelig information fra denne fil: ${filename}`;
  }
}

/**
 * Extract content from a media file using Gemini 2.5 Flash.
 *
 * @param fileBuffer  Raw file bytes
 * @param filename    Original filename (used for logging and prompt context)
 * @param mimeType    MIME type of the file
 * @returns           Extracted text and metadata
 */
export async function extractWithGemini(
  fileBuffer: Buffer,
  filename:   string,
  mimeType:   string,
  modelOverride?: string,
): Promise<GeminiMediaResult> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Add it to Railway environment variables.");
  }

  const mediaType = classifyMime(mimeType, filename);

  if (mediaType === "unknown") {
    throw new Error(`Unsupported media type: ${mimeType} (${filename})`);
  }

  if (fileBuffer.length > MAX_INLINE_BYTES) {
    throw new Error(
      `File too large for inline processing: ${fileBuffer.length} bytes (max ${MAX_INLINE_BYTES}). ` +
      `File: ${filename}`,
    );
  }

  const base64   = fileBuffer.toString("base64");
  const prompt   = buildPrompt(mediaType, filename);

  // Gemini uses "image_url" field for all media types via OpenAI-compatible endpoint
  // The MIME type in the data URL tells Gemini how to interpret the content
  const requestBody = {
    model:       modelOverride || GEMINI_MODEL,
    temperature: 0,
    max_tokens:  16000,
    messages: [
      {
        role:    "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          {
            type:      "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
  };

  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${GEMINI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Gemini API error ${response.status} for ${mediaType} (${filename}): ${errText.slice(0, 300)}`,
    );
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model?:  string;
    usage?:  { total_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";

  return {
    text,
    mediaType,
    model:     data.model ?? GEMINI_MODEL,
    charCount: text.length,
  };
}
