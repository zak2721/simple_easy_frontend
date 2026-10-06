#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Activating app_runtime role (RLS enforcement) if APP_RUNTIME_PASSWORD is set..."
npx tsx prisma/ensure-app-runtime-password.ts

echo "Seeding roles/permissions/default settings (idempotent upserts)..."
npx tsx prisma/seed.ts

echo "Starting yena-bingo backend..."
exec node dist/main.js
