# Offsite Backup (restic → Cloudflare R2)

Third-tier backup. Local `scripts/backup.sh` at 02:00 produces
`/srv/backups/<date>/`; `scripts/offsite-backup.sh` at 03:00 ships that plus
VM-local `.env` files to an R2 bucket via restic. Client-side AES-256 +
dedup + retention. Strategy rationale: `memory/project_backup_strategy.md`.

## Cloudflare R2 (dashboard, one-time)

1. **Enable R2** (dash.cloudflare.com → R2 Object Storage → Purchase; free tier is 10 GB + no egress fees, but adding a payment method is required).
2. **Create bucket** `khe-homelab-backup`, jurisdiction **European Union**. The jurisdiction changes the endpoint: EU buckets need `<account-id>.eu.r2.cloudflarestorage.com` (auto-jurisdiction buckets drop the `.eu.` segment). Restic's native S3 handling works with either — AWS CLI v2 does not reliably sign against the EU endpoint, hence restic as the tool.
3. **Create Account API token** (R2 → Account details → API Tokens → Manage → Create Account API token):
   - Permission: **Object Read & Write**
   - Applied to: `khe-homelab-backup`
   - TTL: Forever (or long-lived)
   - Copy Access Key ID + Secret — secret is shown once.
4. Account ID (32-hex) is visible on the R2 overview page.

## VM setup (one-time)

```bash
sudo apt-get install -y restic

# Quoted heredoc so $VARS are written literally, not expanded.
cat > ~/homelab/.env.offsite <<'EOF'
RESTIC_REPOSITORY=s3:https://TODO-account-id.eu.r2.cloudflarestorage.com/khe-homelab-backup
RESTIC_PASSWORD=TODO-generate-via-openssl-rand-base64-32
AWS_ACCESS_KEY_ID=TODO-from-r2-token
AWS_SECRET_ACCESS_KEY=TODO-from-r2-token
AWS_DEFAULT_REGION=auto
EOF
chmod 600 ~/homelab/.env.offsite
# Now edit the file and replace every TODO- marker with the real value.
$EDITOR ~/homelab/.env.offsite

# Save RESTIC_PASSWORD to Vaultwarden NOW. If this is lost AND .env.offsite
# is lost, all snapshots are unrecoverable — the password derives the repo's
# master key. The repo bytes alone are not enough, and the password alone
# is not enough (two-factor by design).

# Initialise the repo (one-time; script refuses to auto-init).
set -a; source ~/homelab/.env.offsite; set +a
restic init
```

## Schedule

```cron
0 2 * * *  cd /home/khe/homelab && ./scripts/backup.sh        >> /srv/backups/backup.log        2>&1
0 3 * * *  cd /home/khe/homelab && ./scripts/offsite-backup.sh >> /srv/backups/offsite-backup.log 2>&1
```

Retention policy (enforced each run via `restic forget --prune`):
`--keep-daily 7 --keep-weekly 4 --keep-monthly 12`. Each retained snapshot
is a point-in-time capture — the monthly one keeps a single `/srv/backups/<date>/`
payload, not a rolling month. Longest cold-recovery window is ~12 months,
granular only at the daily tier.

## Restore

```bash
set -a; source ~/homelab/.env.offsite; set +a

restic snapshots                                # list
restic restore <snapshot-id> --target /tmp/r    # full restore
# --include matches the absolute path as stored in the snapshot
restic restore <snapshot-id> --target /tmp/r \
       --include "/srv/backups/2026-04-18/nextcloud-db.dump"
```

DB recovery example:

```bash
docker exec -i nextcloud-db pg_restore -U nextcloud -d nextcloud --clean \
       < /tmp/r/srv/backups/2026-04-18/nextcloud-db.dump
```

## Integrity

Daily `restic check` (metadata only) runs at the end of `offsite-backup.sh`.
Full data verification is not scheduled today — add a monthly
`restic check --read-data` cron once the repo grows enough to make daily
`--read-data-subset=1%` meaningful. R2 has no egress fees, so reads are
free; the cost is time.
