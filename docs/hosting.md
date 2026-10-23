# Hosting: Work OS on EC2 (phase 5)

Work OS moves from Vercel (paused 2026-10-19) to Delpat's EC2 server (a t4g.small, arm64, shared with other apps) at
**https://work.delpat.in**. Data stays on MongoDB
Atlas. Akash runs the server side with Om. This is the whole runbook, in order; the files it installs are in `deploy/`.

| File | What |
|---|---|
| `deploy/preflight.sh` | read-only report on the box before anything is installed (section 1) |
| `deploy/caddy/work-os.caddy` | the Caddy site (the box serves with Caddy): client address header, streams flushed at once, 10 MB bodies, HSTS; imported, adds one site only (section 5) |
| `deploy/nginx/work-os.conf`, `work-os-default-deny.conf` | the same for a box that serves with nginx (alternative, section 5) |
| `deploy/systemd/work-os.service` | the app (`next start` on 127.0.0.1:`WORK_OS_PORT`, default 3100), with its own Node 22 and memory caps |
| `deploy/systemd/work-os-alerts.{service,timer}` | the alert check every 15 minutes (was cron-job.org) |
| `deploy/systemd/work-os-backup.{service,timer}` | nightly `mongodump` to disk and S3 (off on the shared box: section 11) |
| `deploy/env.template` | every variable the server needs, names only |
| `.github/workflows/server-build.yml` | builds `.next` on an arm64 GitHub runner and publishes it (section 7) |
| `deploy/deploy.sh` → `work-os-deploy` | fetch, download and check the build, `npm ci --omit=dev --ignore-scripts`, seal, switch, restart, health check, automatic rollback |
| `deploy/fresh-build-secrets.mjs` → `work-os-fresh-secrets.mjs` | gives a downloaded build fresh secrets (section 7) |
| `deploy/cron-alerts.sh` → `work-os-cron-alerts`, `deploy/backup.sh` → `work-os-backup` | what the timers run |
| `deploy/env.sh` → `work-os-env.sh` | the env-file loader the scripts share |
| `scripts/cutover.sh` → `work-os-cutover` | the one-time move to multi-user data (dry run by default) |

**Who runs what.** Root runs only root-owned copies of these scripts in `/usr/local/sbin` (the names after →), never
anything from a release: a release is written by the build user and by every npm package's install script.
- `workos-build` fetches, unpacks the build and installs packages (and builds, with `--build-here`). It cannot read
  `/etc/work-os/env`.
- `workos` runs the app, the timers and the cut-over's node steps. It can write only the live release's `.next/cache`
  and `/var/backups/work-os`.
- Root restarts the app, moves the `current` symlink and edits the env file (cut-over step 6).

**Tested so far:**
- the cut-over chain end to end on a throwaway database (below), and `/api/live`;
- a release made the way the box makes one (2026-10-23, Windows, Next 16.2.4): the repo unpacked from git, a `.next`
  built elsewhere copied in with its `.next/node_modules` links pointing at the release's own `node_modules`, and
  `npm ci --omit=dev`; `next start` answered `/api/live` and `/login` 200 and a sign-in reached the database, also
  with the `typescript` package removed;
- `deploy.sh`'s tarball checks with fake builds (wrong commit, CPU, Node, extra files, no BUILD_ID) and its link
  rules; its attestation check with a real GitHub attestation, logged out of GitHub: accepted for the right repo,
  workflow, commit and branch, refused for another repo's build, another commit, another branch, a changed file and
  a broken bundle;
- the build's fresh secrets (section 7): after the script, the published preview id no longer revalidates or
  bypasses anything, and the app runs with `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (every e2e suite sets it);
- the Caddy site with Caddy 2.11.7 (plain HTTP on a test port, a stub app behind it): a client's own `X-Real-IP`,
  `X-Forwarded-For` and `x-workos-client-ip` never reach the app, HSTS is set and `Server` dropped, `/api/cron/`
  answers 404 without reaching the app, an 11 MB body gets 413 and a 9 MB one passes, a stream's first event arrives
  at once (not when the response ends) and is not compressed;
- `deploy.sh`'s Atlas guard against sample env files (local, docker and plain `mongodb://` addresses, a
  `MONGO_*_URI` name, quotes, `export`, `ALLOW_NON_ATLAS`);
- `deploy.sh`'s tarball listing check (symlinks out of the release or outside `.next/node_modules`, hard links,
  devices) and the sealing of a release (root's tree, no group/other write, the app's cache, `.prepared`, a
  `.prepared` the build user wrote) with stub users;
- the app started from a release made with `npm ci --omit=dev --ignore-scripts` (pages, the image optimizer: sharp).

**Not tested** (no Linux server, nginx or systemd on the dev PC): the Caddy site with TLS and inside the box's own
Caddyfile, the nginx site, the systemd units and their memory caps under real load, `deploy.sh` as a whole,
`preflight.sh`, `backup.sh`, `cron-alerts.sh` and the Server build workflow (it first runs on the first push to
`master`) were only syntax-checked. Expect small fixes on the first real run; fix them in the repo.

## 1. The server (Akash)

Work OS goes on Delpat's existing EC2 server: a **t4g.small** (2 vCPU **ARM64 Graviton**, 2 GiB), with an Elastic IP and
one volume already, **shared with other apps**. Nothing about it (instance id, IP, internal names) goes in this repo:
it is public. Placeholders below: `<ops email>`, `<bucket>`, `<your IP>`.

**What is on it already** (2026-10-23; the details went to Om privately): Ubuntu 24.04 aarch64; 1.8 GiB RAM, most of
it in use, and a 2 GiB swapfile already partly used; a few GB of disk free; a system Node 20 that other apps run on;
Docker containers, among them a MongoDB on 27017; **Caddy** on :80 and :443; port 3000 and several others taken.
So Work OS:
- listens on **127.0.0.1:3100** (`WORK_OS_PORT`);
- runs its **own Node 22** from `/opt/work-os/node` (section 2) and never touches the system Node or PM2;
- is one more **Caddy site**, imported into the existing Caddyfile (section 5);
- uses **Atlas only**: never the docker MongoDB on 27017 (`work-os-deploy` wants an Atlas `MONGODB_URI`);
- is capped in memory (section 6) and keeps **one release** on disk (section 7); a deploy needs 1.5 GB free under
  `/srv`;
