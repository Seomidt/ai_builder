// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// media-types.ts — Shared types, enums, and interfaces
// ============================================================

export type MediaType = "pdf" | "image" | "audio" | "video" | "text";
export type PipelineType =
  | "ocr"
  | "vision"
  | "transcription"
  | "parsing"
  | "embedding"
  | "multimodal_extract";

export type MediaJobStatus =
  | "pending"
  | "processing"
  | "retryable_failed"
  | "completed"
  | "failed"
  | "dead_letter";

export type MediaStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type StepType =
  | "preprocess"
  | "upload_media"
  | "extract_text"
  | "ocr"
  | "vision_caption"
  | "transcribe_audio"
  | "extract_audio_track"
  | "extract_video_frames"
  | "merge_multimodal_output"
  | "normalize_text"
  | "chunk_text"
  | "persist_output"
  | "index_embeddings"
  | "finalize";

export type FailureCategory =
  | "timeout"
  | "provider_transient"
  | "provider_permanent"
  | "network"
  | "invalid_input"
  | "invalid_output"
  | "unsupported_media"
  | "rate_limited"
  | "storage"
  | "db"
  | "internal"
  | "unknown";

// ── Job record (mirrors media_processing_jobs table) ─────────────────────────

export interface MediaProcessingJob {
  id: string;
  tenant_id: string;
  document_id?: string;
  knowledge_asset_id?: string;
  asset_version_id?: string;
  media_type: MediaType;
  pipeline_type: PipelineType;
  status: MediaJobStatus;
  current_step?: string;
  attempt_count: number;
  max_attempts: number;
  fallback_depth: number;
  created_at: string;
  updated_at: string;
  claimed_at?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  dead_lettered_at?: string;
  last_heartbeat_at?: string;
  worker_id?: string;
  execution_trace_id?: string;
  last_error_code?: string;
  last_error_message?: string;
  failure_category?: FailureCategory;
  retryable?: boolean;
  next_retry_at?: string;
  input_storage_ref: string;
  output_storage_ref?: string;
  processing_cost_estimate: number;
  processing_cost_actual: number;
  output_text?: string;
  output_char_count?: number;
  output_page_count?: number;
  output_chunk_count?: number;
  output_quality_score?: number;
  output_provider?: string;
  output_model?: string;
  filename?: string;
  content_type?: string;
  file_size_bytes?: number;
  metadata_jsonb?: Record<string, unknown>;
}

// ── Step record (mirrors media_processing_steps table) ───────────────────────

export interface MediaProcessingStep {
  id: string;
  tenant_id: string;
  job_id: string;
  document_id?: string;
  knowledge_asset_id?: string;
  step_key: string;
  step_type: StepType;
  step_order: number;
  status: MediaStepStatus;
  attempt_count: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  duration_ms?: number;
  provider?: string;
  model?: string;
  fallback_depth: number;
  last_error_code?: string;
  last_error_message?: string;
  failure_category?: FailureCategory;
  input_ref?: string;
  output_ref?: string;
  output_text?: string;
  output_char_count?: number;
  cost_estimate: number;
  cost_actual: number;
  metadata_jsonb?: Record<string, unknown>;
}

// ── Step execution result ─────────────────────────────────────────────────────

export interface StepExecutionResult {
  success: boolean;
  provider?: string;
  model?: string;
  outputText?: string;
  outputRef?: string;
  charCount?: number;
  pageCount?: number;
  costActual?: number;
  errorCode?: string;
  errorMessage?: string;
  failureCategory?: FailureCategory;
  retryable?: boolean;
  fallbackDepth?: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface MediaProvider {
  name: string;
  supportedStepTypes: StepType[];
  execute(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    model: string,
    timeoutMs: number,
    metadata?: Record<string, unknown>
  ): Promise<StepExecutionResult>;
}

// ── Pipeline step definition ──────────────────────────────────────────────────

export interface PipelineStepDef {
  stepType: StepType;
  provider: string;
  model: string;
  timeoutMs: number;
  optional?: boolean;
}

export interface PipelineDef {
  mediaType: MediaType;
  pipelineType: PipelineType;
  steps: PipelineStepDef[];
}

// ── Cost estimate ─────────────────────────────────────────────────────────────

export interface CostEstimate {
  estimatedCost: number;
  currency: "USD";
  breakdown: { step: StepType; provider: string; model: string; cost: number }[];
  blocked: boolean;
  blockReason?: string;
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  failureCategory?: FailureCategory;
  retryable: boolean;
}
