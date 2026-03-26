# KODEAUDIT — AI/Expert/Retrieval Stack

**DATO:** 25. marts 2026  
**FORMÅL:** Identificer eksisterende implementeringer og undgå duplicate work  
**INSTRUKTION:** Ingen kodeændringer — kun inspektioner

---

## 1. EXPERT SYSTEM

### ✅ FULDT IMPLEMENTERET

| Komponent | Lokation | Noter |
|-----------|----------|-------|
| **Expert Data Model** | `shared/schema.ts` | `architectureProfiles` tabel med status enum (draft/active/paused/archived) |
| **Expert Versionering** | `shared/schema.ts` | `expertVersions` tabel med draft/live/archived status; `draftVersionId` & `currentVersionId` FK felter |
| **Expert Config** | `shared/schema.ts` | Regler (`specialistRules`), kilder (`specialistSources`), sprog, instruktioner, mål, output stil |
| **Status Livscyklus** | `archProfileStatusEnum` | draft → active → paused → archived |
| **Version Promovering** | `server/routes.ts:713` | POST `/api/experts/:id/promote` (draft → live) |
| **Pause/Resume** | `server/routes.ts:617,634` | POST endpoints til pause/resume af experts |
| **Arkivering/Gjenåbning** | `server/routes.ts:592,600` | POST endpoints til arkivering/gjenåbning |
| **Expert Editor** | `client/src/pages/ai-ekspert-editor.tsx` | Fuld UI med formfelter (allerede i codebase) |
| **AI Field Assist** | `server/routes.ts:680` | POST `/api/experts/ai-refine` — per-felt AI refinement (kalder runAiCall med `route_key: "expert.refine"`) |

### ⚠️ DELVIS IMPLEMENTERET

| Komponent | Lokation | Huller |
|-----------|----------|--------|
| **Expert Execution** | `server/services/chat-runner.ts` | Genbruger expert config men logik til at bygge runtime prompts fra versioner er i `server/lib/ai/expert-prompt-builder.ts` — bygger system prompt men **prompts er hardkodet, ikke lagret** |
| **Draft vs Live Logik** | `server/repositories/` | Schema understøtter det; uklart om API endpoints korrekt filtrerer draft vs. live ved læsning |

### ❌ IKKE FULDT INTEGRERET

- Expert versionering UI (kan bruger se draft vs. live versioner i admin?)
- Automatiserede promotion workflows (kun manuel POST)
- Rollback fra live → draft

---

## 2. AI RUNTIME

### ✅ FULDT IMPLEMENTERET

| Komponent | Lokation | Fuldstændighed |
|-----------|----------|-----------------|
| **Central Entry Point** | `server/lib/ai/runner.ts` | `runAiCall()` — fuld livscyklus (route opløsning, idempotency, guards, cache, usage logging, error handling) |
| **Route Key Support** | `server/lib/ai/config.ts` | Semantiske keys: `expert.chat`, `expert.suggest`, `expert.refine`, `summarize.fast`, `ops.analysis`, `extraction.struct` |
| **Route Key Logging** | `server/lib/ai/usage.ts` | Logger `routeKey` til `ai_usage` tabel (påfølgende refaktor) |
| **Model Routing** | `server/lib/ai/router.ts` | Opløser route → provider + model; understøtter DB overrides per tenant |
| **Budget Guards** | `server/lib/ai/guards.ts` | Per-periode usage tracking, hard stop på budget overskredet |
| **Usage Logging** | `server/lib/ai/usage.ts` | Atomisk insert + periode aggregate upsert i transaktion |
| **Cost Estimation** | `server/lib/ai/pricing.ts` | Loader pricing fra DB eller code defaults; estimerer cost per call |
| **Idempotency** | `server/lib/ai/idempotency.ts` | `request_id` deduplication; duplicate_inflight (409) / duplicate_replay (cached) / owned (new) |
| **Rate Limiting** | `server/lib/ai/request-safety.ts` | RPM + RPH checks; concurrency slot management |
| **Response Cache** | `server/lib/ai/response-cache.ts` | Tenant-scoped cache lookup/write; cache hits bypasser provider call |
| **Provider Adapters** | `server/lib/ai/providers/` | OpenAI, Anthropic, Google adapters med token usage extraction |

