#!/usr/bin/env bun
// ============================================================================
// Manual deploy fallback — same steps as .github/workflows/deploy.yml but
// triggered from your laptop using your normal SSH key (whatever already
// works for `ssh root@<host>`).
//
// Use this when:
//   - GitHub Actions is down or queued
//   - you want immediate terminal feedback
//   - you're deploying a non-master branch (CI auto-deploy is master-only)
//
// Usage:
//   bun run scripts/deploy.ts                         # uses default host
//   bun run scripts/deploy.ts --host 178.104.229.113  # override
//   bun run scripts/deploy.ts --no-smoke              # skip smoke check
//
// Reads SAMSINN_TOKEN from the box's /etc/samsinn/env for the smoke step,
// so no token plumbing on your laptop. The SSH key is whichever your
// `~/.ssh/config` resolves for the target host (i.e. nothing samsinn-
// specific — same key you use to SSH manually).
// ============================================================================

import { spawn } from 'bun'

const args = process.argv.slice(2)
const hostIdx = args.indexOf('--host')
const HOST = hostIdx >= 0 ? args[hostIdx + 1]! : '178.104.229.113'
const SKIP_SMOKE = args.includes('--no-smoke')

const run = async (label: string, cmd: string[]): Promise<void> => {
  console.log(`\n→ ${label}`)
  const proc = spawn(cmd, { stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    console.error(`✗ ${label} failed (exit ${code})`)
    process.exit(code)
  }
}

const remote = (script: string): string[] => ['ssh', `root@${HOST}`, script]

await run('Pull + restart on box', remote(`set -e
  cd /opt/samsinn
  sudo -u samsinn git pull --ff-only
  systemctl restart samsinn
  # systemctl is-active flips green the moment bun forks; HTTP listener
  # is not up until pack/skill init finishes (~5 s). Poll the readiness
  # probe so the smoke step does not race with startup.
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:3000/api/system/info; then
      echo "samsinn HTTP up after \${i}s"
      exit 0
    fi
    sleep 1
  done
  echo "samsinn HTTP did not come up within 30s" >&2
  systemctl status samsinn --no-pager
  exit 1
`))

if (!SKIP_SMOKE) {
  await run('Smoke test (broadcast wiring)', remote(`set -a; source /etc/samsinn/env; set +a
    cd /opt/samsinn
    /home/samsinn/.bun/bin/bun run scripts/smoke-streaming.ts
  `))
}

console.log('\n✓ Deploy complete')
