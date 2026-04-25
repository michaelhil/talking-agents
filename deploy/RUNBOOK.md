# Samsinn — Hetzner Deployment Runbook

Operator's manual for a single-host Hetzner deploy: Bun under systemd,
Caddy in front for TLS + WS proxy. Targets one box (CAX11, ARM64, ~€4/mo)
running both samsinn and Caddy on the same host.

This runbook does **not** cover Kubernetes, Docker Compose, or multi-host
deploys. The Dockerfile in this repo is a tertiary artifact for users who
prefer containers.

---

## 1. Sizing & host choice

**Recommended:** Hetzner **CAX11** — Ampere ARM64, 2 vCPU, 4 GB RAM,
~€4/mo. Confirmed compatible:

- Bun has stable `linux/arm64` builds.
- `@tailwindcss/oxide-linux-arm64-{gnu,musl}` is published.
- No other native deps in `package.json`.

**Upgrade path:** CAX21 (4 vCPU / 8 GB / ~€7/mo) once you exceed ~30
active instances or memory pressure shows in `journalctl`.

x86 alternative: CX22 (~€6/mo). Same instructions otherwise.

Ollama is **not** expected to run on this box. Cloud providers (Anthropic,
Gemini, Groq, etc.) are configured via providers.json. If you do want
local Ollama, choose a CCX or larger.

---

## 2. Provision the box

In the Hetzner Cloud Console:

1. Create a CAX11 server, Ubuntu 24.04 LTS, ARM64.
2. Add your SSH key.
3. Note the public IPv4. Register a domain or set DNS A-record to that IP.
4. Open ports: 22 (SSH), 80 + 443 (HTTP/HTTPS). Hetzner default firewall
   rules cover this; tighten SSH to your IP if you like.

---

## 3. Bootstrap

SSH in as root, then:

```bash
# Create the service user with home at /var/lib/samsinn (= SAMSINN_HOME).
useradd --system --create-home --home-dir /var/lib/samsinn --shell /bin/bash samsinn
mkdir -p /opt/samsinn
chown samsinn:samsinn /opt/samsinn /var/lib/samsinn
chmod 0750 /var/lib/samsinn

# Install Bun for the samsinn user.
sudo -u samsinn bash -lc 'curl -fsSL https://bun.sh/install | bash'

# Verify path used in samsinn.service:
ls -l /home/samsinn/.bun/bin/bun
```

Note: `useradd --create-home --home-dir /var/lib/samsinn` puts Bun's
default install at `/var/lib/samsinn/.bun/bin/bun`. The shipped systemd
unit references `/home/samsinn/.bun/bin/bun` for back-compat with older
homedir layouts. Either:

- **(A)** keep the old layout: `useradd -m samsinn` (homedir =
  `/home/samsinn`) and override `SAMSINN_HOME=/home/samsinn/.samsinn` in
  `/etc/samsinn/env`; or
- **(B)** use the new layout above and update `ExecStart` in
  `/etc/systemd/system/samsinn.service` to `/var/lib/samsinn/.bun/bin/bun`.

Pick one and stick with it.

---

## 4. Clone, install, build

```bash
sudo -u samsinn git clone https://github.com/michaelhil/samsinn /opt/samsinn
cd /opt/samsinn
sudo -u samsinn bash -lc 'bun install --frozen-lockfile'
sudo -u samsinn bash -lc 'bun run build:css'
sudo -u samsinn bash -lc 'bun run check'
```

---

## 5. Configure secrets and env

Create `/etc/samsinn/env` (mode 0600, owned by root):

```bash
mkdir -p /etc/samsinn
cat > /etc/samsinn/env <<'EOF'
# Auth — required in deploy mode. Generate with `openssl rand -base64 32`.
SAMSINN_AUTH_TOKEN=PASTE-GENERATED-TOKEN-HERE

# SAMSINN_HOME and SAMSINN_SECURE_COOKIES are set by the systemd unit;
# override here only if you keep the old layout (option A above).
# SAMSINN_HOME=/home/samsinn/.samsinn

# Provider API keys can be managed in-UI later; if you want them in env:
# ANTHROPIC_API_KEY=...
# OPENROUTER_API_KEY=...
EOF
chmod 0600 /etc/samsinn/env
```

Optional tunables (defaults shown):

