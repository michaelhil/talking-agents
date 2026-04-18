// ============================================================================
// System-level admin routes — currently just shutdown.
//
// POST /api/system/shutdown triggers a graceful shutdown so a supervisor
// (bun --watch, docker, systemd) can respawn with fresh env + providers.json.
// Samsinn doesn't self-respawn; the user's orchestrator is responsible.
// ============================================================================

import { json } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

export const systemRoutes: RouteEntry[] = [
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
