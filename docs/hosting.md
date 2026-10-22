# Hosting: Work OS on EC2 (phase 5)

Work OS moves from Vercel (paused 2026-10-19) to one EC2 instance at **https://work.delpat.in**. Data stays on MongoDB
Atlas. Akash runs the server side with Om. This is the whole runbook, in order; the files it installs are in `deploy/`.

| File | What |
|---|---|
| `deploy/nginx/work-os.conf` | nginx site: TLS, client address headers, WebSocket upgrade, no buffering, 10 MB bodies |
| `deploy/systemd/work-os.service` | the app (`next start` on 127.0.0.1:3000) |
| `deploy/systemd/work-os-alerts.{service,timer}` | the alert check every 15 minutes (was cron-job.org) |
| `deploy/systemd/work-os-backup.{service,timer}` | nightly `mongodump` to disk and S3 |
| `deploy/env.template` | every variable the server needs, names only |
| `deploy/deploy.sh` | fetch, `npm ci`, build, switch, restart, health check, automatic rollback |
| `deploy/cron-alerts.sh`, `deploy/backup.sh`, `deploy/env.sh` | what the timers run; the env-file loader the scripts share |
| `scripts/cutover.sh` | the one-time move to multi-user data (dry run by default) |

**Tested so far:** the cut-over chain end to end on a throwaway database (below), and `/api/live`. **Not tested** (no
Linux server or nginx on the dev PC): the nginx site, the systemd units, `deploy.sh`, `backup.sh` and `cron-alerts.sh`
were only syntax-checked. Expect small fixes on the first real run; fix them in the repo.

## 1. The instance (Akash)

- **Ubuntu 24.04 LTS**, x86_64. **t3.small** (2 vCPU, 2 GiB) is enough to serve; the build is the hungry part, so add a
  **4 GiB swap file**, or take **t3.medium** (4 GiB) and skip the swap. CPU credits: **standard** (decided; unlimited
  bills the burst).
- 20 GiB gp3 disk (each release is about 700 MB with `node_modules`; four are kept; backups are small).
- An **Elastic IP**, and DNS: `work.delpat.in A <Elastic IP>`.
- An **instance role** allowed `s3:PutObject` (and `s3:GetObject` for restores) on the backup bucket prefix only.
- **Security group:** inbound 443 and 80 from anywhere (80 only redirects and answers certbot), 22 from Delpat's
  office/VPN addresses only. Nothing else; the app's port 3000 listens on 127.0.0.1 and is never opened.
- On the box, the same with ufw: `sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`.

