export type OcrFailureCategory =
  | "timeout"
  | "provider_transient"
  | "provider_permanent"
  | "network"
  | "invalid_input"
  | "storage"
  | "db"
  | "internal"
  | "unknown";

export interface OcrExecutionResult {
  success: boolean;
  provider: string;
  model: string;
  text?: string;
  errorCode?: string;
  errorMessage?: string;
  failureCategory?: OcrFailureCategory;
  durationMs: number;
  usedFallback: boolean;
}

export interface OcrProvider {
  name: string;
  extractText(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    model: string,
    timeoutMs: number
  ): Promise<OcrExecutionResult>;
}