---

## 3. RETRIEVAL / VECTOR

### ✅ FULDT IMPLEMENTERET

| Komponent | Lokation | Fuldstændighed |
|-----------|----------|-----------------|
| **Vector Search** | `server/lib/retrieval/retrieval-vector.ts` | `vectorSearch()` — pgvector queries med cosine similarity |
| **Lexical Search** | `server/lib/retrieval/retrieval-lexical.ts` | `lexicalSearch()` — full-text search + fallback BM25 |
| **Hybrid Ranking** | `server/lib/retrieval/retrieval-ranker.ts` | `rankResults()` — kombinerer vector + lexical scores; deterministisk ranking |
| **Query Embedding** | `server/lib/retrieval/retrieval-query.ts` | `embedQuery()` — skaber vector embedding af bruger query |
| **Query Validation** | `server/lib/retrieval/retrieval-query.ts` | Token count check, SQL injection prevention, XSS filtering |
| **Rate Limiting** | `server/lib/retrieval/retrieval-orchestrator.ts` | Per-tenant token bucket (30 q/min) |
| **Retrieval Pipeline** | `server/lib/retrieval/retrieval-orchestrator.ts` | `runRetrieval()` — fuld orchestration: validate → embed → vector search → lexical search → rank → store → metrics |
| **Timeout Protection** | `server/lib/retrieval/retrieval-orchestrator.ts` | Konfigurerbar timeout per stage |
| **Tenant Filtering** | `server/lib/retrieval/retrieval-vector.ts` | WHERE tenant_id = $1 håndhævet på DB lag |
| **Active Document Filtering** | `server/lib/retrieval/retrieval-vector.ts` | Queries kun `status = 'current'` dokumenter |
| **Results Storage** | `server/lib/retrieval/retrieval-orchestrator.ts` | Gemmer ranked results i `retrieval_results` tabel med scores |
| **Metrics Recording** | `server/lib/retrieval/retrieval-metrics.ts` | Recorder retrieval latency, hit counts, rankings |

### ⚠️ DELVIS IMPLEMENTERET

| Komponent | Lokation | Huller |
|-----------|----------|--------|
| **Expert-Specific Retrieval** | `server/services/chat-runner.ts:240` | chat-runner kalder `runRetrieval()` men **filtrerer IKKE chunks efter expert-specifikke knowledge sources**; henter all tenant knowledge indiskriminatly |

---

## 4. KNOWLEDGE / STORAGE LAYER

### ✅ FULDT IMPLEMENTERET

| Komponent | Lokation | Noter |
|-----------|----------|-------|
| **Knowledge Documents** | `shared/schema.ts` | `knowledgeDocuments` tabel med status, MIME type, extraction metadata |
| **Document Versions** | `shared/schema.ts` | `knowledgeDocumentVersions` tabel med version numbers og status (current/archived) |
| **Embeddings Storage** | `shared/schema.ts` | `knowledgeEmbeddings` tabel (provider, model, vector, status) |
| **Chunks** | `shared/schema.ts` | `knowledgeChunks` tabel med text, token count, source line mapping |
| **Processing Jobs** | `shared/schema.ts` | `knowledgeProcessingJobs` tabel tracking upload/parse/chunk/embed/index lifecycle |
| **Vector Namespace** | `shared/schema.ts` | Multi-backend support (pgvector, pinecone, weaviate, qdrant, custom) |
| **Document Linking** | `shared/schema.ts` | `knowledgeDocumentId` + `knowledgeDocumentVersionId` foreign keys i chunks |
| **Current/Active Logik** | `shared/schema.ts` | `isCurrentVersion` boolean flag; queries filtrerer på denne |
| **Repository Layer** | `server/repositories/knowledge.repository.ts` | CRUD for dokumenter, versioner, status updates |
| **Chunking Logic** | `server/lib/knowledge/knowledge-chunking.ts` | Text splitting med token-aware boundaries |
| **Embedding Generation** | `server/lib/knowledge/knowledge-embeddings.ts` | Kalder embedding provider (OpenAI) og gemmer vectors |
| **Indexing Pipeline** | `server/lib/knowledge/knowledge-indexing.ts` | Livscyklus: pending → embedding → indexed → vector stored |

