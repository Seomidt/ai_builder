# Phase 5Z.1 — Hardening Migration: Kørselsvejledning

## Fil: `migrations/phase-5z1-hardening.sql`

Migrationen er **idempotent** — den kan køres på en eksisterende schema uden risiko for datatab.
Alle DDL-kommandoer bruger `IF NOT EXISTS` / `IF EXISTS`.

---

## Trin 1 — Kør i Supabase SQL Editor

1. Åbn [Supabase Dashboard](https://supabase.com/dashboard) → dit BlissOps projekt
2. Gå til **SQL Editor**
3. Indsæt hele indholdet af `migrations/phase-5z1-hardening.sql`
4. Klik **Run**

---

## Trin 2 — Verificer at alt lykkedes

Kør efterfølgende denne verification query:

```sql
-- Forventet: 4 rækker
SELECT column_name
FROM information_schema.columns
WHERE table_name  = 'knowledge_processing_jobs'
  AND column_name IN (
    'input_tokens_actual',
    'output_tokens_actual',
    'provider_call_count',
    'fallback_count'
  )
ORDER BY column_name;
```

Forventet output:
```
 column_name
-------------------
 fallback_count
 input_tokens_actual
 output_tokens_actual
 provider_call_count
(4 rows)
```

---

## Trin 3 — Verificer indexes

```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'kpj_tenant_version_status_idx',
  'kc_tenant_version_active_count_idx',
  'kc_replaced_by_job_idx',
  'kc_version_chunk_key_active_unique',
  'kc_version_chunk_index_active_unique'
)
ORDER BY indexname;
```

Forventet output: 5 rækker (én per index).

---

## Trin 4 — Verificer supersession columns på knowledge_chunks

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name  = 'knowledge_chunks'
  AND column_name IN ('replaced_at', 'replaced_by_job_id')
ORDER BY column_name;
```

Forventet output: 2 rækker.

---

## Hvad migrationen gør

| # | Handling | Tabel |
|---|----------|-------|
| 1 | Tilføj `replaced_at`, `replaced_by_job_id` | `knowledge_chunks` |
| 2 | Index på `(tenant_id, knowledge_document_version_id, status)` | `knowledge_processing_jobs` |
| 3 | Partial index til aktiv-chunk COUNT queries | `knowledge_chunks` |
| 4 | Index til supersession-opslag | `knowledge_chunks` |
| 5 | Tilføj cost-rollup felter: `input_tokens_actual`, `output_tokens_actual`, `provider_call_count`, `fallback_count`, `duration_ms` | `knowledge_processing_jobs` |
| 6 | CHECK constraints på non-negative felter | `knowledge_processing_jobs` |
| 7 | Unique partial indexes til chunk-deduplication | `knowledge_chunks` |

---

## Sikkerhed ved gentagen kørsel

Alle DDL-operationer er idempotente:
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — no-op hvis kolonnen eksisterer
- `CREATE INDEX IF NOT EXISTS` — no-op hvis index eksisterer
- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` — sikker genoprettelse
- `CREATE UNIQUE INDEX IF NOT EXISTS` — no-op hvis index eksisterer

Data-backfill (`UPDATE ... SET duration_ms ...`) er også idempotent da den kun opdaterer rækker hvor `duration_ms IS NULL`.
