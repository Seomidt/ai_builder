# Objective
Tenant admin retention settings: days_30 / days_90 / forever

# Tasks

### T001: Schema + migration
- shared/schema.ts: ændre defaultRetentionMode til days_30|days_90|forever
- script/migrate-retention-settings.ts: ny migration
- Status: PENDING

### T002: Backend service (chat-assets.ts)
- TenantRetentionMode type
- getTenantRetentionSettings() + upsertTenantRetentionSettings()
- resolveRetentionFromTenantMode() helper
- Status: PENDING

### T003: Backend routes (routes.ts)
- GET/PATCH /api/knowledge/settings/retention
- createChatAsset route: arv tenant default
- promoteAssetToStorage route: arv tenant default
- Status: PENDING

### T004: Frontend UI (tenant/settings.tsx)
- Opbevaringsperiode card: 30 dage / 90 dage / Slet aldrig
- Status: PENDING
