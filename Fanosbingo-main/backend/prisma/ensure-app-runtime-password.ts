// Runs once per deploy, after migrations and before the app starts (see
// docker-entrypoint.sh). The RLS migration creates the `app_runtime` role
// with no password on purpose (so it's inert until an environment
// deliberately activates it — see
// backend/prisma/migrations/20260926090000_row_level_security). This script
// is that activation step for Docker deploys: it sets/rotates the role's
// password from APP_RUNTIME_PASSWORD, connecting as the superuser
// (MIGRATE_DATABASE_URL) since only a superuser/owner can ALTER another
// role. Skipped with a warning if APP_RUNTIME_PASSWORD isn't set, so
// environments that haven't opted into RLS enforcement yet keep working.
import { PrismaClient } from '@prisma/client';

async function main() {
  const password = process.env.APP_RUNTIME_PASSWORD;
  if (!password) {
    console.log(
      'APP_RUNTIME_PASSWORD not set — skipping app_runtime password rotation (RLS role stays inert).',
    );
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.MIGRATE_DATABASE_URL } },
  });

  try {
    // Prisma refuses to parameterize ALTER via $executeRaw (it's DDL, not a
    // value expression it will bind). $executeRawUnsafe is safe here only
    // because `password` is our own generated secret (env var), never
    // user input — standard SQL string-literal escaping (doubling quotes)
    // is sufficient.
    const escaped = password.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`ALTER ROLE app_runtime WITH PASSWORD '${escaped}'`);
    console.log('app_runtime password set.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to set app_runtime password:', err);
  process.exit(1);
});
