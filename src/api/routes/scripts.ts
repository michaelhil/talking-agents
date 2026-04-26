// ============================================================================
// Script REST routes (v2).
//
// GET    /api/scripts                          → catalog
// GET    /api/scripts/:name                    → full script
// POST   /api/scripts                          → upsert (creates or overwrites)
// DELETE /api/scripts/:name                    → delete file
// POST   /api/scripts/reload                   → rescan
//
// GET    /api/rooms/:name/script               → current run state
// POST   /api/rooms/:name/script/start         → { scriptName }
// POST   /api/rooms/:name/script/stop
// POST   /api/rooms/:name/script/advance       → operator force-advance
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const scriptRoutes: ReadonlyArray<RouteEntry> = [
  // --- Catalog ---
  {
    method: 'GET',
    pattern: /^\/api\/scripts$/,
    handler: (_req, _match, { system }) =>
      json({
        scripts: system.scriptStore.list().map(s => ({
          id: s.id,
          name: s.name,
          title: s.title,
          prompt: s.prompt,
          cast: s.cast.map(c => ({ name: c.name, model: c.model, starts: !!c.starts })),
          steps: s.steps.length,
        })),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/scripts\/reload$/,
    handler: async (_req, _match, { system, broadcast }) => {
      const names = await system.scriptStore.reload()
      broadcast({ type: 'script_catalog_changed' })
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
    method: 'POST',
    pattern: /^\/api\/scripts$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req)
      try {
        const script = await system.scriptStore.upsert(body)
        broadcast({ type: 'script_catalog_changed' })
        return json({ ok: true, script })
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'invalid script', 400)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/scripts\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1]!)
      const removed = await system.scriptStore.remove(name)
      if (!removed) return errorResponse(`Script "${name}" not found`, 404)
      broadcast({ type: 'script_catalog_changed' })
      return json({ removed: true })
    },
  },

  // --- Per-room run lifecycle ---
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/script$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const run = system.scriptRunner.getRun(room.profile.id)
      if (!run) return json({ active: false })
      return json({
        active: true,
        scriptId: run.script.id,
        scriptName: run.script.name,
        title: run.script.title,
        currentStep: run.currentStep,
        totalSteps: run.script.steps.length,
        stepTitle: run.script.steps[run.currentStep]?.title,
        turn: run.turn,
        readiness: run.readiness,
        roleOverrides: run.roleOverrides,
        lastWhisper: run.lastWhisper,
        whisperFailures: run.whisperFailures,
        ended: run.ended,
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
      const result = await system.scriptRunner.start(room.profile.id, body.scriptName)
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
      const result = await system.scriptRunner.stop(room.profile.id)
      if (!result.ok) return errorResponse(result.reason ?? 'failed to stop script', 400)
      return json({ stopped: true })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/script\/advance$/,
    handler: async (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const result = await system.scriptRunner.forceAdvance(room.profile.id)
      if (!result.ok) return errorResponse(result.reason ?? 'failed to advance', 400)
      return json({ advanced: true })
    },
  },
]
