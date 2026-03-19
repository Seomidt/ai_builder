# Phase 46 — Enterprise Storage Architecture

## Overview

Tenant file storage uses a **metadata-first** model where Supabase is the source of truth and Cloudflare R2 stores only the actual bytes.

```
Client → POST /api/storage/request-upload
              │
              ▼ (1) validate tenant + category + MIME + size
              │
              ▼ (2) create metadata row in tenant_files (status=pending)
              │
              ▼ (3) generate server-controlled object key
              │
              ▼ (4) return signed PUT URL (15 min expiry)
              │
Client → PUT R2 signed URL (direct browser upload)
              │
              ▼
Client → POST /api/storage/complete-upload
              │
              ▼ (5) mark upload_status=uploaded, record checksum
              │
              ▼ (6) if scan required → scan_status=pending_scan
              │
Download:
Client → GET /api/storage/download-url?fileId=...
              │
              ▼ (7) verify tenant ownership + scan status + policy
              │
              ▼ (8) return short-lived signed GET URL (never persisted)
```

---

## Metadata-First Model

The `tenant_files` table is the **source of truth** for all file state:

| Column | Purpose |
|--------|---------|
| `id` | Immutable server-generated UUID |
| `organization_id` | Tenant isolation key (NOT NULL) |
| `object_key` | R2 key (server-generated, UNIQUE) |
| `upload_status` | `pending → uploaded → deleted` |
| `scan_status` | `not_scanned / pending_scan / clean / rejected` |
| `deleted_at` | Soft-delete timestamp |
| `delete_scheduled_at` | When hard R2 delete is scheduled |

**Clients never interact with object keys directly.** Only metadata row IDs (`tenant_files.id`) are exposed to clients.

---

## Tenant-Scoped Key Structure

All keys are **server-generated** and include the tenant namespace:

```
org/{organization_id}/{category_path}/{server_uuid}.{ext}
```

Examples:
```
org/abc123/checkins/clients/cli456/f47ac10b-58cc-4372-a567-0e02b2c3d479.jpg
org/abc123/documents/clients/cli456/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf
org/abc123/program-assets/12345678-1234-1234-1234-123456789012.mp4
org/abc123/exports/2026/03/98765432-fedc-ba98-7654-321098765432.csv
platform/system/backups/2026/03/00000000-0000-0000-0000-000000000001.json
```

**System backup files** are stored under `platform/system/` — completely separate from tenant namespaces.

---

## Storage Categories

| Category | Max Size | MIME Types | Scan Required | Retention |
|----------|----------|------------|---------------|-----------|
| `checkin_photo` | 15 MB | jpg, png, webp, heic | ✔ | 3 years |
| `client_document` | 25 MB | pdf, doc, docx, txt, jpg, png | ✔ | 7 years |
| `program_asset` | 200 MB | jpg, png, svg, mp4, webm, pdf, txt | ✗ | indefinite |
| `export` | 100 MB | csv, json, xlsx, zip | ✗ | 30 days |
| `system_backup` | 5 GB | json, bin, gz, zip | ✗ | 90 days |
| `ai_import` | 50 MB | txt, csv, json, pdf, md | ✔ | 180 days |

---

## Signed URL Lifecycle

```
Request upload  ──→  PUT URL (900s) ──→  Client uploads to R2
                                              │
                                              ▼
Complete upload ──→  GET URL (900s) ──→  Client downloads
                     (per-request, never persisted)
```

- **PUT URLs**: 15-minute expiry, single-use intent
- **GET URLs**: 15-minute default, max 60 minutes, never stored in DB
- **Signed URLs are ephemeral** — not stored, not reused, not logged

---

## Scan Status State Machine

```
Upload requested
        │
        ▼
  [category requires scan?]
   YES ────→  pending_scan ──→ [engine callback] ──→ clean ✔ (downloadable)
                                                   └──→ rejected ✗ (blocked)
   NO  ────→  not_scanned (downloadable immediately for non-blocked categories)
```

Categories that block download until clean: `checkin_photo`, `client_document`, `ai_import`

---

## Delete Flow

```
DELETE /api/storage/file/:id
        │
        ▼ (1) Set deleted_at = now()
        │     upload_status = 'deleted'
        │     delete_scheduled_at = now() + 24h
        │
        ▼ (2) File hidden from all tenant queries immediately
        │
[Background job — runs periodically]
        │
        ▼ (3) Hard delete from R2 (object_key)
        │
        ▼ (4) Set metadata.r2_hard_deleted_at, clear delete_scheduled_at
        │
[DB row persisted permanently as audit record]
```

The DB row is **never deleted** — it serves as the permanent audit trail.

---

## Service Role Boundary

The `tenant_files` table has:
- **RLS enabled**: service_role only policy
- **No authenticated user policy**: tenant users never query `tenant_files` directly via Supabase client
- **Application layer enforces isolation**: organization_id checked on every DB query in the application

---

## Reconciliation

The reconcile job detects storage mismatches:

| Anomaly | Description | Action |
|---------|-------------|--------|
| Metadata without object | DB row exists, R2 object missing | Investigate — possible failed upload |
| Object without metadata | R2 object exists, no DB row | Orphan — review for cleanup |
| Deleted metadata with live object | Soft-deleted but R2 not yet cleaned | Overdue hard delete |
| Stale pending uploads | `upload_status=pending` > 1 hour | Failed upload — mark as failed |

Run via:
```
GET /api/admin/storage/reconcile          -- admin only
GET /api/admin/storage/reconcile?organizationId=xxx  -- org-scoped
```

---

## Backup / System File Policy

`system_backup` category:
- Allowed roles: `service_role` only
- Object key: `platform/system/backups/{yyyy}/{mm}/{uuid}.{ext}` (no org namespace)
- Not exposed via any tenant-facing API
- Max 5 GB per file, 90-day retention hint
- No malware scan required (server-generated files only)

---

## Endpoints Reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/storage/request-upload` | requireAuth | Step 1: create metadata + get signed PUT URL |
| POST | `/api/storage/complete-upload` | requireAuth | Step 2: confirm upload complete |
| GET | `/api/storage/download-url?fileId=X` | requireAuth | Issue signed GET URL |
| DELETE | `/api/storage/file/:id` | requireAuth | Soft-delete file |
| GET | `/api/admin/storage/reconcile` | admin only | Reconciliation report |

---

## Legacy Raw R2 Routes

The original `/api/r2/*` routes remain for **internal ops use only** (`/ops/storage` page). They are:
- Not tenant-scoped
- Not safe for production tenant file flows
- Restricted to admin/ops dashboard only

For all new tenant file operations, use `/api/storage/*` exclusively.