### ⚠️ DELVIS IMPLEMENTERET

| Komponent | Lokation | Huller |
|-----------|----------|--------|
| **Version Promotion** | `shared/schema.ts` | Schema har `isCurrentVersion` men uklart om UI/API understøtter promotion af dokumentversioner |
| **Lifecycle Sync** | `server/lib/knowledge/knowledge-indexing.ts` | Job pipeline eksisterer men state transitions kan ikke fuldt observeres |

---

## 5. CHAT INTEGRATION

### ✅ FULDT IMPLEMENTERET

| Komponent | Lokation | Hvordan Det Virker |
|-----------|----------|-------------------|
| **Chat Routing** | `server/services/chat-routing.ts` | Læser tilgængelige experts fra DB; filtrerer efter `enabledForChat=true`, `status != archived` |
| **Expert Selection** | `server/services/chat-routing.ts` | Semantisk similarity matching på `routingHints`, `category`, `name` til at vælge expert |
| **Chat Message Persistence** | `shared/schema.ts` | `chatConversations` + `chatMessages` tabeller |
| **Document Context Injection** | `server/services/chat-runner.ts:64-76` | Validerer extracted documents; filtrerer efter status='ok' |
| **Expert Prompt Building** | `server/lib/ai/expert-prompt-builder.ts` | `buildExpertPrompt()` / `buildExpertPromptFromSnapshot()` assembler system prompt fra rules/sources |
| **Retrieval Invocation** | `server/services/chat-runner.ts:240` | Kalder `runRetrieval()` for hybrid search på user message |
| **AI Call Integration** | `server/services/chat-runner.ts` | Kalder `runAiCall()` med assembled prompt + retrieved context |
| **Result Formatting** | `server/services/chat-runner.ts` | Returnerer `ChatRunResult` med answer, sources used, rules, confidence, latency |
| **Endpoint** | `server/routes.ts` | POST `/api/chat` → kalder `runChatMessage()` |

### ⚠️ KRITISKE HULLER

| Huller | Påvirkning | Lokation |
|--------|-----------|----------|
| **Ingen Expert-Specific Source Filtering** | Retrieval begrænser IKKE chunks til expert's configured sources; returnerer all tenant knowledge | `server/services/chat-runner.ts` |
| **Ingen Confidence Calculation** | Response markerer `confidenceBand: "unknown"` hardkodet; burde reflektere retrieval hit count / score distribution | `server/services/chat-runner.ts` |
| **Prompt Hardkodet** | Expert instruktioner er i system prompt men actual prompt template er ikke lagret i DB; kan ikke A/B teste uden code change | `server/lib/ai/expert-prompt-builder.ts` |
| **Ingen Source Attribution** | `usedSources` returned men uklart om det reflekterer actual chunks used eller bare all sources i expert config | `server/services/chat-runner.ts` |

---

## RISIKOANALYSE: Risks af Naive Implementation

### 🚨 DUPLICATE WORK RISKS

1. **Retrieval uden Expert Filtering**
   - **Problem:** Hvis du bygger expert-specific retrieval queries, vil du conflict med `runRetrieval()` som allerede eksisterer
   - **Løsning:** Pass `expertId` til `runRetrieval()` og tilføj source filtering indeni

2. **Prompt Building på To Steder**
   - **Problem:** `expert-prompt-builder.ts` eksisterer allerede; hvis du bygger ny prompt assembly i chat logic, vedligeholder du to divergerende codebases
   - **Løsning:** Genbruge `buildExpertPromptFromSnapshot()`