```bash
# swap (t3.small)
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Software

```bash
# Node 22 (package.json engines: 22.x)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx certbot python3-certbot-nginx awscli
# MongoDB Database Tools (mongodump/mongorestore) for backups: the .deb for Ubuntu 24.04 x86_64 from
# https://www.mongodb.com/try/download/database-tools
sudo apt-get install -y ./mongodb-database-tools-ubuntu2404-x86_64-*.deb
node -v   # v22.x
```

## 3. Atlas

Atlas → Network Access → **add the Elastic IP** (`/32`), with a comment "work.delpat.in EC2". Remove `0.0.0.0/0` if it
is there (Vercel needed it); keep only what still needs access (Om's own IP for scripts, if wanted). Use a database
user that has `readWrite` on `workos` only.

## 4. User, folders, code, environment

```bash
sudo adduser --system --group --home /srv/work-os workos
sudo -u workos git clone https://github.com/roguetitan1703/work-os.git /srv/work-os/repo
sudo -u workos mkdir -p /srv/work-os/releases
sudo install -d -o workos -g workos -m 0700 /var/backups/work-os
sudo install -d -m 0750 -g workos /etc/work-os
sudo install -m 0640 -g workos /srv/work-os/repo/deploy/env.template /etc/work-os/env
sudo nano /etc/work-os/env      # fill in; see Environment below
```

The repo is public and needs no credentials to clone.

## 5. TLS and nginx

```bash
# The certificate first (the default nginx site answers the challenge):
sudo certbot certonly --nginx -d work.delpat.in -m <ops email> --agree-tos -n
sudo cp /srv/work-os/repo/deploy/nginx/work-os.conf /etc/nginx/sites-available/work-os
sudo ln -sf /etc/nginx/sites-available/work-os /etc/nginx/sites-enabled/work-os
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run    # renewal works with our site in place
```

What the site does, and why:
- `X-Real-IP $remote_addr` and `X-Forwarded-For $remote_addr`, both overwritten, so a client cannot pick its own
  address. The app reads them only with `TRUST_PROXY=1` (sign-in rate limits per IP, `docs/auth.md`).
- WebSocket upgrade headers (`Upgrade`, `Connection` via a `map`) on every path, for push.
- `proxy_buffering off`: pages stream (Suspense) and MCP answers with server-sent events (Next's self-hosting guide).
- `client_max_body_size 10m`: server actions and MCP calls are small; note files go straight to blob storage.
- Requests to the bare IP or another name are dropped (444).

## 6. The app (systemd)

**systemd, not pm2:** it is already on the box, starts the app at boot, restarts it, keeps logs in journald, sandboxes
it (read-only system, own user), and runs the crons and backups as timers too. pm2 would add a global npm daemon and a
second log and startup system for the same job. (`ecosystem.config.js` in the repo is Om's local Windows setup only.)

```bash
sudo cp /srv/work-os/repo/deploy/systemd/work-os*.service /srv/work-os/repo/deploy/systemd/work-os*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable work-os                     # started by the first deploy
sudo /srv/work-os/repo/deploy/deploy.sh           # build and start (section 7)
sudo systemctl enable --now work-os-alerts.timer work-os-backup.timer
systemctl list-timers 'work-os*'
```

The unit runs `next start -H 127.0.0.1 -p 3000` as `workos` from `/srv/work-os/current`, with `/etc/work-os/env`.
On stop it sends SIGTERM and waits 30 s, so in-flight requests and `after()` work (alert flushes) finish. Set
`NODE_OPTIONS=--max-old-space-size` in the unit to about half the instance's memory (1024 on t3.small).

Logs: `journalctl -u work-os -f`, `journalctl -u work-os-alerts`, `journalctl -u work-os-backup`.

## 7. Deploying

```bash
sudo /srv/work-os/repo/deploy/deploy.sh            # origin/master
sudo /srv/work-os/repo/deploy/deploy.sh <ref>      # a branch, tag or commit
```

It fetches, unpacks the commit into `/srv/work-os/releases/<commit>`, runs `npm ci` and `npm run build` there (with
`NEXT_BUILD_CPUS=1` and a 1.5 GB heap; the old release keeps serving meanwhile), moves `current` to it, keeps the old
one as `previous`, restarts the app and waits up to a minute for `/api/live` and `/login` to answer 200. If they don't,
it switches back and restarts the old release by itself. It keeps the four newest releases. The build does not read
`/etc/work-os/env` (nothing there is needed at build time; checked: a build with no variables set serves normally).

Pushing to `master` no longer deploys anything: deploys are this command.

**Health:** `GET /api/live` answers `ok` and nothing else, without a session (nginx, systemd and the deploy script
use it; `proxy.ts` does not count it). `GET /api/admin/health` is the full report, for the operator only
(`OPERATOR_EMAILS`): 401 without a session or key, 403 for anyone else.

## 8. Rollback

- **Code:** `sudo /srv/work-os/repo/deploy/deploy.sh --rollback` swaps `current` and `previous` and restarts (seconds,
  no build). Any older release still in `releases/`: `sudo deploy.sh <its commit>` (already built, so no build).
- **Data:** code rollback does not undo a migration. Across the cut-over the only way back is restoring the backup
  taken just before it (section 11), with the old app; once people have used the new version, a restore loses their
  changes since. So: rehearse first, cut over at a quiet time, and check right after.
- **DNS:** the Vercel deployment is paused; there is no older host to point back at.

## 9. Environment

Names only; values live in `/etc/work-os/env` (root:workos, 0640) and nowhere else. Found with a grep of
`process.env` over `app`, `lib`, `proxy.ts`, `next.config.ts`, `scripts`, `worker`. **Secret** = never in the repo,
chat or tickets.

| Variable | For | Secret |
|---|---|---|
| `MONGODB_URI` | Atlas connection string (the app also accepts `MONGO_*_URI` names) | **yes** |
| `MONGODB_DB` | database name, `workos` | |
| `BETTER_AUTH_SECRET` | signs session cookies and MCP confirm tokens, hashes tokens, encrypts authenticator secrets. Make it once and keep it: changing it signs everyone out and breaks authenticator apps | **yes** |
| `APP_URL` | `https://work.delpat.in`: Better Auth's base URL, the passkey domain (passkeys work only on the domain they were made on), links in mail, Discord and to Claude | |
| `TRUST_PROXY` | `1`: trust nginx's `X-Real-IP` / `X-Forwarded-For` for per-IP sign-in limits | |
| `OPERATOR_EMAILS` | who runs the deployment (comma list): health, Usage, Discord registration and servers. Unset = nobody | |
| `INVITE_LINK_TO_INVITER` | unset/`1`: the inviter also sees invitation links; `0`: by email only | |
| `CRON_SECRET` | the alert check's header (`work-os-alerts.timer`); 16+ characters | **yes** |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | SMTP for password reset, invitations, test mail. Without mail nobody can set a password | |
| `EMAIL_PASSWORD` | SMTP password | **yes** |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | phone push | |
| `VAPID_PRIVATE_KEY` | phone push | **yes** |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | the Discord bot | |
| `DISCORD_BOT_TOKEN` | the Discord bot | **yes** |
| `DISCORD_BLOCKED_CHANNELS` | extra channels never read (normally set in Settings) | |
| `APP_TZ` | timezone for people who have not chosen one | |
| `MCP_ALLOW_URL_TOKEN` | `1` allows `/api/mcp/<key>`; leave unset | |
| `USAGE_LOG` | `off` stops the request log (Settings › Usage); leave unset | |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_S3_URI` | `deploy/backup.sh` | |
| `OWNER_EMAIL`, `OWNER_NAME` | cut-over only: the first user (Om) | |
| `DISCORD_GUILD_ID`, `DISCORD_OWNER_ID` | cut-over only: read once by `migrate-phase3`, then removed (step 6) | |

Set by the unit, not the file: `NODE_ENV=production`, `NODE_OPTIONS`, `NEXT_TELEMETRY_DISABLED`.
Not set on the server:
- old names, now unused: `APP_PASSWORD`, `MCP_TOKEN`, `SESSION_SECRET` (read only if `BETTER_AUTH_SECRET` is missing),
  `NEXT_PUBLIC_APP_TZ`;
- `BETTER_AUTH_URL`: a fallback for `APP_URL`;
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob, for note files, which are switched off;
- Vercel's own: `VERCEL_ENV`, `VERCEL_REGION`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL`;
- tests only: `AUTH_RATE_LIMIT`, `MAIL_CAPTURE_DIR`, `DISCORD_API_BASE`;
- build only: `NEXT_BUILD_CPUS`;
- the worker on each PC: `WORK_OS_WORKER_DIR`, `WORK_OS_CLAUDE_JSON`, `WORK_OS_CLAUDE_PROJECTS`, `DEVICE_KEY`.

