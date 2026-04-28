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
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ "$(systemctl is-active samsinn)" = "active" ]; then break; fi
    sleep 1
  done
  systemctl is-active samsinn
`))

if (!SKIP_SMOKE) {
  await run('Smoke test (broadcast wiring)', remote(`set -a; source /etc/samsinn/env; set +a
    cd /opt/samsinn
    /home/samsinn/.bun/bin/bun run scripts/smoke-streaming.ts
  `))
}

console.log('\n✓ Deploy complete')
