// ============================================================================
// Script REST routes — list scripts, start / stop / inspect a script run
// scoped to a room.
//
// All routes delegate to system.scriptStore (catalog) or system.scriptEngine
// (lifecycle). Run state is read from system.scriptRegistry.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
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
          cast: s.cast.map(c => ({ name: c.name, kind: c.kind })),
          scenes: s.scenes.length,
          acts: Object.keys(s.acts),
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/scripts\/reload$/,
    handler: async (_req, _match, { system }) => {
      const names = await system.scriptStore.reload()
      return json({ loaded: names.length, names })
    },
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
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/script$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const run = system.scriptRegistry.get(room.profile.id)
      if (!run) return json({ active: false })
      const scene = run.script.scenes[run.sceneIndex]!
      return json({
        active: true,
        scriptId: run.script.id,
        scriptName: run.script.name,
        sceneIndex: run.sceneIndex,
        totalScenes: run.script.scenes.length,
        turn: run.turn,
        statuses: run.statuses,
        present: scene.present,
        setup: scene.setup,
        beats: run.beats.slice(-20),
        ended: run.ended ?? false,
        lastOutcome: run.lastOutcome,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/script\/start$/,
    handler: async (req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.scriptName !== 'string') return errorResponse('scriptName is required')
      const result = await system.scriptEngine.start(room.profile.id, body.scriptName)
      if (!result.ok) return errorResponse(result.reason ?? 'failed to start script', 400)
      return json({ started: true })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/script\/stop$/,
    handler: async (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const result = await system.scriptEngine.stop(room.profile.id)
      if (!result.ok) return errorResponse(result.reason ?? 'failed to stop script', 400)
      return json({ stopped: true })
    },
  },
]