- keeps **no local backups** by default (section 11).

The box is already **swap-heavy**: the memory Work OS takes comes partly out of what the other apps now hold in RAM.
Expect it to get slower for everyone, not to fail; watch `free -m` and `systemctl status work-os` the first week,
and talk to Om before Work OS takes more (docs/cpu.md).

**First, the pre-flight** (read-only; changes nothing, prints no secrets):

```bash
curl -fsSLO https://raw.githubusercontent.com/roguetitan1703/work-os/master/deploy/preflight.sh
sudo bash preflight.sh          # or without sudo: the same minus the process behind each port
```

It reports the CPU type, OS, RAM, swap, disk, cgroup v2, Node (the system one and Work OS's own), Caddy (sites and
imports in the Caddyfile) and nginx if present, the ports in use, users, and whatever Work OS would create that
already exists. Read it before installing anything, and send it to Om **privately**: it describes the other apps on
the box (their sites, ports, users and services), so never paste it into a public issue, the repo or a shared chat.
What to look for:
- **Port 3100** taken by another app: set `WORK_OS_PORT` (section 9) and the ports in the Caddy site (section 5) to
  a free one.
- **Caddy** already serving `work.delpat.in`, or already importing a `work-os.caddy`: stop and ask Om.
- **Under 1.5 GB free** under `/srv`: a deploy refuses to start; free space first (not the other apps').
- **Under 400 MB available** with the other apps running: the app's cap is 480 MB (section 6); ask Om before going
  on.

**The shared box, what Work OS adds and touches:**
- Users `workos` and `workos-build`; folders `/srv/work-os`, `/opt/work-os`, `/etc/work-os`; scripts
  `/usr/local/sbin/work-os-*`; units `work-os.service`, `work-os-alerts.*` (and `work-os-backup.*`, installed but
  not enabled). All named `work-os`, so nothing collides; the pre-flight says if any exists already.
- One Caddy site file, `/etc/caddy/sites/work-os.caddy` (the site `work.delpat.in` only), and one `import` line in
  the existing Caddyfile. No global options, no other site touched; Caddy is reloaded, never restarted.
- One app process on 127.0.0.1:3100, never opened in the security group.
- The box's CPU credits and memory, which every app on it shares (docs/cpu.md "Graviton, shared").
- **No ufw on a shared box.** `ufw enable` blocks every port not allowed first, including the other apps' ports. The
  security group is the firewall: inbound 443 and 80 from anywhere (Caddy needs 80 for certificates and redirects),
  22 from Delpat's office/VPN addresses only. If ufw is already on (the pre-flight says), Work OS needs nothing new
  in it: Caddy already has 80 and 443.

**Swap:** the box has a 2 GiB swapfile already; leave it. (On a box without one: 2 GiB as a safety net for the running
apps, not for builds, made with `fallocate`, `mkswap`, `swapon` and a line in `/etc/fstab`. Don't change
`vm.swappiness` on a shared box without its owners.)

**CPU credits:** standard mode (decided; unlimited bills the burst). A t4g.small earns the same as a t3.small (20% of
each vCPU), and the other apps spend from the same balance (docs/cpu.md).

**DNS:** `work.delpat.in A <the Elastic IP>`.

**Backups (on hold: Om is deciding whether and where).** Nothing is backed up from the box for now: the backup
timer is not enabled (section 11), Atlas's own backups are what there is. The S3 parts of this runbook (an instance
role with `s3:PutObject` only, IMDSv2 with hop limit 1, `BACKUP_S3_URI`) wait on that decision.

## 2. Software

The box is **arm64** (`uname -m` says `aarch64`). Everything Work OS needs has arm64 builds (checked 2026-10-23
against `package-lock.json`):
- Node 22 (NodeSource and the Node.js tarballs both ship `linux-arm64`).
- npm packages with native parts, all with a `linux-arm64-gnu` package in the lockfile: Next's SWC
  (`@next/swc-linux-arm64-gnu`, needed at runtime to load `next.config.ts`), `sharp` (`@img/sharp-linux-arm64`;
  optional, and unused: the app has no `next/image`), and, for builds only, tailwind's `oxide`, `lightningcss` and
  `unrs-resolver` (eslint). Install scripts: `sharp`, `msw` (a dependency of shadcn), `unrs-resolver`; none is
  x64-only. The worker (`worker/`) runs on people's PCs, not here.
- MongoDB Database Tools (`mongodump`/`mongorestore`): an `arm64` .deb for Ubuntu (and an `aarch64` rpm for Amazon
  Linux 2023).
- age (only if the backup plan uses it; on hold): Ubuntu's `age` package exists for arm64.

Nothing found that is x64-only. The thing to get right is that **native packages match the machine**: they are
installed on the box by `npm ci --omit=dev` (section 7), never copied from a build made on another kind of machine.

**Node 22 for Work OS only.** The system Node (20) belongs to the other apps and stays as it is: no NodeSource, no
`apt install nodejs`, no `n`/`nvm` for root. Work OS gets the official tarball, pinned and checked, under `/opt`;
the unit, `work-os-deploy` and `work-os-cutover` use `/opt/work-os/node/bin/node` and never the one on `PATH`.

```bash
V=v22.23.4
F=node-$V-linux-arm64.tar.xz
cd /tmp && curl -fsSLO --proto '=https' https://nodejs.org/dist/$V/$F
# sha256 from https://nodejs.org/dist/v22.23.4/SHASUMS256.txt (checked 2026-10-23); it must print "OK"
echo "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b  $F" | sha256sum -c
sudo install -d -o root -g root -m 0755 /opt/work-os
sudo tar -xJf $F -C /opt/work-os --no-same-owner      # /opt/work-os/node-v22.23.4-linux-arm64, owned by root
sudo ln -sfn /opt/work-os/node-$V-linux-arm64 /opt/work-os/node
rm $F
/opt/work-os/node/bin/node -v && /opt/work-os/node/bin/node -p process.arch    # v22.23.4, arm64
node -v                                                                         # the system Node, still v20
```

