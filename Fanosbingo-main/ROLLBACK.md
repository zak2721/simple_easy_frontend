# YEGNA BINGO — Rollback Procedure

## Application Rollback (Docker)

### Tag images before deploying
```bash
docker tag yegna-bingo-backend:latest yegna-bingo-backend:stable
docker tag yegna-bingo-frontend:latest yegna-bingo-frontend:stable
```

### Roll back to previous image
```bash
# Edit docker-compose.prod.yml to pin previous image tag, or:
docker compose -f docker-compose.prod.yml stop backend frontend
docker tag yegna-bingo-backend:stable yegna-bingo-backend:latest
docker tag yegna-bingo-frontend:stable yegna-bingo-frontend:latest
docker compose -f docker-compose.prod.yml start backend frontend
```

## Database Migration Rollback

Prisma does not support automatic down migrations.

### Steps:
1. Take a backup BEFORE every migration
2. If a migration causes issues, restore the pre-migration backup
3. Fix the migration file
4. Re-deploy

### Emergency restore:
```bash
# Stop app
docker compose -f docker-compose.prod.yml stop backend
# Restore backup
gunzip -c /opt/backups/pre_migration_backup.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres yena_bingo
# Start app with previous image
docker compose -f docker-compose.prod.yml start backend
```

## Full Revert to Last Known Good State
```bash
# 1. Stop all services
docker compose -f docker-compose.prod.yml down
# 2. Restore database
gunzip -c /opt/backups/last_known_good.sql.gz | psql -U postgres yena_bingo
# 3. Rebuild from last known good commit
git checkout <last-good-tag>
docker compose -f docker-compose.prod.yml up -d --build
```