## 10. Cut-over (once, with Om)

Atlas still holds single-user data from before phase 1. `scripts/cutover.sh` moves it, in the order from WORK-STATE:

| Step | What | Script |
|---|---|---|
| 0 | variables present (names only printed); `mongodump` first; app stopped (`--service`) | `deploy/backup.sh --local-only` |
| 1 | an account for every `OPERATOR_EMAILS` address, first: an invitation to an operator address that has no account would make whoever accepts it the operator | `scripts/create-operators.mjs` |
| 2 | Om as the first user, organization Delpat, Om owner; old computers revoked | `scripts/migrate-auth.mjs` |
| 3 | `orgId`/owner/visibility on everything: first `--copy-to <db>_cutover_<time>` (a rehearsal on a copy, run twice to prove there is nothing left), then `--apply` | `scripts/migrate-ownership.mjs` |
| 4 | schedule, modes, timezone, Discord ids as data | `scripts/migrate-phase3.mjs` |
| 5 | the app is started; Discord commands registered again (they gain `/link`) through the app's own route, with a temporary operator key deleted right after | `scripts/discord-register.mjs` |
| 6 | `DISCORD_GUILD_ID` and `DISCORD_OWNER_ID` removed from `/etc/work-os/env` (a dated copy is kept beside it; delete it once all is well) | |

It is a dry run unless `--apply`, stops at the first error, and every step is idempotent (`--from N` to resume).

```bash
cd /srv/work-os/current
sudo scripts/cutover.sh --db workos --env-file /etc/work-os/env                           # dry run: read it
sudo scripts/cutover.sh --db workos --env-file /etc/work-os/env --apply --service work-os  # do it
```

A dry run on a database from before step 2 can only say that steps 3 and 4 wait on it. For a full dry run, rehearse
on a restored copy (section 11): `--db workos_restore --to 4 --skip-backup`.

Then Om:
1. `https://work.delpat.in/login` → *Forgot password?* → his address → sets a password from the mail; turns the
   authenticator app and passkeys on again.
2. Settings › Connections: a Claude chat key; updates the claude.ai connector URL to `https://work.delpat.in/api/mcp`.
3. Claude › Setup: Claude Code keys; re-adds each computer and puts the new `wkr_` key and
   `baseUrl: https://work.delpat.in` in the worker config.
4. Discord Developer Portal: Interactions Endpoint URL → `https://work.delpat.in/api/discord/interactions`.
5. Only then invites the team (Settings › Members).

Later, once all is well: `migrate-auth.mjs --db workos --apply --drop-old` deletes the old auth data, and the
`workos_cutover_*` copy can be dropped in Atlas.

### Rehearsal (2026-10-22, local throwaway mongod, never Atlas)

