# YEGNA BINGO — Disaster Recovery

## VPS Crash / Restart
Docker containers restart automatically (restart: unless-stopped).
If VPS reboots:
```bash
docker compose -f docker-compose.prod.yml up -d
```

## Application Crash
PM2 / Docker restart policy handles this automatically.
Check logs:
```bash
docker compose -f docker-compose.prod.yml logs backend --tail=100
```

## Database Corruption
1. Stop the application: `docker compose -f docker-compose.prod.yml stop backend`
2. Restore from backup (see BACKUP.md)
3. Run migrations: `docker compose -f docker-compose.prod.yml exec backend npx prisma migrate deploy`
4. Restart: `docker compose -f docker-compose.prod.yml start backend`

## Bad Migration Deployed
1. Restore database from backup taken immediately before migration
2. Roll back to previous Docker image tag
3. See ROLLBACK.md

## Telegram Webhook Stopped Working
```bash
# Re-register webhook
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_DOMAIN/webhook/YOUR_SECRET/your-operator-slug" \
  -d "secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET"
# Verify
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"
```

## Disk Full
```bash
# Check disk usage
df -h
docker system prune -f   # remove stopped containers/unused images
# Rotate old backups
find /opt/backups -name "*.sql.gz" -mtime +7 -delete
```
