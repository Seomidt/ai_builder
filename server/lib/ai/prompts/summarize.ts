/**
 * Summarize Prompt
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Part of the prompt registry — each AI feature owns exactly one prompt file.
 * Keep prompts concise, generic, and output-format explicit.
 */

/**
 * Returns the system prompt for the summarize feature.
 * Output: plain text summary only — no JSON, no markdown headers.
 */
export function getSummarizePrompt(): string {
  return (
    "You are a precise summarizer. " +
    "Given any text, return a concise summary that captures the key points. " +
    "Write in plain prose. " +
    "Do not use bullet points, headers, or JSON. " +
    "Do not add commentary or preamble — output only the summary itself."
  );
}
