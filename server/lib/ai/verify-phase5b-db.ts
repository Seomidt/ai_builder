/**
 * Phase 5B DB verification script
 * Run with: npx tsx server/lib/ai/verify-phase5b-db.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

async function run() {
  // 1. New columns on knowledge_document_versions
  const kdvCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'knowledge_document_versions'
      AND column_name IN ('parser_name','parser_version','parse_status','parse_started_at','parse_completed_at','parsed_text_checksum','normalized_character_count','parse_failure_reason')
    ORDER BY column_name
  `);
  console.log("=== knowledge_document_versions new columns ===");
  for (const r of kdvCols.rows) {
    const row = r as { column_name: string; data_type: string; is_nullable: string };
    console.log(`  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable}`);
  }

  // 2. New columns on knowledge_processing_jobs
  const kpjCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'knowledge_processing_jobs'
      AND column_name IN ('processor_name','processor_version','locked_at','heartbeat_at')
    ORDER BY column_name
  `);
  console.log("\n=== knowledge_processing_jobs new columns ===");
  for (const r of kpjCols.rows) {
    const row = r as { column_name: string; data_type: string; is_nullable: string };
    console.log(`  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable}`);
  }

  // 3. New columns on knowledge_chunks
  const kcCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
      AND column_name IN ('chunk_strategy','chunk_version','overlap_characters','source_heading_path','source_section_label','replaced_at','replaced_by_job_id')
    ORDER BY column_name
  `);
  console.log("\n=== knowledge_chunks new columns ===");
  for (const r of kcCols.rows) {
    const row = r as { column_name: string; data_type: string; is_nullable: string };
    console.log(`  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable}`);
  }

  // 4. Partial unique indexes on knowledge_chunks
  const idx = await db.execute(sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'knowledge_chunks'
      AND indexname IN ('kc_version_chunk_index_active_unique','kc_version_chunk_key_active_unique')
  `);
  console.log("\n=== knowledge_chunks partial unique indexes ===");
  for (const r of idx.rows) {
    const row = r as { indexname: string; indexdef: string };
    console.log(`  ${row.indexname}`);
    console.log(`    ${row.indexdef}`);
  }

  // 5. CHECK constraints
  const chk = await db.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname IN ('kdv_parse_status_check','kdv_norm_char_count_check','kc_overlap_chars_check')
    ORDER BY conname
  `);
  console.log("\n=== new CHECK constraints ===");
  for (const r of chk.rows) {
    const row = r as { conname: string; def: string };
    console.log(`  ${row.conname}: ${row.def}`);
  }

  // 6. Sample parse metadata from a real parsed version
  const parsedVers = await db.execute(sql`
    SELECT id, tenant_id, parse_status, parser_name, parser_version, normalized_character_count, parsed_text_checksum
    FROM knowledge_document_versions
    WHERE parse_status = 'completed'
    LIMIT 3
  `);
  console.log("\n=== sample parsed version rows ===");
  for (const r of parsedVers.rows) {
    const row = r as Record<string, string | number | null>;
    console.log(`  id=${String(row.id).slice(0,8)} parseStatus=${row.parse_status} parser=${row.parser_name}@${row.parser_version} chars=${row.normalized_character_count}`);
  }

  // 7. Sample chunk rows with strategy/replacement fields
  const chunks = await db.execute(sql`
    SELECT id, chunk_index, chunk_strategy, chunk_version, overlap_characters, chunk_active, replaced_by_job_id
    FROM knowledge_chunks
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log("\n=== sample chunk rows ===");
  for (const r of chunks.rows) {
    const row = r as Record<string, string | number | boolean | null>;
    console.log(`  id=${String(row.id).slice(0,8)} idx=${row.chunk_index} strategy=${row.chunk_strategy}@${row.chunk_version} overlap=${row.overlap_characters} active=${row.chunk_active} replacedBy=${row.replaced_by_job_id ? String(row.replaced_by_job_id).slice(0,8) : 'null'}`);
  }

  // 8. Sample deactivated (replaced) chunks
  const deact = await db.execute(sql`
    SELECT id, chunk_index, chunk_active, replaced_at, replaced_by_job_id
    FROM knowledge_chunks
    WHERE chunk_active = false AND replaced_by_job_id IS NOT NULL
    LIMIT 3
  `);
  console.log("\n=== sample replaced/deactivated chunks ===");
  for (const r of deact.rows) {
    const row = r as Record<string, string | number | boolean | Date | null>;
    console.log(`  id=${String(row.id).slice(0,8)} idx=${row.chunk_index} active=false replacedAt=${row.replaced_at} replacedByJob=${String(row.replaced_by_job_id).slice(0,8)}`);
  }

  // 9. Sample processing jobs with new lock fields
  const jobs = await db.execute(sql`
    SELECT id, job_type, status, processor_name, processor_version, locked_at, heartbeat_at, worker_id
    FROM knowledge_processing_jobs
    WHERE job_type IN ('parse','chunk')
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log("\n=== sample processing job rows ===");
  for (const r of jobs.rows) {
    const row = r as Record<string, string | null | Date>;
    console.log(`  id=${String(row.id).slice(0,8)} type=${row.job_type} status=${row.status} processor=${row.processor_name}@${row.processor_version} lockedAt=${row.locked_at ? 'yes' : 'null'}`);
  }

  // 10. Sample index state rows after chunking
  const idxStates = await db.execute(sql`
    SELECT id, index_state, chunk_count, indexed_chunk_count, embedding_count
    FROM knowledge_index_state
    ORDER BY updated_at DESC
    LIMIT 5
  `);
  console.log("\n=== sample index_state rows after chunking ===");
  for (const r of idxStates.rows) {
    const row = r as Record<string, string | number | null>;
    console.log(`  id=${String(row.id).slice(0,8)} indexState=${row.index_state} chunks=${row.chunk_count} indexedChunks=${row.indexed_chunk_count} embeddings=${row.embedding_count}`);
  }

  console.log("\n=== DB VERIFICATION COMPLETE ===");
  process.exit(0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
