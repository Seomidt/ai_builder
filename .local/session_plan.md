# Objective
Image + Audio lifecycle parity with document pipeline

# Tasks

### T001: Image lifecycle — frontend asset creation + R2 (fire-and-forget)
- AttachedFile type: "image" allerede korrekt
- Start createChatAssetForFile() for imgFiles i parallel med vision processing
- Fire-and-forget R2 upload af original bil efter vision loop
- Patch r2Key + track assetRefs på user message
- Ingen ændring til vision/base64 flow (UX bevaret)
- Files: client/src/pages/ai-chat.tsx

### T002: Audio lifecycle — filtype + pipeline
- Tilføj "audio" til AttachedFile["type"]
- ACCEPT_AUDIO konstant + opdater ACCEPT_ALL
- fileType() genkender audio/* → "audio"
- docFiles filter inkluderer audio (→ SLOW path → R2 → Gemini transcript)
- Server: upload/url + processDirectAttachment håndterer allerede audio
- Files: client/src/pages/ai-chat.tsx