```
SAMSINN_LOG_MAX_BYTES=52428800        # 50 MB per active log file
SAMSINN_CREATE_RATE_LIMIT=5           # creates per IP per window
SAMSINN_CREATE_RATE_WINDOW_MS=60000   # window size
SAMSINN_IDLE_MS=1800000               # 30 min — evict idle instances
SAMSINN_TRASH_TTL_MS=604800000        # 7 days — purge trash
```

---

## 6. Install systemd unit

```bash
cp /opt/samsinn/deploy/samsinn.service /etc/systemd/system/samsinn.service
systemctl daemon-reload
systemctl enable --now samsinn
journalctl -u samsinn -f
```

You should see `Server listening on http://localhost:3000` and the
provider warm-up output.

---

## 7. Install Caddy + reverse proxy

```bash
apt install -y caddy
cp /opt/samsinn/deploy/Caddyfile /etc/caddy/Caddyfile

# Edit the hostname:
sed -i 's/samsinn.example.com/yourhost.example.com/' /etc/caddy/Caddyfile

systemctl reload caddy
```

DNS-resolvable hostname + open ports 80/443 = Caddy auto-obtains a
Let's Encrypt cert on first request.

---

## 8. Verification

From your laptop:

```bash
# 1. App responds with the security headers wired in code.
curl -sI https://yourhost.example.com/api/system/info | grep -iE 'x-content-type|x-frame|referrer-policy|strict-transport'

# 2. Create rate limit fires after 5/min.
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://yourhost.example.com/api/instances
done
echo
# Expect: 201 201 201 201 201 429 429 429

# 3. Two-browser isolation check (manual):
#    - Open https://yourhost.example.com in two profiles (or one normal +
#      one private window). Each gets a unique samsinn_instance cookie.
#    - Create an agent in one. Confirm it does NOT show up in the other.
```

---

## 9. Backup

Snapshots are flat JSON files at `/var/lib/samsinn/instances/<id>/snapshot.json`.
**Backup is the operator's responsibility** — there is no built-in cron.

A minimal nightly tarball, off-box (Hetzner Storage Box, S3-compatible,
or another VPS):

```bash
# /etc/cron.daily/samsinn-backup (mode 0755, owned root)
#!/bin/bash
set -euo pipefail
ts=$(date -u +%Y%m%d-%H%M%S)
tar czf /tmp/samsinn-${ts}.tgz -C /var/lib/samsinn instances providers.json
rsync -a /tmp/samsinn-${ts}.tgz user@backup-host:/path/to/backups/
rm /tmp/samsinn-${ts}.tgz
# Optional: keep only the last 14 days on the backup host.
```

For larger deploys, mount `/var/lib/samsinn` on a Hetzner Volume so the
data survives a server reinstall.

---

## 10. Multi-domain caveat

The instance cookie is scoped to the exact hostname (no `Domain=`
attribute). If you serve from `a.example.com` and `b.example.com`, each
gets its own cookie space and a user can't cross between them.

For sharing a specific instance across domains or with a teammate:

```
https://yourhost.example.com/?join=<instance-id>
```

The redirect handler sets the cookie + 303s to a clean URL. SameSite=Lax
makes this safe from email/Slack links.

---

## 11. Day-2 operations

- **Live logs:** `journalctl -u samsinn -f`
- **Restart:** `systemctl restart samsinn` (graceful — drains in-flight
  evals, flushes snapshots)
- **Status:** `systemctl status samsinn` for memory + uptime
- **Reset one tenant's data:** they click _Settings → Instances → Reset_.
  Server-side `/api/system/reset` triggers a 10-second cancellable
  countdown then trashes the instance dir; the cookie is preserved and a
  fresh empty House materializes on next request.
- **Delete idle tenants:** _Settings → Instances → Delete_ (or bulk via
  the header `Delete` button). Removes the dir from disk; same id
  reusable later.
- **Trash purge:** the in-process janitor purges
  `/var/lib/samsinn/instances/.trash/<id>-<ts>` after 7 days
  (`SAMSINN_TRASH_TTL_MS`). For ad-hoc cleanup:
  `rm -rf /var/lib/samsinn/instances/.trash/*`.

---

## 12. Known limitations / deferred items

- No backup automation in code (covered by §9).
- No Prometheus / metrics endpoint.
- Snapshot files don't truncate old agents/rooms — full instance reset is
  the only wipe path.
- Per-instance log usage capped at 2 × `SAMSINN_LOG_MAX_BYTES` (default
  100 MB total per tenant). Beyond that, oldest events are dropped.
- Cookie has no `Domain=` (see §10).
- Headless / MCP-only mode is single-instance; multi-instance only applies
  to HTTP mode.
