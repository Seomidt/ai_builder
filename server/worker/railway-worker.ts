/**
 * railway-worker.ts — Continuous background worker for OCR and Ingestion.
 * 
 * This file is designed to run as a long-lived process on Railway.
 * It polls the Supabase job queue and processes tasks one by one.
 */

import "../lib/env.ts";
import { 
  claimJobs, 
  type RawOcrTask 
} from "../lib/jobs/job-queue.ts";
import { processJob } from "../../api/_src/_lib/ocr-logic.ts";

const POLL_INTERVAL_MS = 5000; // 5 seconds
const CONCURRENCY_LIMIT = 2;   // Number of jobs to process in parallel per tick

async function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [RailwayWorker] ${message}`, data ? JSON.stringify(data) : "");
}

async function runWorker() {
  log("Starting Railway Worker...");
  
  // Infinite loop
  while (true) {
    try {
      // 1. Claim available jobs
      const jobs: RawOcrTask[] = await claimJobs(CONCURRENCY_LIMIT);
      
      if (jobs.length > 0) {
        log(`Claimed ${jobs.length} jobs. Starting processing...`);
        
        // 2. Process jobs in parallel
        await Promise.all(jobs.map(async (rawJob) => {
          try {
            log(`Processing job ${rawJob.id} for tenant ${rawJob.tenant_id}`);
            
            // Use the exported processJob logic directly
            await processJob(rawJob);
            
            log(`Job ${rawJob.id} successfully processed.`);
          } catch (jobError) {
            log(`Error processing job ${rawJob.id}:`, jobError);
          }
        }));
      } else {
        // No jobs found, wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      log("Worker loop error:", error);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

// Start the worker
runWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
