// Script REST routes — rebuilt in Phase F.
// Currently only the catalog read endpoints survive; create/start/stop come back
// once the runner is wired.

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const scriptRoutes: ReadonlyArray<RouteEntry> = [
  {
    method: 'GET',
    pattern: /^\/api\/scripts$/,
    handler: (_req, _match, { system }) =>
      json({
        scripts: system.scriptStore.list().map(s => ({
          id: s.id,
          name: s.name,
          title: s.title,
          cast: s.cast.map(c => ({ name: c.name })),
          steps: s.steps.length,
        })),
      }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/scripts\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const script = system.scriptStore.get(name)
      if (!script) return errorResponse(`Script "${name}" not found`, 404)
      return json(script)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scripts\/reload$/,
    handler: async (_req, _match, { system }) => {
      const names = await system.scriptStore.reload()
      return json({ loaded: names.length, names })
    },
  },
]
