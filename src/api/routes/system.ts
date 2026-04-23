// ============================================================================
// System-level admin routes — currently just shutdown.
//
// POST /api/system/shutdown triggers a graceful shutdown so a supervisor
// (bun --watch, docker, systemd) can respawn with fresh env + providers.json.
// Samsinn doesn't self-respawn; the user's orchestrator is responsible.
// ============================================================================

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { json } from './helpers.ts'
import type { RouteEntry } from './types.ts'

// Cached on first read. package.json doesn't change at runtime.
let cachedInfo: { version: string; repoUrl: string } | null = null

const normalizeRepoUrl = (raw: unknown): string => {
  if (typeof raw === 'string') return raw.replace(/^git\+/, '').replace(/\.git$/, '')
  if (raw && typeof raw === 'object' && 'url' in raw) {
    return normalizeRepoUrl((raw as { url: string }).url)
  }
  return ''
}

const readPackageInfo = async (): Promise<{ version: string; repoUrl: string }> => {
  if (cachedInfo) return cachedInfo
  try {
    const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string; repository?: unknown }
    cachedInfo = {
      version: pkg.version ?? '0.0.0',
      repoUrl: normalizeRepoUrl(pkg.repository),
    }
  } catch {
    cachedInfo = { version: '0.0.0', repoUrl: '' }
  }
  return cachedInfo
}

export const systemRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/system\/info$/,
    handler: async () => json(await readPackageInfo()),
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/shutdown$/,
    handler: async (_req, _match, _ctx) => {
      // Schedule exit on the next tick so the response is flushed first.
      // SIGTERM triggers the drain/snapshot-save shutdown handler in
      // bootstrap.ts, reusing the existing graceful path.
      setTimeout(() => {
        try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
      }, 100)
      return json({ shuttingDown: true, pid: process.pid })
    },
  },
]
