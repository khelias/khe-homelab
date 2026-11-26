# Offsite Backup (restic → Cloudflare R2)

Third-tier backup. Local `scripts/backup.sh` at 02:00 produces
`/srv/backups/<date>/`; `scripts/offsite-backup.sh` at 03:00 ships that
day's directory only, plus VM-local `.env` files and the bedtime stories'
audio store `/srv/data/stories/audio` (outside git, so this is its only copy
off the VM; [estate ADR-031](https://github.com/khelias/khe-architecture/blob/main/decisions/031-stories-public-app-private-stories-audio-outside-git.md)) to an R2 bucket via restic. Client-side AES-256 +
dedup. The bucket is locked, so the VM can add but not delete
(see [Bucket lock](#bucket-lock)). Why three tiers: [architecture](../ARCHITECTURE.md#automation), Backups.

## Cloudflare R2 (dashboard, one-time)

1. **Enable R2** (dash.cloudflare.com → R2 Object Storage → Purchase; free tier is 10 GB + no egress fees, but adding a payment method is required).
2. **Create bucket** `khe-homelab-backup`, jurisdiction **European Union**. The jurisdiction changes the endpoint: EU buckets need `<account-id>.eu.r2.cloudflarestorage.com` (auto-jurisdiction buckets drop the `.eu.` segment). Restic's native S3 handling works with either — AWS CLI v2 does not reliably sign against the EU endpoint, hence restic as the tool.
3. **Create Account API token** (R2 → Account details → API Tokens → Manage → Create Account API token):
   - Permission: **Object Read & Write**
   - Applied to: `khe-homelab-backup`
   - TTL: Forever (or long-lived)
   - Copy Access Key ID + Secret — secret is shown once.
   R2 has no level that writes without deleting: see [Bucket lock](#bucket-lock).
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

The nightly run only adds a snapshot and checks the repo; it never forgets or
prunes, since the lock would refuse it. Snapshots pile up until the attended
prune below; a quarter between prunes costs well under $1 a month past R2's
free 10 GB.

## Bucket lock

R2 → `khe-homelab-backup` → Settings → Bucket lock rules. Every rule is
Indefinite:

| Rule | Prefix |
|------|--------|
| restic-data | `data/` |
| restic-index | `index/` |
| restic-snapshots | `snapshots/` |
| restic-keys | `keys/` |
| restic-config | `config` |

- `locks/` has no rule: restic deletes its own lock files on every `backup`
  and `check`.
- `forget`, `prune`, `key remove`, `migrate` and `repair` run only while
  the rules are off: restic only warns (`unable to remove`) when a delete is
  refused. Why no age rule:
  [service-choices](../docs/service-choices.md#offsite-backup---restic-to-cloudflare-r2-locked-bucket).
- The lock also refuses an overwrite, so an upload restic retries after a
  lost response fails that night's backup; the heartbeat goes down and the
  next run starts clean.
- Changing the rules needs R2 bucket-configuration rights (Admin, or Workers
  R2 Storage Write), which no credential on the VM may hold
  ([SECURITY.md](../SECURITY.md#automated-writers)).

`scripts/offsite-lock-check.sh` proves the lock from the VM's own token: for
one existing key under each prefix, a PUT with `If-None-Match: *` must answer
409 `ObjectLockedByBucketPolicy`. With a rule off it answers 412 and changes
nothing. After each successful backup `offsite-backup.sh` runs it with
`--sentinel`, which probes only `config-lock-probe` (covered by the `config`
rule, never read by restic), so a rule left off fails the run and turns the
heartbeat down without an unattended write aimed at restic's own files.

## Attended prune (quarterly)

The next date is in the estate roadmap in `khe-meta`. Not between 02:00 and
04:00 (the nightly runs), nor on a Sunday morning (`restore-verify.yml` at
04:00 UTC): a prune holds restic's exclusive lock.

1. Turn the five rules off in the dashboard.
2. On the VM:

   ```bash
   set -a; source ~/homelab/.env.offsite; set +a
   restic forget --prune --group-by host,tags \
          --keep-daily 7 --keep-weekly 4 --keep-monthly 3
   restic check
   ```

   Grouped by host and tags because the dated path differs in every
   snapshot. No `unable to remove` may appear. Each kept snapshot is one
   day's `/srv/backups/<date>/`, so the cold-recovery window is about 3
   months, daily only for the last week.
3. Turn the rules back on.
4. `./scripts/offsite-lock-check.sh` prints `locked:` for all five.

The prune deletes offsite data, so the operator runs or approves it
(`AGENTS.md`, Access and operations).

## Restore

```bash
set -a; source ~/homelab/.env.offsite; set +a

restic snapshots                                # list
restic restore <snapshot-id> --target /tmp/r    # full restore
# --include matches the absolute path as stored in the snapshot
restic restore <snapshot-id> --target /tmp/r \
       --include "/srv/backups/2026-04-18/immich-postgres.dump"
```

Vaultwarden's restore from these files is in
[operational notes](../docs/operational-notes.md#vaultwarden).

DB recovery example:

```bash
docker exec -i immich-postgres pg_restore -U postgres -d immich --clean \
       < /tmp/r/srv/backups/2026-04-18/immich-postgres.dump
```

## Integrity

Each night `offsite-backup.sh` runs `restic check
--read-data-subset=<n>/28`, n from days since the epoch, so every pack is read
back every four weeks (1/28 of the repo a night; R2 has no egress fees), then
the sentinel lock check above.