3. **Model Routing Conflict**
   - **Problem:** Både `router.ts` og `expert-prompt-builder.ts` opløser model selection; expert config har hardkodet `modelProvider/modelName`; `runAiCall()` bruger `route_key` fra config
   - **Løsning:** Sikr expert config gemmer route_key, ikke hardkodet model

4. **Version Logic Duplication**
   - **Problem:** `architectureVersions` eksisterer for experts; `knowledgeDocumentVersions` eksisterer for knowledge; men chat logic loader ikke eksplicit "current" versioner
   - **Løsning:** Tilføj eksplicit version selection i chat routing

---

## ANBEFALINGER: Næste Implementation Target

### Prioritet 1 — Fiks Expert-Aware Retrieval
**Fil:** `server/services/chat-runner.ts` linje 240

```typescript
// NUVÆRENDE:
runRetrieval({ ..., queryText: message, ... })
// PROBLEM: Returnerer ALL tenant chunks; burde filtrere efter expert's configured sources

// HANDLING:
// Pass expertId + expert.specialistSources til runRetrieval
// Tilføj filtering til kun at inkludere chunks fra expert's sources
// PÅVIRKNING: Enabler expert til at bruge kun relevant knowledge
```

### Prioritet 2 — Tilføj Confidence Scoring
**Fil:** `server/services/chat-runner.ts` linje ~200

```typescript
// NUVÆRENDE:
confidenceBand: "unknown" // (hardkodet)

// HANDLING:
// Beregn fra retrieval result scores & hit count
// - Score > 0.8: "high"
// - 0.5-0.8: "medium"
// - < 0.5: "low"
// - Ingen hits: "unknown"

// PÅVIRKNING: Viser bruger hvor sikker ekspert er på sit svar
```

### Prioritet 3 — Database-Stored Prompts
**Fil:** `shared/schema.ts` + `architectureVersions`

```typescript
// NUVÆRENDE:
// Expert prompt hardkodet i prompt-builder.ts

// HANDLING:
// Tilføj promptTemplate field til expertVersions
// - Versionerede prompt templates
// - A/B testing capability
// - Admin UI kan ændre uden code change

// PÅVIRKNING: Dekobler prompt fra code; enabler prompt versionering
```

### Prioritet 4 — Accurate Source Attribution
**Fil:** `server/services/chat-runner.ts` + retrieval pipeline

```typescript
// NUVÆRENDE:
// Returnerer expert.specialistSources (alle konfigureret)

// HANDLING:
// Returnerer actual chunks used i context window + hvilke sources de kom fra

// PÅVIRKNING: Viser bruger præcis hvilke dokumenter ekspert brugte
```

---

## OPSUMMERING

| Område | Status | Dybde | Kommentarer |
|--------|--------|-------|------------|
| **Expert System** | ✅ 90% | Fuldt modelleret | Versioning/draft-live i schema; mangler: versioning UI, rollback |
| **AI Runtime** | ✅ 100% | Komplet entry point | Route keys integreret; usage logging; all guards & caching |
| **Retrieval/Vector** | ✅ 95% | Fuld pipeline | Mangler: expert-specific filtering ved retrieval layer |
| **Knowledge/Storage** | ✅ 90% | Alle tabeller eksisterer | Chunking/embedding/indexing implementeret; mangler: version promotion UI |
| **Chat Integration** | ⚠️ 70% | Rørledning eksisterer | Mangler: expert-aware filtering, confidence scoring, source attribution |

---

## KONKLUSION

**✅ Ingen kode-ændringer nødvendige — audit afsluttet**

Codebasen har allerede substanstielt arbejde på alle 5 områder. De kritiske huller er:
1. Expert-specific retrieval filtering
2. Confidence scoring baseret på retrieval resultater
3. Prompt templates gemmes i DB
4. Nøjagtig source attribution

Alle kan implementeres uden at duplikere eksisterende logic ved at genbruge `runRetrieval()`, `buildExpertPromptFromSnapshot()`, og `runAiCall()`-infrastrukturen.