A Node update for Work OS: the same lines with the new version and its sha256 from that version's `SHASUMS256.txt`
(and, to match, `node-version` in `.github/workflows/server-build.yml`), then `sudo systemctl restart work-os`. The
old folder can go once the app runs on the new one. The deploy refuses a Node under `/opt/work-os/node` that is not
22.x, and a build whose Node major differs from it.

The rest:

```bash
sudo apt-get install -y git
# GitHub CLI, only to verify build attestations offline (section 7 has the apt lines; it has arm64 packages)
```

Caddy is already installed and running; Work OS needs nothing more from it. MongoDB Database Tools (`mongodump`) are
only for backups, which are off (section 11): install them when backups are decided (the `ubuntu2404-arm64` .deb from
https://www.mongodb.com/try/download/database-tools).

## 3. Atlas

Atlas → Network Access → **add the Elastic IP** (`/32`), with a comment "work.delpat.in EC2". Remove `0.0.0.0/0` if it
is there (Vercel needed it); keep only what still needs access (Om's own IP for scripts, if wanted). Use a database
user that has `readWrite` on `workos` only.

## 4. User, folders, code, environment

```bash
# the app's user (no home, no shell) and the build user (its own home for the npm cache; not in group workos)
sudo adduser --system --group --no-create-home --home /nonexistent workos
sudo adduser --system --group --home /var/lib/workos-build workos-build
sudo install -d -o root -g root -m 0755 /srv/work-os
sudo install -d -o root -g root -m 0755 /srv/work-os/releases   # root's: the build user only fills a release folder
sudo -u workos-build git clone https://github.com/roguetitan1703/work-os.git /srv/work-os/repo
sudo install -d -m 0750 -g workos /etc/work-os
sudo install -m 0640 -g workos /srv/work-os/repo/deploy/env.template /etc/work-os/env
sudo nano /etc/work-os/env      # fill in; see Environment below

# root-owned scripts: what root (and the timers) run. Re-run these lines after a change to deploy/ or
# scripts/cutover.sh, having read the diff.
D=/srv/work-os/repo/deploy
sudo install -o root -g root -m 0755 $D/deploy.sh /usr/local/sbin/work-os-deploy
sudo install -o root -g root -m 0644 $D/fresh-build-secrets.mjs /usr/local/sbin/work-os-fresh-secrets.mjs
sudo install -o root -g root -m 0755 $D/backup.sh /usr/local/sbin/work-os-backup
sudo install -o root -g root -m 0755 $D/cron-alerts.sh /usr/local/sbin/work-os-cron-alerts
sudo install -o root -g root -m 0644 $D/env.sh /usr/local/sbin/work-os-env.sh
sudo install -o root -g root -m 0755 /srv/work-os/repo/scripts/cutover.sh /usr/local/sbin/work-os-cutover
```

Where the builds come from (section 7), fixed once by root; deploys never read it from the build user's git remote:

```bash
echo 'GITHUB_REPO=roguetitan1703/work-os' | sudo tee /etc/work-os/deploy.conf >/dev/null
sudo chown root:root /etc/work-os/deploy.conf && sudo chmod 0644 /etc/work-os/deploy.conf
```

The repo is public and needs no credentials to clone.

## 5. TLS and Caddy

The box serves its other sites with **Caddy**: Work OS **adds** one site file and one `import` line, and touches
nothing else. Never replace the Caddyfile, never `systemctl restart caddy` (a reload keeps the other sites up and
keeps the old config if the new one fails), and never reload a config that fails `caddy validate`.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # must pass BEFORE we add anything
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-work-os         # to undo
sudo install -d -o root -g root -m 0755 /etc/caddy/sites
sudo install -o root -g root -m 0644 /srv/work-os/repo/deploy/caddy/work-os.caddy /etc/caddy/sites/work-os.caddy
# WORK_OS_PORT is not 3100? Change the two "127.0.0.1:3100" in /etc/caddy/sites/work-os.caddy.
printf '
import /etc/caddy/sites/work-os.caddy
' | sudo tee -a /etc/caddy/Caddyfile >/dev/null   # at the end, its own line
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
journalctl -u caddy -n 30 --no-pager      # "certificate obtained successfully" for work.delpat.in
```

The `import` goes at the end of the Caddyfile on a line of its own, outside every other site's braces. If
`caddy validate` fails after adding it, put the copy back (`sudo cp /etc/caddy/Caddyfile.before-work-os
/etc/caddy/Caddyfile`) and stop. Likely causes: the Caddyfile has no such import path or a global block that
conflicts, or another site already serves `work.delpat.in`. Caddy gets the certificate itself once DNS points here
(ports 80 and 443 open); there is no certbot.

What the site does, and why (comments in the file say the same):
- `X-Real-IP` set to the address Caddy saw, replacing what the client sent; Caddy also replaces `X-Forwarded-For`
  (it trusts no proxy in front of it) and sets `X-Forwarded-Proto`. The app reads them only with `TRUST_PROXY=1`
  (sign-in rate limits per IP, `docs/auth.md`). The client's `x-workos-client-ip` (the header Better Auth reads) is
  dropped.
- `flush_interval -1`: pages stream (Suspense), MCP answers with server-sent events, and the push streams send an
  event at a time (section 12). No `encode`: Next compresses pages itself, and the streams must not be held back.
- `request_body max_size 10MB`: server actions and MCP calls are small; note files go straight to blob storage.
- HSTS (a year), and no `Server` header.
- `/api/cron/` answers 404 from outside. The timer calls the app on 127.0.0.1:`WORK_OS_PORT` directly; the route
  takes the secret only as a header (`?key=` in the URL is no longer accepted: it would land in logs).
- **No per-address rate limits.** The nginx site limits `/api/auth/` to 30 a minute per address and streams to 20 per
  address; stock Caddy has no rate limiting (it needs a plugin, i.e. a rebuilt Caddy for the whole box). What still
  limits: Better Auth's own limits per address and per account, and the app's stream caps (10 per person, 2 per
  computer). Decision for Om: enough, or a Caddy with the rate-limit plugin (it changes the other apps' Caddy).

### The nginx alternative

For a box that serves with nginx instead, `deploy/nginx/work-os.conf` does the same plus the per-address limits.
It too only adds (no default server, nothing at the http level), with the certificate from certbot:

```bash
sudo nginx -t                   # must pass BEFORE we add anything; if not, stop: the other apps' config is broken
sudo certbot certonly --nginx -d work.delpat.in -m <ops email> --agree-tos -n
sudo cp /srv/work-os/repo/deploy/nginx/work-os.conf /etc/nginx/sites-available/work-os
sudo ln -s /etc/nginx/sites-available/work-os /etc/nginx/sites-enabled/work-os
# WORK_OS_PORT is not 3100? Change "server 127.0.0.1:3100;" in the upstream to the same port.
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run    # renewal works with our site in place
```

If `nginx -t` fails after adding the site, `sudo rm /etc/nginx/sites-enabled/work-os` puts the box back as it was.
Likely causes on a shared box: a version older than 1.19.4 (no `ssl_reject_handshake`, only in the opt-in file),
another site already using a name starting `work_os_`, or the Let's Encrypt include files missing (certbot made the
certificate without its nginx plugin).

**Opt-in: dropping unknown names.** `deploy/nginx/work-os-default-deny.conf` makes nginx close connections for names
it does not serve and for the bare IP (444 on 80; on 443 the TLS handshake is refused, so no certificate is shown).
It becomes the default server for **every** site on the box, so install it only if no other app is or relies on
being the default (a `www.` alias nobody listed, a health check by IP), and only after asking the other apps' owners.
nginx refuses two default servers on one port: if the pre-flight lists a `default_server` already, leave it out.
Without it, a request to the IP or an unknown name gets whatever site nginx loads first, as before Work OS. If
Work OS is the **only** site on port 443, that first site is Work OS: the bare IP and any name pointed at the box then
show the Work OS sign-in page (with the work.delpat.in certificate, so browsers warn). Harmless (everything behind
it still needs a session), but if that matters, install the opt-in file, or make sure another site is the default.

What the nginx site does, and why:What the site does, and why:
- `X-Real-IP $remote_addr` and `X-Forwarded-For $remote_addr`, both overwritten, so a client cannot pick its own
  address. The app reads them only with `TRUST_PROXY=1` (sign-in rate limits per IP, `docs/auth.md`).
- WebSocket upgrade headers on every path (the map is `$work_os_connection_upgrade`: the usual `$connection_upgrade`
  name is often defined by another site already, and nginx refuses a variable defined twice).
- `proxy_buffering off`: pages stream (Suspense) and MCP answers with server-sent events (Next's self-hosting guide).
- `client_max_body_size 10m`: server actions and MCP calls are small; note files go straight to blob storage.
- `server_tokens off` and the 429 status for its limits are set inside its own server blocks, not for the whole box.
- `listen 443 ssl http2`: works on nginx 1.18 to 1.24 (Ubuntu 22.04/24.04) and later (1.25.1+ warns that `http2 on;`
  is the new form, which older versions reject).
- `/api/auth/`: at most 30 requests a minute per address (burst 20), on top of Better Auth's own limits. Zones are
  named `work_os_*`.
- `/api/cron/`: localhost only. The timer calls the app on 127.0.0.1:`WORK_OS_PORT` directly; the route takes the
  secret only as a header (`?key=` in the URL is no longer accepted: it would land in logs).

## 6. The app (systemd)

**systemd, not pm2:** it is already on the box, starts the app at boot, restarts it, keeps logs in journald, sandboxes
it (read-only system, own user), and runs the crons and backups as timers too. pm2 would add a global npm daemon and a
second log and startup system for the same job. (`ecosystem.config.js` in the repo is Om's local Windows setup only.)

```bash
sudo cp /srv/work-os/repo/deploy/systemd/work-os*.service /srv/work-os/repo/deploy/systemd/work-os*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable work-os                     # started by the first deploy
sudo work-os-deploy                               # fetch the build and start (section 7)
sudo systemctl enable --now work-os-alerts.timer   # not work-os-backup.timer: backups are off (section 11)
systemctl list-timers 'work-os*'
```

The unit runs `/opt/work-os/node/bin/node … next start -H 127.0.0.1 -p $WORK_OS_PORT` (default 3100) as `workos`
from `/srv/work-os/current`, with `/etc/work-os/env`, in a read-only system where the only writable path is that
release's `.next/cache`.
On stop it sends SIGTERM and waits 30 s, so in-flight requests and `after()` work (alert flushes) finish.

**Memory.** The box has 1.8 GiB for every app and already leans on swap, so the unit caps Work OS:
- heap 288 MB (`NODE_OPTIONS=--max-old-space-size=288`): the app peaked at 216 MB of heap and 356 MB RSS with 20
  people (docs/cpu.md), measured with a 1024 MB cap; 288 is that peak plus a third;
- `MemoryHigh=380M`: past it the kernel takes memory back from Work OS first (it slows down, it is not killed);
- `MemoryMax=480M`: past it the app is killed and systemd starts it again (`Restart=always`); people see a few
  seconds of errors and their pages reconnect.

These are estimates from a load test on a PC, not measured on the box. In the first weeks watch
`systemctl status work-os` (the `Memory:` line, against high and max) and `journalctl -u work-os | grep -i
'heap\|oom'`. If the app hits them under normal use, raise all three together (e.g. 384 / 480M / 600M) after
checking with Om what the other apps can spare. Alone on a box: heap about half its memory, no caps.

Logs: `journalctl -u work-os -f`, `journalctl -u work-os-alerts`, `journalctl -u work-os-backup`.

## 7. Deploying

```bash
sudo work-os-deploy                              # origin/master
sudo work-os-deploy <commit>                     # an older master commit whose build is still published
sudo work-os-deploy <ref> --artifact <file>      # a build made on another arm64 machine (below)
sudo work-os-deploy <ref> --build-here           # last resort: build on the box
```

### The build: made off the box

The box does not build Work OS. A Next build wants 1.5 GB or more for a few minutes, and the box has 1.8 GiB shared
with other apps and is already deep in swap: building there would push them further into swap or wake the OOM
killer. So the build is made elsewhere **for the
same CPU type (arm64)**, and the box only installs the runtime packages.

1. **GitHub Actions** (`.github/workflows/server-build.yml`, "Server build") runs on every push to `master`, and by
   hand (Actions → Server build → Run workflow, on `master`; it builds the commit it runs on, nothing else). Two jobs:
   - **build** (read-only token; checkout keeps no credentials): on an `ubuntu-24.04-arm` runner, in the folder a
     release has on the server (`/srv/work-os/releases/<commit>`), `npm ci` and `npm run build` with no variables
     (none are needed at build time). It packs `work-os-<commit>.tar.gz` (the `.next` folder without its cache, plus
     `REVISION`, `BUILD_ARCH` and `BUILD_NODE`) and its `.sha256`, and hands them on as a workflow artifact.
   - **publish** (the only job that can write; it runs no repository code and no npm): takes the artifact, makes a
     signed **build provenance attestation** for the tarball (`actions/attest-build-provenance`: GitHub's Sigstore
     certificate names the repo, the workflow, the commit, the branch and a GitHub-hosted runner), and adds the
     tarball, `.sha256` and the attestation (`.sigstore.json`) to the repo's **builds** pre-release. A file already
     there is never replaced. It keeps the newest 20 builds.

   Every action is pinned to a full commit SHA (the version is in a comment beside it). Arm64 runners are free for
   public repos; the downloads are public, so the box needs no GitHub credentials.
2. **`work-os-deploy`** downloads the three files for the commit it deploys over HTTPS only
   (`https://github.com/<GITHUB_REPO>/releases/download/builds/…`, `GITHUB_REPO` from root's `/etc/work-os/deploy.conf`,
   never from the build user's git remote) into root's own 0700 folder, and before unpacking anything checks:
   - the SHA-256;
   - the attestation, offline (`gh attestation verify --bundle`, no GitHub login): made by
     `<GITHUB_REPO>/.github/workflows/server-build.yml`, from exactly the commit the box's git says it is deploying
     (`--source-digest`), on `refs/heads/master` (`--source-ref`), on a GitHub-hosted runner
     (`--deny-self-hosted-runners`). So a build from a branch, another repo, a fork or a changed file is refused;
   - that the tarball holds only `.next/…`, `REVISION`, `BUILD_ARCH` and `BUILD_NODE`, with no `..`, and, from its
     listing (`tar -tvzf`) before anything is written: only files, folders and symlinks (no hard links, devices or
     fifos), each symlink in `.next/node_modules` and pointing into this release's `node_modules`.

   Then `workos-build` unpacks the commit from git into `/srv/work-os/releases/<commit>`, the build over it, and the
   checks go on:
   - its only symlinks are in `.next/node_modules` and point into this release's `node_modules`. Next keeps some
     packages external (mongodb, @blocknote/*) and links them there by the absolute path of the folder it was built
     in, which is why the workflow builds in `/srv/work-os/releases/<commit>`;
   - `REVISION` is the commit being deployed, `BUILD_ARCH` this machine's (`aarch64`), `BUILD_NODE` this machine's
     Node major version;
   - the build gets **fresh secrets** (next section);
   - **`npm ci --omit=dev --ignore-scripts`**: the runtime packages for this machine, native parts included (Next's
     SWC, which loads `next.config.ts`; sharp's prebuilt binary comes as an optional package, its install script only
     checks for it). No package's install script runs. It runs at low priority in its own memory cgroup
     (`BUILD_MEMORY_MAX`, default 1200M), so it cannot push the other apps out.

   Then root **seals** the release: it stops anything `workos-build` still runs, refuses hard links, gives the whole
   tree to root (`chown -R -P -h`: links themselves, never followed), removes group/other write and set-id bits, and
   refuses a `.next` that is a link. Only then does root make the app's cache (`.next/cache`, `workos`, 0700) and
   write `.prepared` (the commit). `/srv/work-os/releases` is root's, so the build user cannot swap a release folder
   for a link. A folder whose `.prepared` is missing, not root's, names another commit, or whose tree has anything
   not root's or writable by others (outside the cache), is wiped and started over by the next deploy.
   `workos-build` runs nothing but these deploy steps (the deploy stops its processes).
3. If the build for that commit is not there yet (the run takes about 5 minutes after a push) or failed, the deploy
   says `NO BUILD for <commit>` and changes nothing. Wait for the run, or look at it in the repo's Actions tab. A
   commit that is not on `master` has no build the box accepts: merge first.

**`gh` on the box** (for the attestation check; it never logs in):

```bash
# GitHub CLI's apt repository (has arm64): https://github.com/cli/cli/blob/trunk/docs/install_linux.md
sudo mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update && sudo apt-get install -y gh
```

Instead of `gh`, `cosign verify-blob` checks the same bundle (`--bundle work-os-<commit>.tar.gz.sigstore.json
--certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity
https://github.com/<GITHUB_REPO>/.github/workflows/server-build.yml@refs/heads/master`, plus the commit in
`--certificate-github-workflow-sha`); `deploy.sh` uses `gh`, so that would be a change to it.

**Another arm64 machine** (a Graviton dev box, an Apple Silicon Mac in an `arm64` Linux container, a Raspberry Pi 5
with 8 GB): the same steps as the build job. The release folder path must be the same as on the server (the links
above), Node the same major version, and the OS Linux on arm64 (`uname -m` = `aarch64`):

```bash
SHA=$(git rev-parse HEAD); REL=/srv/work-os/releases/${SHA:0:12}
sudo mkdir -p $REL && sudo chown $USER $REL && git archive $SHA | tar -x -C $REL && cd $REL
npm ci && NEXT_TELEMETRY_DISABLED=1 npm run build
echo $SHA > REVISION && uname -m > BUILD_ARCH && node -v > BUILD_NODE
tar -czf ~/work-os-${SHA:0:12}.tar.gz --exclude=.next/cache .next REVISION BUILD_ARCH BUILD_NODE
# copy it to the server, then: sudo work-os-deploy $SHA --artifact ~/work-os-${SHA:0:12}.tar.gz
```

Such a build has no attestation: `--artifact` copies the file into root's folder (mode 0600) and checks that copy
like a download, except the attestation (it says it is trusting you). If a `.sigstore.json` lies beside the file (a
build downloaded by hand), that is verified as above.

The dev PC (Windows, x64) cannot make this build: the deploy refuses a build whose `BUILD_ARCH` is not the
machine's, because a build made on another platform is not checked to run here. (Emulating arm64 with Docker
`--platform linux/arm64` works but takes far longer; use the workflow.)

**`--build-here`** (last resort, e.g. GitHub down): `npm ci` and `npm run build` on the box, with `NEXT_BUILD_CPUS=1`,
a 1.5 GB heap, low priority and its own memory cgroup (1200M plus up to 2G of swap). On this box that means pushing
the other apps into swap for many minutes: ask Om first. Slow; do it at a quiet hour. If it runs out of memory only the build stops; the app keeps serving the
old release. A build made on the box keeps its own secrets (they were never published).

### The build's secrets

A Next build writes secrets into `.next`, and the published tarball shows them to anyone:
- `prerender-manifest.json` → `preview`: `previewModeId`, `previewModeSigningKey`, `previewModeEncryptionKey`. The id
  is also what the `x-prerender-revalidate` header and the `__prerender_bypass` (draft mode) cookie must carry: with
  the published id, anyone could force static routes to re-render or bypass their cache. `next start` reads these
  from the file and no environment variable replaces them, so **`deploy.sh` gives every downloaded build fresh random
  ones** (`deploy/fresh-build-secrets.mjs`, installed as `/usr/local/sbin/work-os-fresh-secrets.mjs`, run as the
  build user before anything serves the release). It stops the deploy if Next's format changed or an old value is
  still anywhere in `.next`.
- `server/server-reference-manifest.{json,js}` → `encryptionKey`: encrypts the arguments bound into server actions.
  Next 16 uses **`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** from the environment before the manifest's
  (`next/dist/server/app-render/encryption-utils.js`, `getActionEncryptionKey`), so it is set in `/etc/work-os/env`
  (section 9) and stays the same across deploys. The script also replaces the manifest's copy, so the published key
  is good for nothing even if the variable were missing.

Checked 2026-10-23 on Next 16.2.4 (a release made the box's way): before, the published id made `/manifest.webmanifest`
and `/icons/192` answer `x-nextjs-cache: REVALIDATED` (header) and `cache-control: private, no-store` (cookie); after
the script, the published id is treated like any random string and only the fresh one works. The e2e runner sets
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, so every suite's server actions run with the key from the environment.
After a Next upgrade, check that both are still where the script looks (it stops the deploy if not).

### Switching

While the new release is prepared the old one keeps serving. Then `current` moves to it, the app restarts, and the
script waits up to a minute for `/api/live` and `/login` to answer 200 on 127.0.0.1:`WORK_OS_PORT`. If they don't,
it switches back to the old release (still on disk, so at once), restarts it, removes the failed one and says so. If
the old release does not come up either, it prints `FAILED: the app is DOWN`.

**One release on disk** (Om, 2026-10-23; the disk is short). Both exist only while a deploy runs. Once the new release
answers, the script writes the old one's commit to `/srv/work-os/previous-commit` (root's) and deletes the old
folder. It refuses to start with under 1.5 GB free under `/srv` (`MIN_FREE_MB`): a release (repo, `.next`, runtime
`node_modules`, a few hundred MB), the download and the old release side by side need that. It also refuses a Node under `/opt/work-os/node` that is not 22.x, and a
`MONGODB_URI` (or a `MONGO_*_URI` / `MONGO_*_URL` the app would read) that is not an Atlas address,
`mongodb+srv://….mongodb.net` (Work OS uses Atlas only). That is a guard against a slip, not a guarantee: it reads
`/etc/work-os/env` by name, and `ALLOW_NON_ATLAS=1` in `/etc/work-os/deploy.conf` turns it off. One deploy at a time (a lock). The app never reads `/etc/work-os/env` at build time.

Pushing to `master` builds (Actions) but does not deploy: deploys are this command.

**What depends on the Next version** (check after a Next upgrade, e.g. 16.2 to 16.4):
- `work-os.service` starts `node_modules/next/dist/bin/next start -H … -p …`: the path and flags of `next start`.
- `deploy.sh` and the workflow use `.next/BUILD_ID` as "this is a finished build" and leave out `.next/cache`.
- A build runs only with the `node_modules` of the same commit: the tarball and the box's `npm ci --omit=dev` both
  come from that commit's `package-lock.json`, so a Next upgrade needs nothing else. Nothing in the kit pins a Next
  version.
- Next loads `next.config.ts` at `next start` with its SWC binary (or Node's own type stripping), not the
  `typescript` package (tested on 16.2.4 with `typescript` removed; `--omit=dev` still installs it today, as a peer of
  shadcn). Test again after an upgrade: start the app from a release made with `--omit=dev` ("Tested so far" above).
- The links in `.next/node_modules` to external packages (above) are how Next 16.2's Turbopack build does it; if an
  upgrade changes that, the link check in `deploy.sh` says so and the deploy stops before switching.
- Where a build keeps its secrets (`prerender-manifest.json` `preview`, `server-reference-manifest` `encryptionKey`)
  and that `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` wins over the manifest ("The build's secrets" above); the script
  stops the deploy if the format changed.
- The engines field (`node: 22.x`) and `BUILD_NODE`: a Next that needs a newer Node needs Work OS's own Node
  (`/opt/work-os/node`, section 2) first, and the workflow's `node-version`.

**Health:** `GET /api/live` answers `ok` and nothing else, without a session (nginx, systemd and the deploy script
use it; `proxy.ts` does not count it). `GET /api/admin/health` is the full report, for the operator only
(`OPERATOR_EMAILS`): 401 without a session or key, 403 for anyone else.

## 8. Rollback

- **Code:** `sudo work-os-deploy --rollback` deploys the commit in `/srv/work-os/previous-commit` (the one live before
  the current one) exactly like a deploy: its build is **downloaded again** from the `builds` release and checked
  (SHA-256, attestation, contents), `npm ci --omit=dev`, switch, health check. It takes **2 to 3 minutes and needs
  GitHub reachable**; the current release keeps serving until the switch, and if the old one does not come up the
  script goes back to the current one at once. `sudo work-os-deploy --rollback <commit>` (or plain
  `sudo work-os-deploy <commit>`) does the same for any master commit whose build is still published (the newest 20
  builds are kept). A rollback is a deploy, so afterwards `--rollback` points at the release you left. GitHub down and
  the release broken: `--artifact` with a build from elsewhere, or, last resort, `--build-here` (section 7). A
  release that fails its health check during a deploy needs none of this: the old one is still on disk and the
  switch back is instant.
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
| `TRUST_PROXY` | `1`: trust Caddy's (or nginx's) `X-Real-IP` / `X-Forwarded-For` for per-IP sign-in limits | |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | encrypts server actions' bound arguments; Next reads it at runtime, before the (public) key in a published build. 32 random bytes, base64, made once (section 7 "The build's secrets") | **yes** |
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
| `WORK_OS_PORT` | the app's port on 127.0.0.1 (default 3100; set it only if another app has 3100, and the Caddy site's ports to match). Leave the line out for 3100: an empty value overrides the unit's default | |
| `MCP_ALLOW_URL_TOKEN` | `1` allows `/api/mcp/<key>`; leave unset | |
| `USAGE_LOG` | `off` stops the request log (Settings › Usage); leave unset | |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_S3_URI` | `work-os-backup` (`deploy/backup.sh`) | |
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

Atlas still holds single-user data from before phase 1. `work-os-cutover` (`scripts/cutover.sh`, installed root-owned
in section 4) moves it, in the order from WORK-STATE. Root only stops and starts the app and edits the env file; the
backup and every node step run as `workos`, from the live release (`/srv/work-os/current`, so deploy first).

| Step | What | Script |
|---|---|---|
| 0 | variables present (names only printed). With `--apply`, whatever `--from` says: `mongodump` first, and the app stopped (`--service`) until step 5 or the end | `work-os-backup --local-only` |
| 1 | an account for every `OPERATOR_EMAILS` address, first: an invitation to an operator address that has no account would make whoever accepts it the operator | `scripts/create-operators.mjs` |
| 2 | Om as the first user, organization Delpat, Om owner; old computers revoked | `scripts/migrate-auth.mjs` |
| 3 | `orgId`/owner/visibility on everything: first `--copy-to <db>_cutover_<time>` (a rehearsal on a copy, run twice to prove there is nothing left), then `--apply` | `scripts/migrate-ownership.mjs` |
| 4 | schedule, modes, timezone, Discord ids as data | `scripts/migrate-phase3.mjs` |
| 5 | the app is started; Discord commands registered again (they gain `/link`) through the app's own route, with a temporary operator key deleted right after | `scripts/discord-register.mjs` |
| 6 | `DISCORD_GUILD_ID` and `DISCORD_OWNER_ID` removed from `/etc/work-os/env` (a dated copy is kept beside it; delete it once all is well) | |

It is a dry run unless `--apply`, stops at the first error, and every step is idempotent (`--from N` to resume).

```bash
sudo work-os-cutover --db workos --env-file /etc/work-os/env                           # dry run: read it
sudo work-os-cutover --db workos --env-file /etc/work-os/env --apply --service work-os  # do it
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

**Off on the shared box** (decided 2026-10-23, until Om decides on backups): the unit and timer are installed but
`work-os-backup.timer` is **not enabled**, so nothing writes dumps to the box's short disk. Atlas's own backups are
what there is meanwhile. When backups are decided, install the Database Tools (section 2), make
`/var/backups/work-os` (`sudo install -d -o workos -g workos -m 0700 /var/backups/work-os`), check the disk, and
`sudo systemctl enable --now work-os-backup.timer`.

What it does once enabled: `work-os-backup.timer` runs `work-os-backup` (`deploy/backup.sh`) as `workos` at 03:00 IST:
- `mongodump` of `MONGODB_DB` to `/var/backups/work-os/workos-<UTC time>.archive.gz`. The connection string goes to
  mongodump in a 0600 temporary file, never on the command line.
- Then `aws s3 cp` to `BACKUP_S3_URI` with server-side encryption, using the instance role (put only: the server
  cannot read, list or delete what it uploaded).
- On disk it keeps `BACKUP_KEEP_DAYS` (14) days. S3 keeps what its **lifecycle rule** says: set one on the bucket
  prefix, e.g. expire after 35 days. The script never deletes from S3.

The dumps hold password hashes, encrypted authenticator secrets and everyone's tasks: the bucket must be private,
with versioning optional and public access blocked.

Run one by hand: `sudo systemctl start work-os-backup && journalctl -u work-os-backup -n 20`.

**Restore drill** (once after setup, then every few months; never onto `workos` itself unless restoring for real):

```bash
# 1. The dump. The instance role cannot read S3: use a dump still on disk (/var/backups/work-os), or fetch one with
#    restore credentials for this session only (an admin's keys or a restore role), never saved on the box.
#    (A line starting with a space stays out of shell history: HISTCONTROL=ignorespace, Ubuntu's default.)
 AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=… \
   aws s3 cp s3://<bucket>/work-os/workos-<time>.archive.gz /tmp/drill.archive.gz

# 2. Restore into a scratch database, renaming the namespace. The connection string goes in a 0600 file, not argv.
# 3. Check: the same counts as the live database (the URI reaches node through the environment).
sudo bash <<'DRILL'
. /usr/local/sbin/work-os-env.sh && load_env /etc/work-os/env
umask 077; CFG=$(mktemp); trap 'rm -f "$CFG"' EXIT
printf 'uri: "%s"\n' "$MONGODB_URI" >"$CFG"
mongorestore --config="$CFG" --archive=/tmp/drill.archive.gz --gzip \
  --nsFrom 'workos.*' --nsTo 'workos_restore.*' --drop
cd /srv/work-os/current && runuser -u workos -- /opt/work-os/node/bin/node -e '
  const { MongoClient } = require("mongodb");
  const c = new MongoClient(process.env.MONGODB_URI);
  (async () => {
    for (const d of ["workos", "workos_restore"]) {
      const db = c.db(d);
      console.log(d, "tasks", await db.collection("tasks").countDocuments(), "users", await db.collection("user").countDocuments());
    }
    await c.close();
  })();'
DRILL

# 4. Drop workos_restore in Atlas (Data Explorer → workos_restore → Drop Database); delete /tmp/drill.archive.gz.
```

A real restore is the same without `--nsFrom`/`--nsTo` (so into `workos`), with the app stopped first.

## 12. Push

Pages and workers hold one long-lived HTTP response each: Server-Sent Events, not WebSockets (docs/multi-user.md
"As built: phase 5 push"). So there is **no custom server and no `Upgrade` to forward** (the site's upgrade map is not needed for push): `next start` serves the two
streams from ordinary route handlers.

| Stream | Path | Who |
|---|---|---|
| Pages | `GET /api/stream` | session cookie (the proxy checks it like any page) |
| Workers | `GET /api/worker/stream` | `Authorization: Bearer wkr_…` |

**With Caddy** (the box's server, `deploy/caddy/work-os.caddy`) this is all in the site: `flush_interval -1`
(every event goes out at once), no `encode` (no compression by Caddy), no read timeout on the upstream by default
(the streams last 30 minutes), HTTP/1.1 keep-alive to the app, HTTP/2 to browsers by default, and no connection
limit to raise. What Caddy does not have is nginx's per-address limit on streams (below): the app's own caps (10 per
person, 2 per computer) are what limits them. Tested with Caddy 2.11.7 ("Tested so far").

**With nginx** (the alternative), what it must do for those two paths:

- **No buffering.** The responses send `X-Accel-Buffering: no`, which nginx honours by itself; setting
  `proxy_buffering off;` on the two locations as well does no harm. Without it, events sit in nginx's buffer and
  arrive minutes late.
- **Long read timeout.** A stream stays open up to 30 minutes; the server sends a comment line every 25 s.
  `proxy_read_timeout` must be above 25 s (nginx default 60 s is enough; 120 s gives room). `proxy_send_timeout` the
  same.
- **HTTP/1.1 to the app, keep-alive.** `proxy_http_version 1.1;` and `proxy_set_header Connection "";` (no
  `Connection: close` to the upstream).
- **No gzip of the stream in nginx.** `text/event-stream` should not be in `gzip_types` (Next compresses and flushes
  per event itself).
- **HTTP/2 to browsers** (`listen 443 ssl http2;` or `http2 on;`). Over HTTP/1.1 a browser allows about 6 connections
  per site, and every open Work OS tab holds one stream (a tab out of view drops it after a minute). With HTTP/2 they
  share one connection.
- **One app instance** (deploy/systemd/work-os.service runs one `next start`; no cluster mode). The hub that routes hints to streams lives in the
  process; a second instance would not hear the first one's writes (and the in-memory role, member and rate caches
  have the same limit).
- Forward the usual `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` as for every route.

- **Connection limits.** Every open stream holds two connections in nginx (browser and app) for up to 30 minutes.
  Debian's default `worker_connections 768` runs out at a few hundred streams. Set it explicitly in
  `/etc/nginx/nginx.conf` and raise nginx's file limit to match:

  ```nginx
  worker_rlimit_nofile 16384;          # top level
  events { worker_connections 4096; }  # per worker process
  ```

  ```bash
  sudo systemctl edit nginx            # add the two lines below, save
  #   [Service]
  #   LimitNOFILE=16384
  sudo nginx -t && sudo systemctl restart nginx
  ```

  The app's unit (`deploy/systemd/work-os.service`) already sets `LimitNOFILE=16384`.
- **Per-address limits.** The stream block allows 20 open streams per address (`limit_conn`) and 30 new ones a
  minute with a burst of 20 (`limit_req`); past that nginx answers 429 and the client retries with backoff. Raise
  the 20 if a whole office reaches the site from one address. The app caps them as well: 10 page streams per person
  and 2 worker streams per computer; a new one past that closes the oldest (`bye` `limit`). A tab whose stream was
  closed that way falls back to its slow poll until it comes back into view.

The block is in `deploy/nginx/work-os.conf` (`location ~ ^/api/(stream|worker/stream)$`). The site's `location /`
already has buffering off and a 300 s timeout, so the streams would work without it; the block makes it explicit and
turns gzip off. `/api/live` stays the plain liveness route (no session, outside the proxy). The streams are not
under it: they go through the proxy's session check like every other API route, and each route checks the session
or device key again itself.

Check after the deploy: `curl -N -H "Authorization: Bearer <wkr_ key>" https://work.delpat.in/api/worker/stream`
prints `event: hello` at once and `: ping` every 25 s. `/api/admin/health` (operator) shows `push: { pages, workers }`,
the streams open now.

Restarting the app drops every stream; pages and workers reconnect within seconds (backoff starts at 1 s), and a page
refreshes once after the gap.

