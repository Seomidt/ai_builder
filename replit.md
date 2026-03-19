# AI Builder Platform

## Overview
The AI Builder Platform is an internal control plane designed for AI-driven software generation. It focuses on providing a robust, scalable, and secure environment for developing and deploying AI-powered applications. Key capabilities include a comprehensive AI run pipeline, advanced billing and monetization features, knowledge base management for multimodal assets, and a strong emphasis on observability, security, and identity governance. The platform aims to streamline the development lifecycle of AI applications, from initial concept to deployment and monitoring, with features like automated billing, robust security measures, and AI-assisted operational insights.

## User Preferences

- **Sprog**: Kommuniker på dansk
- **iPhone-bruger**: Kan ikke paste tekst i Replit shell fra iPhone — giv altid korte, trin-for-trin shell-kommandoer der kan skrives manuelt, én ad gangen
- **GitHub**: Remote URL bruger `$GITHUB_PERSONAL_ACCESS_TOKEN` — repo: `github.com/Seomidt/ai_builder`

## System Architecture

The platform follows a microservices-oriented approach, built with a React frontend and an Express.js backend. Core architectural decisions include:

**UI/UX Decisions:**
- **Frontend Framework:** React 19 with Wouter for routing.
- **Styling:** Shadcn UI and Tailwind CSS, utilizing a dark navy/teal theme.

**Technical Implementations & Design Choices:**
- **Database Strategy:** Supabase Postgres (PostgreSQL 17.6) with Drizzle ORM and a connection pooler. Uses a "no hard delete" policy, opting for a `status` field instead.
- **Authentication:** Supabase Auth with JWT middleware.
- **AI Integration:** Abstracted via an `AiProvider` interface, ensuring flexibility across different AI models. All AI calls are routed through a centralized `runAiCall()` function for consistent orchestration, cost tracking, and error handling.
- **Concurrency & Idempotency:** Implemented with request IDs for duplicate suppression and retry mechanisms.
- **Billing Engine:** Comprehensive system for AI usage billing, wallet/credit management, subscriptions, and invoicing. Features immutable ledgers, automated job operations, and recovery mechanisms.
- **Knowledge Base:** Centralized registry for multimodal assets (documents, images, audio, video) with versioning, processing pipelines (parsing, chunking, OCR, transcription, embedding), and a pgvector-backed semantic search engine. Includes retrieval orchestration with token budgeting, duplicate suppression, and provenance tracking.
- **Observability:** Fire-and-forget telemetry collection for AI latency, retrieval metrics, agent runtime, and tenant usage. Integrates with an AI Operations Assistant for health summarization and incident explanation.
- **Security:**
    - **Data Security:** Row Level Security (RLS) enabled across all tenant-owned tables with strict tenant-scoped policies.
    - **API Security:** Argon2id password hashing, TOTP MFA, session management, rate-limiting, and comprehensive security event logging.
    - **Output Safety:** HTML sanitization on both server and client sides, coupled with a hardened Content Security Policy (CSP).
    - **Abuse Guard:** AI input caps, burst control, hourly budgets, and injection detection for AI services.
    - **Edge Security:** Cloudflare integration for WAF, rate limiting, caching, SSL, and DNS verification.
- **Identity & Access Management:** Robust RBAC system with tenant-scoped roles, permissions, service accounts, and API keys.

## External Dependencies

- **Database:** Supabase Postgres (PostgreSQL 17.6)
- **Authentication:** Supabase Auth
- **AI Providers:** OpenAI (Responses API, GPT-4o, Whisper API)
- **Version Control:** GitHub (via `GITHUB_PERSONAL_ACCESS_TOKEN`)
- **Payment Processing:** Stripe
- **Multimedia Processing:** `ffprobe` (v6.1.2) for video metadata, `ffmpeg` (v6.1.2) for video frame sampling
- **Cloudflare:** For edge security and performance.