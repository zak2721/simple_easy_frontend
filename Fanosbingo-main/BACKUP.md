# YEGNA BINGO — Backup Procedure

## Automated PostgreSQL Backup

### Manual backup command
```bash
docker compose -f docker-compose.prod.yml exec postgres pg_dump \
  -U postgres yena_bingo | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Restore from backup
```bash
gunzip -c backup_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres yena_bingo
```

### Automated daily backup (add to crontab)
```bash
# Run: crontab -e
0 2 * * * cd /opt/yegna-bingo && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U postgres yena_bingo | gzip > /opt/backups/yegna_bingo_$(date +\%Y\%m\%d).sql.gz && find /opt/backups -name "*.sql.gz" -mtime +30 -delete
```

### Off-server backup
Copy backup files to a separate location:
```bash
rsync -az /opt/backups/ user@backup-server:/backups/yegna-bingo/
```

## Retention Policy
- Keep daily backups for 30 days
- Keep weekly backups for 6 months
- Store at least one copy off-server

## Backup Verification
```bash
# Test restore to a temp database
gunzip -c backup_file.sql.gz | psql -U postgres yegna_bingo_test
```
