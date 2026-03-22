#!/bin/bash
set -e

echo "[post-merge] Starting post-merge setup..."

echo "[post-merge] Syncing database schema (timeout 90s)..."
timeout 90 npm run db:push 2>&1 || echo "[post-merge] db:push skipped or had no pending changes"

echo "[post-merge] Complete."
