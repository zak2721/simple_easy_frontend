#!/bin/sh
# Yena Bingo — restore from a backup produced by backup.sh.
#
# DESTRUCTIVE: this replaces the target database's contents. It refuses to
# run without an explicit --yes, and always prints what it's about to do
# first. Run this against a fresh/throwaway environment first if you've
# never run it before — see docs/BACKUP_AND_RESTORE.md's drill procedure.
#
# Usage:
#   ./scripts/restore.sh path/to/yena-bingo-backup-<timestamp>.tar.gz[.gpg] --yes

set -eu

ARCHIVE="${1:?Usage: restore.sh <archive.tar.gz[.gpg]> --yes}"
CONFIRM="${2:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

if [ ! -f "$ARCHIVE" ]; then
  echo "No such archive: $ARCHIVE" >&2
  exit 1
fi

echo "About to restore from: $ARCHIVE"
echo "Target: the '${POSTGRES_DB:-yena_bingo}' database as reachable via '$COMPOSE_FILE'"
echo "This OVERWRITES the current database contents. There is no undo."
if [ "$CONFIRM" != "--yes" ]; then
  echo "Refusing to continue without --yes as the second argument." >&2
  exit 1
fi

case "$ARCHIVE" in
  *.gpg)
    echo "[restore] decrypting…"
    gpg --batch --yes -o "$WORKDIR/archive.tar.gz" -d "$ARCHIVE"
    tar -xzf "$WORKDIR/archive.tar.gz" -C "$WORKDIR"
    ;;
  *)
    tar -xzf "$ARCHIVE" -C "$WORKDIR"
    ;;
esac

if [ ! -f "$WORKDIR/database.dump" ]; then
  echo "[restore] database.dump not found in archive — is this a backup.sh archive?" >&2
  exit 1
fi

echo "[restore] restoring database (this drops and recreates the target's objects)…"
# --clean --if-exists: safe to run against a DB that already has the schema
# (a fresh restore target) or one that's being rolled back to this backup.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-yena_bingo}" \
  --clean --if-exists --no-owner \
  < "$WORKDIR/database.dump"
echo "[restore] database restored"

if [ -f "$WORKDIR/receipts.tar.gz" ]; then
  docker run --rm \
    -v "$(basename "$(pwd)")_receipts_data:/data" \
    -v "$WORKDIR:/backup" \
    alpine:3 sh -c "cd /data && tar xzf /backup/receipts.tar.gz"
  echo "[restore] receipt files restored"
fi

if [ -d "$WORKDIR/config" ]; then
  echo "[restore] config files found in archive at: $WORKDIR/config"
  echo "[restore] NOT auto-applied — review them and copy in manually:"
  ls -la "$WORKDIR/config"
fi

if [ -f "$WORKDIR/caddy_data.tar.gz" ]; then
  echo "[restore] Caddy TLS state found — restore it manually if you want to avoid a"
  echo "          fresh Let's Encrypt issuance:"
  echo "            docker run --rm -v \$(basename \$(pwd))_caddy_data:/data -v $WORKDIR:/backup alpine:3 sh -c 'cd /data && tar xzf /backup/caddy_data.tar.gz'"
fi

echo "[restore] done — verify with: docker compose -f $COMPOSE_FILE exec postgres psql -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-yena_bingo} -c 'SELECT count(*) FROM telegram_users;'"