1. **Seed.** The app at f9ae24e (the commit before phase 1) was built in a scratch folder and run against an empty
   throwaway database. `tests/rehearsal/seed-legacy.mjs` filled it through that old app's MCP and alert cron, plus
   direct inserts in the old shapes for what has no tool:
   - 4 projects, 14 tasks (dependencies, recurring, done, blocked, one given to Claude), 22 history entries;
   - 4 notes (with a sub-page), 2 Claude items (one waiting on Om), 1 trashed task;
   - 2 weekly reviews with the old fields, 2 routine logs with `bidsPlaced`;
   - an old Claude Code key, an old computer with a folder, a push device, 5 inbox notices and 4 alert-log entries;
   - the old settings documents (`notify`, `dispatcher`, `discord`, `security`).
2. **Cut-over.** `scripts/cutover.sh`, first as a dry run, then `--apply --skip-backup --to 4`. Then the new app was
   started (a build made with no variables set), with a stand-in for Discord (`tests/rehearsal/discord-stub.mjs`),
   and `--apply --from 5`. Steps 0–4 took about 5 s on this data. Results:
   - Step 1 made both operator accounts, and step 2 found Om's.
   - Step 3: the copy migrated, and a second run on it found nothing left. The only thing reported was the old
     computer's folder, which stays without an owner by design.
   - Step 5 registered `link, task, today, done, progress, Add to Work OS`, and the temporary key was gone afterwards.
   - Step 6 removed the two variables.
3. **The app afterwards** (`tests/rehearsal/check-cutover.mjs`): **25/25 checks passed.**
   - Sign-in: the reset mail reached Om; he set a password and signed in.
   - Pages: Tasks, Today, Projects, Notes, Review › Done and Trash showed the old items, and Timetable showed his old
     week.
   - `/api/admin/health` answered him with counts matching the database, and 401 without a session. MCP
     `list_tasks` with his key listed the old tasks.
   - Database: every document has an organization (except the old computer's folder); the old settings ids are gone;
     the old computer is revoked; reviews hold `answers`; routine logs hold `count`.
   - Records: the task given to Claude records Om, and the Claude item waits on Om.
4. **Again.** The whole chain run a second time with `--apply` changed nothing. A missing `OPERATOR_EMAILS`
   stopped it at step 0, and a malformed one at step 1.

To repeat it: seed as above (old app on a throwaway database), then
`OLD_BASE=… MCP_TOKEN=… CRON_SECRET=… MONGODB_URI=… MONGODB_DB=… node tests/rehearsal/seed-legacy.mjs`,
`scripts/cutover.sh` with a scratch env file, and
`BASE=… MAIL_CAPTURE_DIR=… OWNER_EMAIL=… BETTER_AUTH_SECRET=… MONGODB_URI=… MONGODB_DB=… node tests/rehearsal/check-cutover.mjs`.
The app under test needs `MAIL_CAPTURE_DIR` set, so the reset mail lands in a folder.

## 11. Backups

`work-os-backup.timer` runs `deploy/backup.sh` at 03:00 IST:
- `mongodump` of `MONGODB_DB` to `/var/backups/work-os/workos-<UTC time>.archive.gz`. The connection string goes to
  mongodump in a 0600 temporary file, never on the command line.
- Then `aws s3 cp` to `BACKUP_S3_URI` with server-side encryption, using the instance role.
- On disk it keeps `BACKUP_KEEP_DAYS` (14) days. S3 keeps what its **lifecycle rule** says: set one on the bucket
  prefix, e.g. expire after 35 days. The script never deletes from S3.

The dumps hold password hashes, encrypted authenticator secrets and everyone's tasks: the bucket must be private,
with versioning optional and public access blocked.

Run one by hand: `sudo systemctl start work-os-backup && journalctl -u work-os-backup -n 20`.

**Restore drill** (once after setup, then every few months; never onto `workos` itself unless restoring for real):

```bash
aws s3 cp s3://<bucket>/work-os/workos-<time>.archive.gz /tmp/drill.archive.gz      # or a local file
# into a scratch database on Atlas (or a local mongod), renaming the namespace:
mongorestore --uri "<Atlas URI>" --archive=/tmp/drill.archive.gz --gzip \
  --nsFrom 'workos.*' --nsTo 'workos_restore.*' --drop
# check: the same collections and counts as the live database
mongosh "<Atlas URI>" --eval 'for (const d of ["workos","workos_restore"]) print(d, db.getSiblingDB(d).tasks.countDocuments(), db.getSiblingDB(d).user.countDocuments())'
# then drop workos_restore in Atlas and delete /tmp/drill.archive.gz
```

(Type the URI at a prompt or read it from the env file; don't leave it in shell history.) A real restore is the same
command with `--nsTo 'workos.*'`, with the app stopped first.

## 12. Push

(Builder B: the WebSocket push for the worker and open pages, and anything nginx or systemd needs for it.)
