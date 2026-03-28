/**
 * ocr-queue.ts — Thin re-export shim for Vercel serverless handlers.
 *
 * Business logic lives in server/lib/jobs/job-queue.ts.
 * This file keeps import paths clean for api/_src/ consumers.
 */

export {
  enqueueOcrJob     as createOcrTask,
  ensureOcrSchema,
  getJob            as getOcrTask,
  claimJobs,
  updateStage,
  markOcrCompleted,
  completeJob,
  failJob           as markOcrFailed,
  storeChunks       as storeOcrChunks,
  logOcrCost,
  estimateOcrCost,
  archiveOldJobs,
  type RawOcrTask,
  type OcrChunkRow  as OcrChunk,
  type OcrCostLog,
} from "../../../server/lib/jobs/job-queue";

export type { OcrJob, OcrJobPayload, OcrJobCompletion } from "../../../server/lib/jobs/job-types";
