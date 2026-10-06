# Backup and restore

What's backed up, how often, for how long, and — the part most backup
strategies skip — exactly how to prove it actually works before you need it.

## What's backed up

| What | Why | Script |
|---|---|---|
| PostgreSQL database | Every wallet balance, ledger entry, deposit, withdrawal, admin account. The only unrecoverable *financial* data in this system. | `pg_dump -Fc` (custom format: compressed, consistent snapshot, selectively restorable) |
| `receipts_data` volume | Uploaded deposit screenshots and withdrawal payment proofs. The database rows reference these by path — without this volume, a restore has every deposit/withdrawal record but none of the evidence an admin actually reviewed when approving them. | `tar` of the Docker volume |
| `backend/.env`, `.env` | Secrets and config that would otherwise need to be reconstructed from memory during an incident. | plain copy into the archive |
| `docker-compose.prod.yml`, `Caddyfile` | So a restore isn't also a "re-figure-out-the-deployment" exercise. | plain copy into the archive |
| Caddy's `caddy_data` volume | The Let's Encrypt certificate + ACME account key. Not money-critical — skipping it just costs one extra certificate issuance on restore — but cheap to include. | `tar` of the Docker volume |

## Automated schedule

`scripts/backup.cron` installs a daily 03:15 run via cron. Each run produces
one timestamped, gzip-compressed archive in `BACKUP_DIR` (default `./backups`)
and — if `BACKUP_GPG_RECIPIENT` is set — encrypts it with that recipient's
GPG public key before anything touches disk in cleartext for longer than the
run itself.

**Set `BACKUP_GPG_RECIPIENT`.** Without it, `backup.sh` still runs (so a
missing key doesn't silently stop your backups) but prints a loud warning,
because the archive contains real secrets and real user financial data in
cleartext otherwise.

## Retention policy

- **Local**: 14 days, enforced automatically by `backup.sh` deleting
  anything older on each run (`RETENTION_DAYS`, overridable).
- **Off-host**: copy every archive somewhere that isn't this server, on a
  longer retention (recommended: 30 daily + 12 monthly). A backup that
  lives only on the machine it protects against doesn't protect against
  that machine's disk failing, being compromised, or the hosting account
  being lost — which is precisely the scenario a backup exists for.
  `backup.sh` deliberately does not pick a destination for you (S3,
  Backblaze B2, another host via `rsync`/`restic`, etc. are all reasonable
  — the constraint list is: encrypted, off-host, and something you've
  actually tested a restore from). Add the sync command as the last line of
  the cron job once you've chosen one.

## Restore procedure

```bash
./scripts/restore.sh backups/yena-bingo-backup-<timestamp>.tar.gz.gpg --yes
```

This is destructive by design (`pg_restore --clean`) and refuses to run
without `--yes`. It prints exactly what it's about to overwrite before
touching anything.

## The restore drill (do this now, not during an incident)

A backup you have never restored is a backup you don't actually have — you
have a file whose contents you're assuming are correct and complete. Before
this goes live, and then quarterly after that:

1. Spin up a throwaway Postgres (a second `docker compose` project, or a
   scratch database on the same instance — anything that isn't production).
2. Run `backup.sh` against production, then `restore.sh` against the
   throwaway target.
3. Compare row counts and a few known values (e.g. a specific player's
   wallet balance) between source and restored copy.
4. Time the whole thing. That duration is your actual recovery-time
   estimate, not a guess — write it down somewhere the on-call person will
   find it during a real incident.

This exact drill — dump the live dev database, restore it into a fresh
throwaway database, and diff wallet balances row-for-row — was run once
already while writing these scripts, against real data, and produced an
exact match (9 users, 3 deposits, 2 withdrawals, identical balances to the
cent). That proves the *mechanism* is sound; it does not replace running the
drill yourself against your production data before you rely on it, since
the point of the drill is catching problems specific to your environment
(permissions, disk space, network access to the DB from wherever you
restore), not re-proving `pg_dump` works.
