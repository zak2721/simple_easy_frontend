#!/bin/sh
# Yena Bingo — production backup.
#
# Backs up everything that would otherwise be unrecoverable if this host was
# lost: the Postgres database (every wallet balance, every ledger entry,
# every deposit/withdrawal — the actual money), the uploaded deposit/
# withdrawal receipt files, the application environment configuration, and
# the Caddy TLS state (so a restore doesn't have to re-issue a fresh Let's
# Encrypt certificate from scratch).
#
# Usage (from the repo root, on the production host):
#   ./scripts/backup.sh
#
# Intended to run via cron/systemd timer — see backup.cron below. Writes
# one timestamped, gzip-compressed archive per run to BACKUP_DIR and deletes
# local copies older than RETENTION_DAYS. Does NOT upload anywhere by
# itself — see the "Off-host copy" section in docs/BACKUP_AND_RESTORE.md for
# why that step is mandatory, not optional, and how to wire it in.

set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

echo "[backup] $TIMESTAMP — starting"

# --- 1. Database (the part that actually matters) ---------------------------
# pg_dump's custom format (-Fc) is used, not plain SQL: it's compressed
# already, restores selectively with pg_restore, and — critically — is
# consistent as of a single transaction snapshot even while the app keeps
# writing (deposits/withdrawals/games don't need to pause for this).
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-yena_bingo}" -Fc \
  > "$WORKDIR/database.dump"
echo "[backup] database dumped ($(du -h "$WORKDIR/database.dump" | cut -f1))"

# --- 2. Application configuration -------------------------------------------
# The .env files are what an attacker would need least to see and what a
# restore needs most — captured here, encrypted at rest by the tar+gpg step
# below, never left as a bare file in the archive.
mkdir -p "$WORKDIR/config"
[ -f backend/.env ] && cp backend/.env "$WORKDIR/config/backend.env"
[ -f .env ] && cp .env "$WORKDIR/config/frontend.env"
cp "$COMPOSE_FILE" "$WORKDIR/config/" 2>/dev/null || true
cp Caddyfile "$WORKDIR/config/" 2>/dev/null || true

# --- 3. Uploaded receipt/proof files -----------------------------------
# Deposit screenshots and withdrawal payment proofs live on the backend's
# `receipts_data` volume, not in Postgres — without this, a restore would
# have every deposit/withdrawal record but none of the evidence an admin
# actually reviewed when approving them.
docker run --rm \
  -v "$(basename "$(pwd)")_receipts_data:/data:ro" \
  -v "$WORKDIR:/backup" \
  alpine:3 sh -c "cd /data && tar czf /backup/receipts.tar.gz ." 2>/dev/null \
  && echo "[backup] receipt files captured" \
  || echo "[backup] receipts_data volume not found — skipping (not fatal)"

# --- 4. Caddy TLS state (certificates + ACME account) -----------------------
# Skipped gracefully if Caddy isn't running under this compose file (e.g. a
# local/staging run of docker-compose.yml, which has no caddy service) —
# restoring this just avoids one extra Let's Encrypt issuance on recovery,
# it's not itself money-critical.
if docker compose -f "$COMPOSE_FILE" ps caddy >/dev/null 2>&1; then
  docker run --rm \
    -v "$(basename "$(pwd)")_caddy_data:/data:ro" \
    -v "$WORKDIR:/backup" \
    alpine:3 sh -c "cd /data && tar czf /backup/caddy_data.tar.gz ." 2>/dev/null \
    && echo "[backup] caddy TLS state captured" \
    || echo "[backup] caddy_data volume not found — skipping (not fatal)"
fi

# --- Package + encrypt --------------------------------------------------
ARCHIVE="$BACKUP_DIR/yena-bingo-backup-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORKDIR" .

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always -r "$BACKUP_GPG_RECIPIENT" -e "$ARCHIVE"
  rm -f "$ARCHIVE"
  ARCHIVE="$ARCHIVE.gpg"
  echo "[backup] encrypted for $BACKUP_GPG_RECIPIENT"
else
  echo "[backup] WARNING: BACKUP_GPG_RECIPIENT not set — archive is unencrypted and contains real secrets (.env, DB contents). Set it before running this in production."
fi

echo "[backup] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# --- Retention ---------------------------------------------------------
find "$BACKUP_DIR" -name 'yena-bingo-backup-*.tar.gz*' -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] $TIMESTAMP — done"
