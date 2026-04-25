# Deploying Samsinn as a sandbox

Operator runbook for putting Samsinn behind TLS on a Hetzner (or any
Linux) box. Target: ~10 minutes from a fresh VPS to a working URL.

## Prerequisites

- A Linux box with a public IP and ports 80/443 open.
- A DNS A record pointing at the box (e.g. `samsinn.example.com`).
- Root or sudo access.

## Steps

### 1. Install dependencies

```bash
# Bun (matches .bun-version)
curl -fsSL https://bun.sh/install | bash

# Caddy (TLS reverse proxy)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 2. Create the samsinn user + clone the repo

```bash
sudo useradd -m -s /bin/bash samsinn
sudo -u samsinn bash -lc '
  curl -fsSL https://bun.sh/install | bash
  cd ~ && git clone https://github.com/michaelhil/samsinn.git talkingAgents
  cd talkingAgents && bun install && bun run build:css
'
```

### 3. Configure the environment

```bash
sudo mkdir -p /etc/samsinn
sudo cp /home/samsinn/talkingAgents/deploy/env.example /etc/samsinn/env
sudo chmod 600 /etc/samsinn/env
sudo chown root:root /etc/samsinn/env

# Generate a token
TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
sudo sed -i "s|^SAMSINN_TOKEN=replace-me|SAMSINN_TOKEN=$TOKEN|" /etc/samsinn/env

# Edit /etc/samsinn/env to add provider keys, OLLAMA_URL, etc.
sudo $EDITOR /etc/samsinn/env

# Show the token so you can hand it out:
sudo grep ^SAMSINN_TOKEN /etc/samsinn/env
```

### 4. Install systemd unit + Caddy config

```bash
sudo cp /home/samsinn/talkingAgents/deploy/samsinn.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now samsinn

# Edit Caddyfile: replace samsinn.example.com with your real hostname
sudo cp /home/samsinn/talkingAgents/deploy/Caddyfile /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 5. Verify

```bash
sudo journalctl -u samsinn -f         # server logs
sudo journalctl -u caddy -f           # TLS provisioning
curl -I https://samsinn.example.com/  # HSTS, CSP headers visible
```

Open `https://samsinn.example.com` in a browser. Token prompt appears →
enter token → main UI loads.

## Resetting the sandbox

Click the `↺ reset` button in the sidebar footer (next to the version
badge). Confirm in the modal. A 10-second countdown banner appears for
all connected clients; any user can cancel during the window.

After commit:
- `data/snapshot.json` deleted.
- `~/.samsinn/{memory,packs,skills,tools}` recursively deleted.
- Server exits, systemd respawns within ~5 s.
- Browsers reconnect to a fresh `general` room with no agents.

Server-side: 1 reset / 5 minutes. Concurrent reset attempts return 409.

## Hardening flags

The sandbox ships with these env vars **unset** by default — leave them
that way unless you control the user list:

| Variable | Effect when set to `1` |
|---|---|
| `SAMSINN_ENABLE_CODEGEN` | Enables `write_skill`, `write_tool`, `install_pack`, etc. — agents can drop arbitrary TS into `~/.samsinn/` and have it imported. |
| `SAMSINN_ENABLE_NETWORK_TOOLS` | Enables `web_fetch`, `web_extract_json`, `web_search` — agents can hit any URL the host can reach (including cloud-metadata 169.254.169.254). |

If you flip these on, your sandbox is no longer a sandbox.

## Updating

```bash
sudo -u samsinn bash -lc 'cd ~/talkingAgents && git pull && bun install && bun run build:css'
sudo systemctl restart samsinn
```

## Troubleshooting

- **Token rejected after restart** — sessions are in-memory; restart
  invalidates all cookies. Users see the prompt again, enter the same
  token, get a new cookie. Expected.
- **`bun: command not found` in systemd** — adjust `ExecStart` in the
  unit file to your actual bun path (`which bun` as the samsinn user).
- **Caddy fails TLS provisioning** — DNS not propagated, or port 80/443
  blocked. Check `journalctl -u caddy -f`.
- **CSS shows a red banner "CSS build missing"** — run
  `cd ~/talkingAgents && bun run build:css` as the samsinn user.
